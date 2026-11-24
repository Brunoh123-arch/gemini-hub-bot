import { InputFile, InlineKeyboard } from 'grammy';
import { config, isAdmin } from '../config.js';
import {
  escapeHtml,
  formatBRL,
  formatDateBR,
  formatDisplayName,
  formatUserLabel,
  getVipTier,
  parseBRLToCents,
  renderStars,
} from '../services/format.js';
import { generatePixPayload, generatePixQrCodeBuffer } from '../services/pix.js';
import { createMercadoPagoPix, getMercadoPagoPaymentStatus } from '../services/mercadopago.js';
import { createSyncPayPix, getSyncPayTransactionStatus } from '../services/syncpay.js';
import {
  clearStep,
  getActiveDiscountCoupon,
  getSession,
  setActiveDiscountCoupon,
  setStep,
} from './state.js';
import { renderScreen, safeAnswer } from './ui.js';
import {
  cancelStepKeyboard,
  categoriesKeyboard,
  confirmPurchaseKeyboard,
  mainMenuKeyboard,
  orderReviewStarsKeyboard,
  persistentBottomKeyboard,
  pixPaymentKeyboard,
  productDetailKeyboard,
  productsKeyboard,
  rechargeAmountsKeyboard,
} from './keyboards.js';

export async function showHomeScreen(ctx, repo, { forceNew = false, withBottomBar = false } = {}) {
  const userId = ctx.from.id;
  clearStep(userId);

  const user = await repo.upsertUser(ctx.from);
  const runtime = await repo.getRuntimeSettings(config);
  const ordersCount = await repo.countUserOrders(userId);
  const stats = await repo.getDashboardStats();
  const activeCoupon = getActiveDiscountCoupon(userId);
  const vip = getVipTier(user.total_spent_cents);

  if (withBottomBar && ctx.chat?.type === 'private') {
    await ctx
      .reply('⚡ <i>Menu rápido ativado na barra inferior.</i>', {
        parse_mode: 'HTML',
        reply_markup: persistentBottomKeyboard({ isAdminUser: isAdmin(userId) }),
      })
      .catch(() => {});
  }

  const couponLine = activeCoupon
    ? `\n🎟️ <b>Cupom ativo:</b> <code>${escapeHtml(activeCoupon)}</code>`
    : '';

  const ratingBadge =
    stats.reviewsCount > 0
      ? `⭐ <b>${stats.reviewsAverage.toFixed(1)}/5.0</b> (${stats.reviewsCount} avaliações)`
      : `🟢 <b>Entrega Automática 24/7</b>`;

  const text =
    `✨ <b>Bem-vindo(a) à ${escapeHtml(runtime.storeName)}!</b>\n` +
    `${ratingBadge} • 📦 <b>${stats.availableStock}</b> em estoque\n\n` +
    `👤 <b>Cliente:</b> ${formatDisplayName(user)} (<code>${user.telegram_id}</code>)\n` +
    `${vip.badge} <b>Nível:</b> ${vip.name} ${runtime.cashbackEnabled ? `(<b>${vip.cashbackPct}% Cashback</b>)` : ''}\n` +
    `💰 <b>Saldo na Carteira:</b> <code>${formatBRL(user.balance_cents)}</code>\n` +
    `🛍️ <b>Compras realizadas:</b> ${ordersCount}` +
    `${couponLine}\n\n` +
    `Escolha uma opção abaixo para começar:`;

  await renderScreen(ctx, {
    text,
    keyboard: mainMenuKeyboard({
      isAdminUser: isAdmin(userId),
      supportUsername: runtime.supportUsername,
      reviewsCount: stats.reviewsCount,
    }),
    bannerType: 'home',
    forceNew,
  });
}

/**
 * Entrega o pedido ao cliente, envia pedido de avaliação e notifica admins + canal de vendas!
 */
export async function deliverOrderAndNotify(bot, repo, userId, purchase) {
  const runtime = await repo.getRuntimeSettings(config);

  const credentialsFormatted = purchase.credentials
    .map((cred, idx) => `🔑 <b>Acesso ${idx + 1}:</b>\n<code>${escapeHtml(cred)}</code>`)
    .join('\n\n');

  const cashbackLine =
    purchase.cashbackCents > 0
      ? `🎁 <b>Cashback VIP creditado:</b> <code>+${formatBRL(purchase.cashbackCents)}</code>\n`
      : '';

  const deliveryMessage =
    `🎉 <b>Compra Concluída • ${escapeHtml(runtime.storeName)}</b>\n\n` +
    `🧾 <b>Pedido:</b> <code>#${purchase.order.id}</code>\n` +
    `💎 <b>Produto:</b> ${escapeHtml(purchase.order.product_name)}\n` +
    `📦 <b>Quantidade:</b> ${purchase.order.quantity}x\n` +
    `💵 <b>Total pago:</b> <code>${formatBRL(purchase.order.total_cents)}</code>\n` +
    `${cashbackLine}` +
    `💰 <b>Saldo atual:</b> <code>${formatBRL(purchase.balanceAfterCents)}</code>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🔐 <b>DADOS DE ACESSO (toque para copiar):</b>\n\n` +
    `${credentialsFormatted}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `⭐ <i>Como foi sua experiência? Avalie abaixo com 1 toque:</i>`;

  await bot.api
    .sendMessage(userId, deliveryMessage, {
      parse_mode: 'HTML',
      reply_markup: orderReviewStarsKeyboard(purchase.order.id),
    })
    .catch(() => {});

  // Notifica administradores
  const buyer = await repo.getUser(userId);
  const adminNotice =
    `🛍️ <b>Nova Venda Realizada! (#${purchase.order.id})</b>\n\n` +
    `👤 <b>Cliente:</b> ${formatUserLabel(buyer)} (<code>${userId}</code>)\n` +
    `🏷️ <b>Produto:</b> ${escapeHtml(purchase.order.product_name)} (${purchase.order.quantity}x)\n` +
    `💵 <b>Total:</b> <code>${formatBRL(purchase.order.total_cents)}</code>\n` +
    (purchase.cashbackCents > 0 ? `🎁 <b>Cashback VIP:</b> ${formatBRL(purchase.cashbackCents)}\n` : '') +
    `📦 <b>Estoque restante deste item:</b> ${purchase.remainingStock}`;

  for (const adminId of config.adminIds) {
    await bot.api.sendMessage(adminId, adminNotice, { parse_mode: 'HTML' }).catch(() => {});
  }

  // Se houver canal/grupo público de vendas configurado, posta aviso anônimo de prova social!
  if (runtime.salesChannelId) {
    const maskedName = `${formatDisplayName(buyer).slice(0, 3)}***`;
    const publicSaleMsg =
      `🔥 <b>Nova Entrega Automática • ${escapeHtml(runtime.storeName)}</b>\n\n` +
      `👤 <b>Comprador:</b> ${maskedName}\n` +
      `💎 <b>Plano:</b> ${escapeHtml(purchase.order.product_name)} (${purchase.order.quantity}x)\n` +
      `⚡ <b>Status:</b> Entregue instantaneamente no chat!`;

    await bot.api.sendMessage(runtime.salesChannelId, publicSaleMsg, { parse_mode: 'HTML' }).catch(() => {});
  }
}

/**
 * Trata todas as notificações pós-aprovação de um Pix (comissão de afiliado, entrega direta do produto ou saldo).
 */
export async function handlePostDepositApprovalNotifications(bot, repo, approvalResult) {
  if (!approvalResult?.approved) return;

  const runtime = await repo.getRuntimeSettings(config);
  const { deposit, user, referralReward, autoPurchase, autoPurchaseError } = approvalResult;

  // 1) Se gerou comissão para quem indicou, avisa o indicador na hora!
  if (referralReward) {
    await bot.api
      .sendMessage(
        referralReward.referrerId,
        `🎁 <b>Comissão de Indicação Recebida!</b>\n\n` +
          `Um indicado seu acabou de realizar uma recarga e você ganhou <b>+${formatBRL(referralReward.bonusCents)}</b> na carteira!\n` +
          `💰 <b>Seu novo saldo:</b> <code>${formatBRL(referralReward.newBalanceCents)}</code>`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
  }

  // 2) Se era um Pix Direto de Produto e a compra automática rodou com sucesso -> já entrega a conta!
  if (autoPurchase) {
    if (deposit.target_coupon_code) {
      setActiveDiscountCoupon(deposit.user_id, null);
    }
    await bot.api
      .sendMessage(
        deposit.user_id,
        `✅ <b>Pix #${deposit.id} confirmado!</b> Processando a entrega imediata do seu pedido...`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});

    await deliverOrderAndNotify(bot, repo, deposit.user_id, autoPurchase);
    return;
  }

  // 3) Se era Pix Direto mas o estoque acabou enquanto o cliente pagava -> saldo fica 100% seguro na carteira!
  if (deposit.target_product_id && autoPurchaseError) {
    await bot.api
      .sendMessage(
        deposit.user_id,
        `✅ <b>Seu Pix de ${formatBRL(deposit.amount_cents)} foi confirmado e creditado na sua carteira!</b>\n\n` +
          `⚠️ <i>Nota sobre o item selecionado: ${escapeHtml(autoPurchaseError)}</i>\n` +
          `💰 <b>Seu saldo disponível (${formatBRL(user.balance_cents)})</b> já está liberado para escolher qualquer outro plano imediatamente!`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('💎 Abrir Catálogo', 'cat:list')
            .text('🏠 Menu Principal', 'nav:home:new'),
        }
      )
      .catch(() => {});
    return;
  }

  // 4) Recarga normal de carteira
  const msg =
    `✅ <b>Recarga Confirmada com Sucesso!</b>\n\n` +
    `💵 <b>Valor creditado:</b> <code>+${formatBRL(deposit.amount_cents)}</code>\n` +
    `💰 <b>Novo saldo na carteira:</b> <code>${formatBRL(user.balance_cents)}</code>\n\n` +
    `Seu saldo já está liberado para compras instantâneas na <b>${escapeHtml(runtime.storeName)}</b>!`;

  await bot.api
    .sendMessage(deposit.user_id, msg, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('💎 Ir para o Catálogo', 'cat:list')
        .text('🏠 Menu Principal', 'nav:home:new'),
    })
    .catch(() => {});
}

async function createAndSendPixDeposit(
  ctx,
  repo,
  amountCents,
  { targetProduct = null, targetQty = 1, targetCouponCode = null } = {}
) {
  const userId = ctx.from.id;
  clearStep(userId);

  const runtime = await repo.getRuntimeSettings(config);
  const minAllowed = targetProduct ? 100 : config.minDepositCents;

  if (amountCents < minAllowed || amountCents > config.maxDepositCents) {
    return ctx.reply(
      `⚠️ O valor do Pix deve estar entre <b>${formatBRL(minAllowed)}</b> e <b>${formatBRL(config.maxDepositCents)}</b>.`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('💳 Tentar Novamente', 'wal:recharge')
          .text('🏠 Início', 'nav:home:new'),
      }
    );
  }

  if (runtime.effectivePixMode === 'unconfigured') {
    const adminHint = isAdmin(userId)
      ? `\n\n👑 <b>Dica Admin:</b> Vá em <b>⚙️ Painel Admin → 🔧 Config Pix & Loja</b> para cadastrar sua Chave Pix ou Token Mercado Pago agora mesmo pelo chat!`
      : `\n\nFale com o suporte ${escapeHtml(runtime.supportUsername)} para finalizar.`;

    return ctx.reply(
      `⚠️ <b>Chave Pix da loja ainda não configurada.</b>${adminHint}`,
      {
        parse_mode: 'HTML',
        reply_markup: isAdmin(userId)
          ? new InlineKeyboard().text('🔧 Configurar Pix Agora', 'adm:cfg:menu')
          : undefined,
      }
    );
  }

  const txid = `GH${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 900 + 100)}`.slice(0, 25);

  let method = 'manual_pix';
  let pixCode = '';
  let qrBuffer = null;
  let providerPaymentId = null;
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  if (runtime.effectivePixMode === 'syncpay') {
    try {
      const sp = await createSyncPayPix({
        clientId: runtime.syncpayClientId,
        clientSecret: runtime.syncpayClientSecret,
        amountCents,
        description: targetProduct
          ? `${targetQty}x ${targetProduct.name} (${runtime.storeName})`
          : `Recarga ${runtime.storeName} #${txid}`,
        webhookUrl: runtime.syncpayWebhookUrl,
        userId,
        clientName: ctx.from.first_name || 'Cliente Gemini Hub',
      });
      method = 'syncpay_pix';
      pixCode = sp.pixCode;
      providerPaymentId = sp.providerPaymentId;
      qrBuffer = await generatePixQrCodeBuffer(pixCode);
    } catch (err) {
      if (config.pixMode === 'hybrid' && runtime.pixKey) {
        method = 'manual_pix';
      } else {
        return ctx.reply(
          `❌ <b>Não foi possível gerar o Pix via SyncPay no momento:</b>\n<code>${escapeHtml(err.message)}</code>`,
          { parse_mode: 'HTML' }
        );
      }
    }
  } else if (runtime.effectivePixMode === 'auto') {
    try {
      const mp = await createMercadoPagoPix({
        accessToken: runtime.mercadoPagoAccessToken,
        amountCents,
        description: targetProduct
          ? `${targetQty}x ${targetProduct.name} (${runtime.storeName})`
          : `Recarga ${runtime.storeName} #${txid}`,
        externalReference: txid,
        payerFirstName: ctx.from.first_name || 'Cliente',
      });
      method = 'mercadopago_pix';
      pixCode = mp.qrCode;
      providerPaymentId = mp.providerPaymentId;
      qrBuffer = mp.qrCodeBase64
        ? Buffer.from(mp.qrCodeBase64, 'base64')
        : await generatePixQrCodeBuffer(pixCode);
    } catch (err) {
      if (config.pixMode === 'hybrid' && runtime.pixKey) {
        method = 'manual_pix';
      } else {
        return ctx.reply(
          `❌ <b>Não foi possível gerar o Pix automático no momento:</b>\n<code>${escapeHtml(err.message)}</code>`,
          { parse_mode: 'HTML' }
        );
      }
    }
  }

  if (method === 'manual_pix') {
    pixCode = generatePixPayload({
      pixKey: runtime.pixKey,
      merchantName: runtime.pixMerchantName,
      merchantCity: runtime.pixMerchantCity,
      amountCents,
      txid,
      description: targetProduct ? `Pedido ${runtime.storeName}` : `Recarga ${runtime.storeName}`,
    });
    qrBuffer = await generatePixQrCodeBuffer(pixCode);
  }

  const deposit = await repo.createDeposit({
    userId,
    amountCents,
    method,
    txid,
    providerPaymentId,
    pixCode,
    expiresAt,
    targetProductId: targetProduct ? targetProduct.id : null,
    targetQuantity: targetQty,
    targetCouponCode,
  });

  const orderHeader = targetProduct
    ? `🛍️ <b>Compra Direta via Pix</b>\n💎 <b>Item:</b> ${targetQty}x ${escapeHtml(targetProduct.name)}\n`
    : `💳 <b>Recarga de Carteira via Pix</b>\n`;

  const isAutomatedGateway = method === 'syncpay_pix' || method === 'mercadopago_pix';
  const modeInstructions = isAutomatedGateway
    ? targetProduct
      ? `⚡ <b>Entrega Automática:</b> Após pagar, toque em <b>🔄 Já Paguei • Verificar Agora</b> (ou aguarde o webhook) para receber sua conta na hora!`
      : `⚡ <b>Aprovação Automática:</b> Após pagar, toque em <b>🔄 Já Paguei • Verificar Agora</b> (ou aguarde a confirmação automática)!`
    : targetProduct
      ? `📎 <b>Liberação Rápida:</b> Após pagar, toque em <b>Enviar Comprovante Pix</b> abaixo para receber sua conta no chat!`
      : `📎 <b>Confirmação Rápida:</b> Após pagar, toque em <b>Enviar Comprovante Pix</b> abaixo para liberar seu saldo.`;

  const caption =
    `${orderHeader}` +
    `🆔 <b>Código:</b> <code>#${deposit.id}</code>  |  💵 <b>Valor:</b> <b>${formatBRL(amountCents)}</b>\n\n` +
    `📋 <b>Pix Copia e Cola (toque para copiar):</b>\n` +
    `<code>${escapeHtml(pixCode)}</code>\n\n` +
    `${modeInstructions}`;

  await ctx.replyWithPhoto(new InputFile(qrBuffer, `pix-${deposit.id}.png`), {
    caption,
    parse_mode: 'HTML',
    reply_markup: pixPaymentKeyboard(deposit),
  });
}

// ============================================================================
// SUB-SCREENS REUTILIZÁVEIS (PARA INLINE BUTTONS & TECLADO INFERIOR FIXO!)
// ============================================================================
export async function openCatalogScreen(ctx, repo, { forceNew = false } = {}) {
  clearStep(ctx.from.id);
  const categories = await repo.listCategories({ onlyActive: true });
  const user = await repo.getUser(ctx.from.id);
  const runtime = await repo.getRuntimeSettings(config);

  // Se houver apenas 1 categoria ativa (ex: Planos Gemini Pro & Ultra), abre direto os planos!
  if (categories.length === 1) {
    const onlyCat = categories[0];
    const products = await repo.listProductsByCategory(onlyCat.id, { onlyActive: true });

    const text =
      `${onlyCat.emoji} <b>${escapeHtml(onlyCat.name)} • ${escapeHtml(runtime.storeName)}</b>\n` +
      `${onlyCat.description ? `<i>${escapeHtml(onlyCat.description)}</i>\n` : ''}\n` +
      `💰 <b>Seu saldo:</b> <code>${formatBRL(user?.balance_cents || 0)}</code>\n\n` +
      (products.length > 0
        ? `Escolha seu plano abaixo (🟢 Pronta entrega • 🔴 Sem estoque):`
        : `⚠️ Nenhum plano ativo cadastrado no momento.`);

    await renderScreen(ctx, {
      text,
      keyboard: productsKeyboard(products, { singleCategory: true }),
      bannerType: 'catalog',
      forceNew,
    });
    return;
  }

  const text =
    `💎 <b>Catálogo Oficial • ${escapeHtml(runtime.storeName)}</b>\n` +
    `💰 <b>Seu saldo:</b> <code>${formatBRL(user?.balance_cents || 0)}</code>\n\n` +
    (categories.length > 0
      ? `Selecione uma categoria abaixo para ver os planos e o estoque em tempo real:`
      : `⚠️ Nenhuma categoria ativa cadastrada no momento.`);

  await renderScreen(ctx, {
    text,
    keyboard: categoriesKeyboard(categories),
    bannerType: 'catalog',
    forceNew,
  });
}

export async function openRechargeScreen(ctx, repo, { forceNew = false } = {}) {
  clearStep(ctx.from.id);
  const user = await repo.getUser(ctx.from.id);
  const runtime = await repo.getRuntimeSettings(config);

  const text =
    `💳 <b>Adicionar Saldo via Pix • ${escapeHtml(runtime.storeName)}</b>\n\n` +
    `💰 <b>Saldo atual:</b> <code>${formatBRL(user?.balance_cents || 0)}</code>\n` +
    `📌 <b>Recarga mínima:</b> <code>${formatBRL(config.minDepositCents)}</code>\n\n` +
    `Escolha um valor rápido abaixo ou digite um valor personalizado:`;

  await renderScreen(ctx, {
    text,
    keyboard: rechargeAmountsKeyboard(),
    bannerType: 'home',
    forceNew,
  });
}

export async function openOrdersScreen(ctx, repo, { forceNew = false } = {}) {
  clearStep(ctx.from.id);
  const orders = await repo.listUserOrders(ctx.from.id, 12);
  const runtime = await repo.getRuntimeSettings(config);
  const kb = new InlineKeyboard();

  for (const order of orders) {
    kb.text(
      `🧾 #${order.id} • ${order.product_name.slice(0, 22)} (${formatBRL(order.total_cents)})`,
      `ord:view:${order.id}`
    ).row();
  }
  kb.text('💎 Catálogo', 'cat:list').text('🏠 Início', 'nav:home');

  const text =
    `📦 <b>Minhas Compras • ${escapeHtml(runtime.storeName)}</b>\n\n` +
    (orders.length > 0
      ? `Toque em qualquer pedido abaixo para rever os dados de acesso entregues:`
      : `Você ainda não realizou nenhuma compra.\nExplore nosso catálogo para adquirir seu primeiro plano!`);

  await renderScreen(ctx, { text, keyboard: kb, bannerType: null, forceNew });
}

export async function openWalletScreen(ctx, repo, { forceNew = false } = {}) {
  clearStep(ctx.from.id);
  const user = await repo.getUser(ctx.from.id);
  const runtime = await repo.getRuntimeSettings(config);
  const history = await repo.getWalletHistory(ctx.from.id, 10);
  const vip = getVipTier(user.total_spent_cents);

  const nextVipHint = vip.nextTierCents
    ? `Faltam <b>${formatBRL(vip.nextTierCents - user.total_spent_cents)}</b> em compras para subir de nível VIP!`
    : `Você atingiu o nível máximo <b>💎 VIP Ultra</b>!`;

  const txLines =
    history.length > 0
      ? history
          .map((tx) => {
            const sign = tx.amount_cents >= 0 ? '🟢 +' : '🔻 ';
            const val = formatBRL(Math.abs(tx.amount_cents));
            return `${sign}<b>${val}</b> — ${escapeHtml(tx.description)} <i>(${formatDateBR(tx.created_at)})</i>`;
          })
          .join('\n')
      : '<i>Nenhuma movimentação registrada ainda.</i>';

  const text =
    `👤 <b>Minha Carteira & Fidelidade VIP</b>\n\n` +
    `🆔 <b>Seu ID:</b> <code>${user.telegram_id}</code>\n` +
    `${vip.badge} <b>Nível atual:</b> <b>${vip.name}</b> ${runtime.cashbackEnabled ? `(${vip.cashbackPct}% de Cashback)` : ''}\n` +
    `📈 <i>${nextVipHint}</i>\n\n` +
    `💰 <b>Saldo disponível:</b> <code>${formatBRL(user.balance_cents)}</code>\n` +
    `💳 <b>Total recarregado:</b> <code>${formatBRL(user.total_deposited_cents)}</code>\n` +
    `🛍️ <b>Total investido:</b> <code>${formatBRL(user.total_spent_cents)}</code>\n\n` +
    `📜 <b>Últimas Movimentações:</b>\n${txLines}`;

  await renderScreen(ctx, {
    text,
    keyboard: new InlineKeyboard()
      .text('💳 Adicionar Saldo', 'wal:recharge')
      .text('🎁 Indique & Ganhe', 'ref:menu')
      .row()
      .text('🏠 Início', 'nav:home'),
    bannerType: null,
    forceNew,
  });
}

export async function openReferralScreen(ctx, bot, repo, { forceNew = false } = {}) {
  clearStep(ctx.from.id);
  const user = await repo.getUser(ctx.from.id);
  const runtime = await repo.getRuntimeSettings(config);
  const botUsername = ctx.me?.username || 'GeminiHubStoreBot';
  const refLink = `https://t.me/${botUsername}?start=ref_${user.telegram_id}`;
  const shareText = encodeURIComponent(
    `💎 Conheça a ${runtime.storeName}! Planos Gemini Pro, Gemini Ultra e contas digitais com entrega imediata no Telegram:`
  );
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${shareText}`;

  const text =
    `🎁 <b>Programa Indique & Ganhe • ${escapeHtml(runtime.storeName)}</b>\n\n` +
    `Convide amigos usando seu link exclusivo e ganhe <b>${runtime.referralCommissionPct}% de comissão em saldo</b> automaticamente em todas as recargas que eles fizerem!\n\n` +
    `🔗 <b>Seu link exclusivo (toque para copiar):</b>\n` +
    `<code>${refLink}</code>\n\n` +
    `👥 <b>Convidados cadastrados:</b> ${user.referrals_count || 0}\n` +
    `💰 <b>Total ganho com indicações:</b> <code>${formatBRL(user.referral_earnings_cents || 0)}</code>`;

  const kb = new InlineKeyboard()
    .url('📲 Compartilhar com Amigos', shareUrl)
    .row()
    .text('💎 Ir ao Catálogo', 'cat:list')
    .text('🏠 Início', 'nav:home');

  await renderScreen(ctx, { text, keyboard: kb, bannerType: null, forceNew });
}

export async function openReviewsScreen(ctx, repo, { forceNew = false } = {}) {
  clearStep(ctx.from.id);
  const runtime = await repo.getRuntimeSettings(config);
  const summary = await repo.getReviewSummary();
  const reviews = await repo.listRecentReviews(8);

  const listHtml =
    reviews.length > 0
      ? reviews
          .map((r) => {
            const maskedUser = `${formatDisplayName(r).slice(0, 4)}***`;
            const commentLine = r.comment ? `\n💬 <i>"${escapeHtml(r.comment)}"</i>` : '';
            return (
              `${renderStars(r.rating)} — <b>${escapeHtml(r.product_name)}</b>\n` +
              `👤 ${maskedUser} • <i>${formatDateBR(r.created_at)}</i>${commentLine}`
            );
          })
          .join('\n\n')
      : `<i>Ainda não há avaliações registradas. Faça sua primeira compra e seja o primeiro a avaliar!</i>`;

  const headerScore =
    summary.count > 0
      ? `🏆 <b>Nota Média: ${summary.average.toFixed(1)} / 5.0</b> (${summary.count} avaliações verificadas)\n\n`
      : `✨ <b>Avaliações 100% Verificadas de Compradores Reais</b>\n\n`;

  const text =
    `⭐ <b>Mural de Avaliações • ${escapeHtml(runtime.storeName)}</b>\n` +
    `${headerScore}` +
    `${listHtml}`;

  await renderScreen(ctx, {
    text,
    keyboard: new InlineKeyboard()
      .text('💎 Ver Planos Disponíveis', 'cat:list')
      .text('🏠 Início', 'nav:home'),
    bannerType: null,
    forceNew,
  });
}

// ============================================================================
// REGISTRO DE COMANDOS & CALLBACKS DO CLIENTE
// ============================================================================
export function registerClientHandlers(bot, repo) {
  bot.command('start', async (ctx) => {
    const user = await repo.upsertUser(ctx.from);
    const payload = String(ctx.match || '').trim();

    // Vincula indicação se entrou via ?start=ref_123456
    if (payload.startsWith('ref_')) {
      const refId = Number(payload.replace('ref_', ''));
      const bindRes = await repo.bindReferrer(user.telegram_id, refId);
      if (bindRes.bound && bindRes.referrer) {
        await bot.api
          .sendMessage(
            bindRes.referrer.telegram_id,
            `🎉 <b>Novo indicado!</b> ${formatDisplayName(user)} acabou de entrar na loja pelo seu link de convite!`,
            { parse_mode: 'HTML' }
          )
          .catch(() => {});
      }
    }

    await showHomeScreen(ctx, repo, { forceNew: true, withBottomBar: true });
  });

  bot.command('menu', async (ctx) => {
    await showHomeScreen(ctx, repo, { forceNew: true, withBottomBar: true });
  });

  bot.command('meuid', async (ctx) => {
    await ctx.reply(`🆔 Seu ID numérico no Telegram é: <code>${ctx.from.id}</code>`, {
      parse_mode: 'HTML',
    });
  });

  bot.callbackQuery('noop', async (ctx) => {
    await safeAnswer(ctx);
  });

  bot.callbackQuery('nav:home', async (ctx) => {
    await safeAnswer(ctx);
    await showHomeScreen(ctx, repo, { forceNew: false });
  });

  bot.callbackQuery('nav:home:new', async (ctx) => {
    await safeAnswer(ctx);
    await showHomeScreen(ctx, repo, { forceNew: true });
  });

  // Catálogo
  bot.callbackQuery('cat:list', async (ctx) => {
    await safeAnswer(ctx);
    await openCatalogScreen(ctx, repo);
  });

  bot.callbackQuery(/^cat:view:(\d+)$/, async (ctx) => {
    const categoryId = Number(ctx.match[1]);
    const category = await repo.getCategory(categoryId);

    if (!category || !category.is_active) {
      return safeAnswer(ctx, { text: 'Categoria indisponível.', show_alert: true });
    }

    await safeAnswer(ctx);
    const categories = await repo.listCategories({ onlyActive: true });
    const products = await repo.listProductsByCategory(categoryId, { onlyActive: true });
    const user = await repo.getUser(ctx.from.id);

    const text =
      `${category.emoji} <b>${escapeHtml(category.name)}</b>\n` +
      `${category.description ? `<i>${escapeHtml(category.description)}</i>\n` : ''}\n` +
      `💰 <b>Seu saldo:</b> <code>${formatBRL(user?.balance_cents || 0)}</code>\n\n` +
      (products.length > 0
        ? `Selecione o plano desejado (🟢 Pronta entrega • 🔴 Sem estoque):`
        : `⚠️ Nenhum produto ativo nesta categoria no momento.`);

    await renderScreen(ctx, {
      text,
      keyboard: productsKeyboard(products, { singleCategory: categories.length <= 1 }),
      bannerType: 'catalog',
    });
  });

  bot.callbackQuery(/^prd:view:(\d+):(\d+)$/, async (ctx) => {
    const productId = Number(ctx.match[1]);
    const requestedQty = Math.max(1, Number(ctx.match[2]));

    const product = await repo.getProduct(productId);
    if (!product || !product.is_active) {
      return safeAnswer(ctx, { text: 'Produto não disponível.', show_alert: true });
    }

    await safeAnswer(ctx);
    const qty = product.stock_count > 0 ? Math.min(requestedQty, product.stock_count, 10) : 1;
    const activeCouponCode = getActiveDiscountCoupon(ctx.from.id);
    const quote = await repo.calculateCheckoutQuote({
      userId: ctx.from.id,
      product,
      quantity: qty,
      discountCouponCode: activeCouponCode,
    });

    if (activeCouponCode && !quote.appliedCoupon) {
      setActiveDiscountCoupon(ctx.from.id, null);
    }

    const stockLabel =
      product.stock_count > 0
        ? `🟢 <b>${product.stock_count} unidade(s) pronta entrega</b>`
        : `🔴 <b>Esgotado — clique abaixo para ser avisado na reposição!</b>`;

    let priceBlock = `💵 <b>Valor unitário:</b> <code>${formatBRL(product.price_cents)}</code>\n`;
    if (qty > 1) {
      priceBlock += `📦 <b>Quantidade:</b> ${qty}x\n`;
    }
    if (quote.discountCents > 0 && quote.appliedCoupon) {
      priceBlock += `🎟️ <b>Cupom (${escapeHtml(quote.appliedCoupon.code)}):</b> <code>-${formatBRL(quote.discountCents)}</code>\n`;
    }
    priceBlock += `💎 <b>Total do pedido:</b> <b>${formatBRL(quote.totalCents)}</b>\n`;
    if (quote.cashbackCents > 0) {
      priceBlock += `🎁 <b>Cashback ${quote.vip.name}:</b> <code>+${formatBRL(quote.cashbackCents)}</code> de volta\n`;
    }

    const text =
      `${product.category_emoji} <b>${escapeHtml(product.name)}</b>\n\n` +
      `📝 ${escapeHtml(product.description || 'Entrega automática no chat imediatamente após a confirmação.')}\n\n` +
      `🛡️ <b>Garantia:</b> ${escapeHtml(product.warranty)}\n` +
      `📊 <b>Estoque:</b> ${stockLabel}\n\n` +
      `${priceBlock}` +
      `💰 <b>Seu saldo atual:</b> <code>${formatBRL(quote.userBalance)}</code>`;

    const isSubscribedAlert =
      product.stock_count === 0 ? await repo.isSubscribedStockAlert(ctx.from.id, product.id) : false;

    await renderScreen(ctx, {
      text,
      keyboard: productDetailKeyboard({ product, qty, quote, isSubscribedAlert }),
      bannerType: 'catalog',
    });
  });

  // Alerta "Avise-me quando chegar estoque"
  bot.callbackQuery(/^prd:alert:(\d+)$/, async (ctx) => {
    const productId = Number(ctx.match[1]);
    const product = await repo.getProduct(productId);
    if (!product) {
      return safeAnswer(ctx, { text: 'Produto não encontrado.', show_alert: true });
    }

    await repo.subscribeStockAlert(ctx.from.id, productId);
    await safeAnswer(ctx, {
      text: '🔔 Pronto! Vamos te avisar aqui no chat assim que este produto for reposto!',
      show_alert: true,
    });

    const quote = await repo.calculateCheckoutQuote({ userId: ctx.from.id, product, quantity: 1 });
    await ctx
      .editMessageReplyMarkup({
        reply_markup: productDetailKeyboard({
          product,
          qty: 1,
          quote,
          isSubscribedAlert: true,
        }),
      })
      .catch(() => {});
  });

  // Pagar Direto no Pix (gera cobrança Pix exata do valor que falta e entrega sozinho quando aprovar!)
  bot.callbackQuery(/^prd:pixbuy:(\d+):(\d+)$/, async (ctx) => {
    const productId = Number(ctx.match[1]);
    const qty = Math.max(1, Number(ctx.match[2]));
    const product = await repo.getProduct(productId);

    if (!product || !product.is_active || product.stock_count < qty) {
      return safeAnswer(ctx, { text: 'Estoque insuficiente no momento.', show_alert: true });
    }

    const activeCouponCode = getActiveDiscountCoupon(ctx.from.id);
    const quote = await repo.calculateCheckoutQuote({
      userId: ctx.from.id,
      product,
      quantity: qty,
      discountCouponCode: activeCouponCode,
    });

    const pixChargeCents = Math.max(100, quote.missingCents > 0 ? quote.missingCents : quote.totalCents);
    await safeAnswer(ctx, { text: '💠 Gerando Pix do seu pedido...' });

    await createAndSendPixDeposit(ctx, repo, pixChargeCents, {
      targetProduct: product,
      targetQty: qty,
      targetCouponCode: quote.appliedCoupon ? quote.appliedCoupon.code : null,
    });
  });

  // Confirmação de compra com saldo da carteira
  bot.callbackQuery(/^prd:confirm:(\d+):(\d+)$/, async (ctx) => {
    const productId = Number(ctx.match[1]);
    const qty = Math.max(1, Number(ctx.match[2]));
    const product = await repo.getProduct(productId);

    if (!product || !product.is_active || product.stock_count < qty) {
      return safeAnswer(ctx, {
        text: 'Estoque insuficiente para essa quantidade.',
        show_alert: true,
      });
    }

    await safeAnswer(ctx);
    const activeCouponCode = getActiveDiscountCoupon(ctx.from.id);
    const quote = await repo.calculateCheckoutQuote({
      userId: ctx.from.id,
      product,
      quantity: qty,
      discountCouponCode: activeCouponCode,
    });

    const text =
      `⚡ <b>Confirmação de Compra Instantânea</b>\n\n` +
      `📌 <b>Produto:</b> ${escapeHtml(product.name)}\n` +
      `📦 <b>Quantidade:</b> ${qty}x\n` +
      (quote.discountCents > 0 ? `🎟️ <b>Desconto aplicado:</b> -${formatBRL(quote.discountCents)}\n` : '') +
      `💵 <b>Total debitado do saldo:</b> <b>${formatBRL(quote.totalCents)}</b>\n` +
      (quote.cashbackCents > 0 ? `🎁 <b>Cashback de volta:</b> +${formatBRL(quote.cashbackCents)}\n` : '') +
      `\nAo confirmar, os dados de acesso são enviados <b>na hora</b> aqui no chat.`;

    await renderScreen(ctx, {
      text,
      keyboard: confirmPurchaseKeyboard(product, qty),
      bannerType: 'catalog',
    });
  });

  // Execução atômica da compra com saldo
  bot.callbackQuery(/^prd:buy:(\d+):(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const productId = Number(ctx.match[1]);
    const qty = Math.max(1, Number(ctx.match[2]));
    const discountCouponCode = getActiveDiscountCoupon(userId);

    let purchase;
    try {
      purchase = await repo.purchaseProduct({
        userId,
        productId,
        quantity: qty,
        discountCouponCode,
      });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_BALANCE') {
        return safeAnswer(ctx, {
          text: `Saldo insuficiente! Faltam ${formatBRL(err.missingCents)}.`,
          show_alert: true,
        });
      }
      return safeAnswer(ctx, {
        text: err.message || 'Não foi possível concluir a compra.',
        show_alert: true,
      });
    }

    if (purchase.order.coupon_code) {
      setActiveDiscountCoupon(userId, null);
    }

    await safeAnswer(ctx, { text: '✅ Compra aprovada! Entregando sua conta...' });
    await deliverOrderAndNotify(bot, repo, userId, purchase);
  });

  // Carteira & Recargas
  bot.callbackQuery('wal:recharge', async (ctx) => {
    await safeAnswer(ctx);
    await openRechargeScreen(ctx, repo);
  });

  bot.callbackQuery(/^wal:amount:(\d+)$/, async (ctx) => {
    await safeAnswer(ctx, { text: 'Gerando QR Code Pix...' });
    const amountCents = Number(ctx.match[1]);
    await createAndSendPixDeposit(ctx, repo, amountCents);
  });

  bot.callbackQuery('wal:custom', async (ctx) => {
    await safeAnswer(ctx);
    setStep(ctx.from.id, 'awaiting_custom_deposit_amount');

    await renderScreen(ctx, {
      text:
        `✏️ <b>Digite o valor que deseja adicionar à carteira (em R$):</b>\n\n` +
        `Exemplos: <code>20</code>, <code>29,90</code> ou <code>59,90</code>\n` +
        `Valor mínimo: <code>${formatBRL(config.minDepositCents)}</code>`,
      keyboard: cancelStepKeyboard('wal:recharge'),
      bannerType: null,
    });
  });

  bot.callbackQuery(/^wal:check:(\d+)$/, async (ctx) => {
    const depositId = Number(ctx.match[1]);
    const deposit = await repo.getDeposit(depositId);
    const runtime = await repo.getRuntimeSettings(config);

    if (!deposit || deposit.user_id !== ctx.from.id) {
      return safeAnswer(ctx, { text: 'Cobrança não encontrada.', show_alert: true });
    }
    if (deposit.status === 'approved') {
      return safeAnswer(ctx, { text: '✅ Este pagamento já foi aprovado!', show_alert: true });
    }
    if (deposit.status !== 'pending') {
      return safeAnswer(ctx, { text: `Status atual: ${deposit.status}`, show_alert: true });
    }

    if (deposit.method === 'syncpay_pix') {
      if (!deposit.provider_payment_id || !runtime.syncpayClientId || !runtime.syncpayClientSecret) {
        return safeAnswer(ctx, {
          text: 'Credenciais SyncPay não configuradas no momento.',
          show_alert: true,
        });
      }

      if (deposit.status_checks_count >= 5) {
        return safeAnswer(ctx, {
          text: '⚠️ Limite máximo de 5 consultas atingido para este Pix. Aguarde o webhook ou fale com o suporte.',
          show_alert: true,
        });
      }

      try {
        const updatedDep = await repo.incrementDepositCheckCount(deposit.id);
        const spStatus = await getSyncPayTransactionStatus({
          clientId: runtime.syncpayClientId,
          clientSecret: runtime.syncpayClientSecret,
          identifier: deposit.provider_payment_id,
        });

        if (spStatus.status === 'completed') {
          const result = await repo.approveDeposit(deposit.id);
          if (result.approved) {
            await safeAnswer(ctx, { text: '✅ Pagamento SyncPay confirmado!' });
            await handlePostDepositApprovalNotifications(bot, repo, result);
            return;
          }
        } else if (spStatus.status === 'failed' || spStatus.status === 'refunded') {
          await repo.markDepositStatus(deposit.id, 'rejected');
          return safeAnswer(ctx, {
            text: `❌ Pagamento encerrado com status: ${spStatus.status}.`,
            show_alert: true,
          });
        }

        const remainingChecks = Math.max(0, 5 - updatedDep.status_checks_count);
        return safeAnswer(ctx, {
          text: `⏳ Pagamento ainda pendente no banco. (Verificações restantes: ${remainingChecks}/5)`,
          show_alert: true,
        });
      } catch (err) {
        return safeAnswer(ctx, {
          text: err.message,
          show_alert: true,
        });
      }
    }

    if (deposit.method !== 'mercadopago_pix' || !deposit.provider_payment_id || !runtime.mercadoPagoAccessToken) {
      return safeAnswer(ctx, {
        text: 'Envie o comprovante pelo botão abaixo para aprovação.',
        show_alert: true,
      });
    }

    try {
      const mpStatus = await getMercadoPagoPaymentStatus({
        accessToken: runtime.mercadoPagoAccessToken,
        providerPaymentId: deposit.provider_payment_id,
      });

      if (mpStatus.status === 'approved') {
        const result = await repo.approveDeposit(deposit.id);
        if (result.approved) {
          await safeAnswer(ctx, { text: '✅ Pagamento confirmado!' });
          await handlePostDepositApprovalNotifications(bot, repo, result);
          return;
        }
      }

      await safeAnswer(ctx, {
        text: '⏳ Pagamento ainda consta como pendente no banco. Tente novamente em instantes.',
        show_alert: true,
      });
    } catch (err) {
      await safeAnswer(ctx, {
        text: `Erro ao consultar: ${err.message}`,
        show_alert: true,
      });
    }
  });

  bot.callbackQuery(/^wal:proof:(\d+)$/, async (ctx) => {
    const depositId = Number(ctx.match[1]);
    const deposit = await repo.getDeposit(depositId);

    if (!deposit || deposit.user_id !== ctx.from.id) {
      return safeAnswer(ctx, { text: 'Cobrança não encontrada.', show_alert: true });
    }
    if (deposit.status === 'approved') {
      return safeAnswer(ctx, { text: 'Esta cobrança já foi aprovada!', show_alert: true });
    }
    if (deposit.status !== 'pending') {
      return safeAnswer(ctx, { text: 'Esta cobrança não está mais pendente.', show_alert: true });
    }

    await safeAnswer(ctx);
    setStep(ctx.from.id, 'awaiting_deposit_proof', { depositId });

    await ctx.reply(
      `📎 <b>Envio de Comprovante • Pix #${deposit.id} (${formatBRL(deposit.amount_cents)})</b>\n\n` +
        `Envie agora aqui no chat a <b>foto (print)</b> ou o <b>PDF/documento</b> do comprovante Pix.`,
      {
        parse_mode: 'HTML',
        reply_markup: cancelStepKeyboard('nav:home:new'),
      }
    );
  });

  bot.callbackQuery('wal:info', async (ctx) => {
    await safeAnswer(ctx);
    await openWalletScreen(ctx, repo);
  });

  // Compras do cliente
  bot.callbackQuery('ord:list', async (ctx) => {
    await safeAnswer(ctx);
    await openOrdersScreen(ctx, repo);
  });

  bot.callbackQuery(/^ord:view:(\d+)$/, async (ctx) => {
    const orderId = Number(ctx.match[1]);
    const order = await repo.getOrder(orderId);

    if (!order || order.user_id !== ctx.from.id) {
      return safeAnswer(ctx, { text: 'Pedido não encontrado.', show_alert: true });
    }

    await safeAnswer(ctx);
    const credsText = order.credentials
      .map((c, idx) => `🔑 <b>Item ${idx + 1}:</b>\n<code>${escapeHtml(c)}</code>`)
      .join('\n\n');

    const text =
      `🧾 <b>Detalhes do Pedido #${order.id}</b>\n\n` +
      `💎 <b>Produto:</b> ${escapeHtml(order.product_name)}\n` +
      `📦 <b>Quantidade:</b> ${order.quantity}x\n` +
      `💵 <b>Total pago:</b> <code>${formatBRL(order.total_cents)}</code>\n` +
      `📅 <b>Data:</b> ${formatDateBR(order.created_at)}\n\n` +
      `🔐 <b>Credenciais Entregues:</b>\n\n${credsText}`;

    await renderScreen(ctx, {
      text,
      keyboard: new InlineKeyboard()
        .text('⬅️ Minhas Compras', 'ord:list')
        .text('🏠 Início', 'nav:home'),
      bannerType: null,
    });
  });

  // Cupons
  bot.callbackQuery('cup:prompt', async (ctx) => {
    await safeAnswer(ctx);
    setStep(ctx.from.id, 'awaiting_coupon_code');

    await renderScreen(ctx, {
      text:
        `🎟️ <b>Resgatar Cupom Promocional</b>\n\n` +
        `Digite abaixo o código do seu cupom (vale-saldo ou desconto `%`):`,
      keyboard: cancelStepKeyboard('nav:home'),
      bannerType: null,
    });
  });

  // Indique & Ganhe
  bot.callbackQuery('ref:menu', async (ctx) => {
    await safeAnswer(ctx);
    await openReferralScreen(ctx, bot, repo);
  });

  // Avaliações
  bot.callbackQuery('rev:list', async (ctx) => {
    await safeAnswer(ctx);
    await openReviewsScreen(ctx, repo);
  });

  bot.callbackQuery(/^rev:rate:(\d+):([1-5])$/, async (ctx) => {
    const orderId = Number(ctx.match[1]);
    const rating = Number(ctx.match[2]);

    try {
      await repo.saveOrderReview({ orderId, userId: ctx.from.id, rating });
    } catch (err) {
      return safeAnswer(ctx, { text: err.message, show_alert: true });
    }

    await safeAnswer(ctx, { text: `Obrigado pela avaliação ${rating}⭐!` });
    setStep(ctx.from.id, 'awaiting_review_comment', { orderId, rating });

    // Remove os botões de estrelas da mensagem de entrega (mantendo as credenciais intactas!)
    await ctx
      .editMessageReplyMarkup({
        reply_markup: new InlineKeyboard()
          .text('📦 Minhas Compras', 'ord:list')
          .text('🏠 Menu Principal', 'nav:home:new'),
      })
      .catch(() => {});

    await ctx.reply(
      `${renderStars(rating)} <b>Avaliação registrada!</b>\n\n` +
        `Deseja deixar um comentário curto sobre sua compra para aparecer no mural da loja? Digite abaixo ou clique em Pular:`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('⏭️ Pular Comentário', 'nav:home:new'),
      }
    );
  });
}

/**
 * Processa atalhos da Barra Inferior Fixa + etapas ativas do cliente.
 */
export async function handleClientStatefulMessage(ctx, bot, repo) {
  const userId = ctx.from?.id;
  if (!userId) return false;

  const text = (ctx.message?.text || '').trim();

  // 1) Atalhos do Teclado Inferior Fixo (sempre funcionam!)
  if (text === '💎 Catálogo') {
    await openCatalogScreen(ctx, repo, { forceNew: true });
    return true;
  }
  if (text === '💳 Adicionar Saldo') {
    await openRechargeScreen(ctx, repo, { forceNew: true });
    return true;
  }
  if (text === '📦 Minhas Compras') {
    await openOrdersScreen(ctx, repo, { forceNew: true });
    return true;
  }
  if (text === '👤 Minha Carteira') {
    await openWalletScreen(ctx, repo, { forceNew: true });
    return true;
  }
  if (text === '🎁 Indique & Ganhe') {
    await openReferralScreen(ctx, bot, repo, { forceNew: true });
    return true;
  }
  if (text === '⭐ Avaliações') {
    await openReviewsScreen(ctx, repo, { forceNew: true });
    return true;
  }

  const session = getSession(userId);
  if (!session.step || session.step.startsWith('admin_')) {
    return false;
  }

  // 2) Valor personalizado de recarga Pix
  if (session.step === 'awaiting_custom_deposit_amount') {
    const cents = parseBRLToCents(text);
    if (!cents) {
      await ctx.reply(
        `⚠️ Valor inválido. Digite apenas números, como <code>25</code> ou <code>29,90</code>.`,
        { parse_mode: 'HTML', reply_markup: cancelStepKeyboard('wal:recharge') }
      );
      return true;
    }

    await createAndSendPixDeposit(ctx, repo, cents);
    return true;
  }

  // 3) Comprovante Pix Manual
  if (session.step === 'awaiting_deposit_proof') {
    const { depositId } = session.data;
    const deposit = await repo.getDeposit(depositId);
    clearStep(userId);

    if (!deposit || deposit.status !== 'pending') {
      await ctx.reply('⚠️ Esta solicitação já foi processada ou expirou.');
      return true;
    }

    let fileId = null;
    let proofType = 'text';
    const note = ctx.message?.caption || ctx.message?.text || '';

    if (ctx.message?.photo?.length) {
      fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      proofType = 'photo';
    } else if (ctx.message?.document?.file_id) {
      fileId = ctx.message.document.file_id;
      proofType = 'document';
    } else if (!note) {
      setStep(userId, 'awaiting_deposit_proof', { depositId });
      await ctx.reply('⚠️ Envie uma imagem (foto/print) ou PDF do comprovante.');
      return true;
    }

    await repo.attachDepositProof(deposit.id, { fileId, type: proofType, note });

    const targetProd = deposit.target_product_id ? await repo.getProduct(deposit.target_product_id) : null;

    await ctx.reply(
      `✅ <b>Comprovante recebido com sucesso!</b>\n\n` +
        (targetProd
          ? `Assim que a administração confirmar o Pix de <b>${formatBRL(deposit.amount_cents)}</b>, seu acesso a <b>${escapeHtml(targetProd.name)}</b> será enviado automaticamente aqui no chat!`
          : `Nossa equipe já foi notificada e seu saldo de <b>${formatBRL(deposit.amount_cents)}</b> será liberado em instantes.`),
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('🏠 Menu Principal', 'nav:home:new'),
      }
    );

    const user = await repo.getUser(userId);
    const adminCaption =
      `🔔 <b>Comprovante Pix Recebido (#${deposit.id})</b>\n\n` +
      `👤 <b>Cliente:</b> ${formatUserLabel(user)} (<code>${userId}</code>)\n` +
      `💵 <b>Valor:</b> <b>${formatBRL(deposit.amount_cents)}</b>\n` +
      (targetProd ? `🛍️ <b>Compra Direta:</b> ${deposit.target_quantity}x ${escapeHtml(targetProd.name)}\n` : '') +
      `🔑 <b>TXID:</b> <code>${escapeHtml(deposit.txid)}</code>` +
      (note ? `\n💬 <b>Obs:</b> ${escapeHtml(note)}` : '');

    const adminKb = new InlineKeyboard()
      .text(
        targetProd
          ? `✅ Aprovar & Entregar Conta`
          : `✅ Aprovar (+${formatBRL(deposit.amount_cents)})`,
        `adm:dep:ok:${deposit.id}`
      )
      .row()
      .text('❌ Recusar Comprovante', `adm:dep:no:${deposit.id}`);

    for (const adminId of config.adminIds) {
      if (proofType === 'photo' && fileId) {
        await bot.api
          .sendPhoto(adminId, fileId, { caption: adminCaption, parse_mode: 'HTML', reply_markup: adminKb })
          .catch(() => {});
      } else if (proofType === 'document' && fileId) {
        await bot.api
          .sendDocument(adminId, fileId, { caption: adminCaption, parse_mode: 'HTML', reply_markup: adminKb })
          .catch(() => {});
      } else {
        await bot.api
          .sendMessage(adminId, adminCaption, { parse_mode: 'HTML', reply_markup: adminKb })
          .catch(() => {});
      }
    }

    return true;
  }

  // 4) Resgate de cupom
  if (session.step === 'awaiting_coupon_code') {
    if (!text) {
      await ctx.reply('⚠️ Digite o código do cupom em texto.', {
        reply_markup: cancelStepKeyboard('nav:home'),
      });
      return true;
    }

    clearStep(userId);
    try {
      const res = await repo.redeemCoupon(userId, text);
      if (res.mode === 'balance') {
        await ctx.reply(
          `🎉 <b>Cupom Resgatado com Sucesso!</b>\n\n` +
            `🎟️ <b>Código:</b> <code>${escapeHtml(res.coupon.code)}</code>\n` +
            `💵 <b>Crédito adicionado:</b> <code>+${formatBRL(res.creditedCents)}</code>\n` +
            `💰 <b>Novo saldo:</b> <code>${formatBRL(res.balanceAfterCents)}</code>`,
          {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard()
              .text('💎 Ir ao Catálogo', 'cat:list')
              .text('🏠 Início', 'nav:home:new'),
          }
        );
      } else {
        setActiveDiscountCoupon(userId, res.coupon.code);
        await ctx.reply(
          `✨ <b>Cupom de Desconto Ativado!</b>\n\n` +
            `🎟️ <b>Cupom:</b> <code>${escapeHtml(res.coupon.code)}</code> (<b>${res.coupon.value}% OFF</b>)\n` +
            `O desconto já está aplicado automaticamente na sua próxima compra!`,
          {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard()
              .text('💎 Escolher Plano Agora', 'cat:list')
              .text('🏠 Início', 'nav:home:new'),
          }
        );
      }
    } catch (err) {
      await ctx.reply(`❌ <b>Não foi possível aplicar o cupom:</b> ${escapeHtml(err.message)}`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('🔁 Tentar Outro Código', 'cup:prompt')
          .text('🏠 Início', 'nav:home:new'),
      });
    }
    return true;
  }

  // 5) Comentário opcional da avaliação pós-compra
  if (session.step === 'awaiting_review_comment') {
    const { orderId, rating } = session.data;
    clearStep(userId);

    if (text && text !== '.') {
      try {
        await repo.saveOrderReview({ orderId, userId, rating, comment: text });
      } catch {
        // ignore
      }
    }

    await ctx.reply(`💙 <b>Muito obrigado pelo seu feedback!</b> Sua avaliação ajuda muito a nossa comunidade.`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('⭐ Ver Mural de Avaliações', 'rev:list')
        .text('🏠 Início', 'nav:home:new'),
    });
    return true;
  }

  return false;
}
