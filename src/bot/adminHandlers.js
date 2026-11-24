import { InputFile, InlineKeyboard } from 'grammy';
import { config, isAdmin } from '../config.js';
import {
  escapeHtml,
  formatBRL,
  formatUserLabel,
  parseBRLToCents,
  truncate,
} from '../services/format.js';
import { createSyncPayWebhook, getSyncPayBalance } from '../services/syncpay.js';
import { clearStep, getSession, setStep } from './state.js';
import { renderScreen, safeAnswer } from './ui.js';
import { adminHomeKeyboard, cancelStepKeyboard } from './keyboards.js';
import { handlePostDepositApprovalNotifications } from './clientHandlers.js';

function guardAdmin(ctx) {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    if (ctx.callbackQuery) {
      safeAnswer(ctx, { text: '⛔ Acesso restrito aos administradores.', show_alert: true });
    }
    return false;
  }
  return true;
}

export async function showAdminHome(ctx, repo, { forceNew = false } = {}) {
  clearStep(ctx.from.id);
  const stats = await repo.getDashboardStats();
  const runtime = await repo.getRuntimeSettings(config);

  const modeLabels = {
    syncpay: '🟢 SyncPay Automático',
    auto: '🟢 Mercado Pago Automático',
    manual: '🟡 Chave Pix Manual',
    unconfigured: '🔴 Pix Não Configurado',
  };

  const text =
    `⚙️ <b>Painel Administrativo 2.0 • ${escapeHtml(runtime.storeName)}</b>\n\n` +
    `👥 <b>Clientes:</b> ${stats.totalUsers}  |  📦 <b>Estoque pronto:</b> ${stats.availableStock}\n` +
    `💵 <b>Vendas hoje:</b> ${stats.todayOrders} (<code>${formatBRL(stats.todayRevenueCents)}</code>)\n` +
    `🏆 <b>Faturamento total:</b> <code>${formatBRL(stats.totalRevenueCents)}</code>\n` +
    `🔔 <b>Depósitos pendentes:</b> ${stats.pendingDepositsCount}  |  ⏳ <b>Alertas:</b> ${stats.waitingAlertsCount}\n` +
    `💳 <b>Gateway ativo:</b> ${modeLabels[runtime.effectivePixMode] || runtime.effectivePixMode}\n\n` +
    `Selecione o módulo que deseja gerenciar:`;

  await renderScreen(ctx, {
    text,
    keyboard: adminHomeKeyboard(stats.pendingDepositsCount, stats.waitingAlertsCount),
    bannerType: null,
    forceNew,
  });
}

async function showConfigMenu(ctx, repo, { forceNew = false } = {}) {
  clearStep(ctx.from.id);
  const runtime = await repo.getRuntimeSettings(config);

  const mask = (v) => (v ? `<code>${escapeHtml(v.slice(0, 6))}…${escapeHtml(v.slice(-4))}</code>` : '<i>Não definido</i>');
  const syncStatus = runtime.syncpayClientId && runtime.syncpayClientSecret ? '🟢 Conectado' : '⚪ Off';
  const pixStatus = runtime.pixKey ? `<code>${escapeHtml(runtime.pixKey)}</code>` : '<i>Não configurada</i>';
  const mpStatus = runtime.mercadoPagoAccessToken ? '🟢 Configurado' : '⚪ Não configurado';
  const channelStatus = runtime.salesChannelId ? `<code>${escapeHtml(runtime.salesChannelId)}</code>` : '<i>Desativado</i>';

  const text =
    `🔧 <b>Configurações ao Vivo • ${escapeHtml(runtime.storeName)}</b>\n\n` +
    `⚡ <b>Gateway SyncPay:</b> ${syncStatus}\n` +
    `   • Client ID: ${mask(runtime.syncpayClientId)}\n` +
    `   • Webhook URL: ${runtime.syncpayWebhookUrl ? `<code>${escapeHtml(runtime.syncpayWebhookUrl)}</code>` : '<i>Não configurada (usando contingência/botão)</i>'}\n` +
    `💳 <b>Chave Pix Manual:</b> ${pixStatus}\n` +
    `💎 <b>Mercado Pago Token:</b> ${mpStatus}\n` +
    `🛟 <b>Suporte:</b> ${escapeHtml(runtime.supportUsername)}\n` +
    `📣 <b>Canal de Vendas:</b> ${channelStatus}\n` +
    `🎁 <b>Cashback VIP:</b> ${runtime.cashbackEnabled ? '🟢 Ativo (2% a 8%)' : '⏸️ Desativado'}\n` +
    `🤝 <b>Comissão Indicação:</b> ${runtime.referralCommissionPct}%`;

  const kb = new InlineKeyboard()
    .text('💰 Ver Saldo SyncPay', 'adm:cfg:syncbal')
    .text('🌐 Webhook SyncPay', 'adm:cfg:syncwh')
    .row()
    .text('⚡ SyncPay ID/Secret', 'adm:cfg:syncpay')
    .text('💳 Chave Pix Manual', 'adm:cfg:pixkey')
    .row()
    .text('🛟 Alterar Suporte', 'adm:cfg:support')
    .text('📣 Canal de Vendas', 'adm:cfg:channel')
    .row()
    .text(runtime.cashbackEnabled ? '⏸️ Desativar Cashback' : '🟢 Ativar Cashback', 'adm:cfg:cashback')
    .text('🤝 % Indicação', 'adm:cfg:refpct')
    .row()
    .text('⬅️ Painel Admin', 'adm:home');

  await renderScreen(ctx, { text, keyboard: kb, bannerType: null, forceNew });
}

async function showUserCard(ctx, repo, targetId, { forceNew = false } = {}) {
  const user = await repo.getUser(targetId);
  if (!user) {
    return ctx.reply(`❌ Nenhum usuário encontrado com o ID <code>${targetId}</code>.`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('⬅️ Painel Admin', 'adm:home'),
    });
  }

  const ordersCount = await repo.countUserOrders(targetId);
  const banLabel = user.is_banned ? '🚫 Banido' : '🟢 Ativo';

  const text =
    `👤 <b>Ficha do Cliente</b>\n\n` +
    `🆔 <b>Telegram ID:</b> <code>${user.telegram_id}</code>\n` +
    `🏷️ <b>Nome:</b> ${formatUserLabel(user)}\n` +
    `📌 <b>Status:</b> ${banLabel}\n` +
    `💰 <b>Saldo atual:</b> <code>${formatBRL(user.balance_cents)}</code>\n` +
    `💳 <b>Total depositado:</b> <code>${formatBRL(user.total_deposited_cents)}</code>\n` +
    `🛍️ <b>Total comprado:</b> <code>${formatBRL(user.total_spent_cents)}</code> (${ordersCount} pedidos)\n` +
    `👥 <b>Indicações:</b> ${user.referrals_count || 0} (<code>${formatBRL(user.referral_earnings_cents || 0)}</code>)`;

  const kb = new InlineKeyboard()
    .text('➕ Adicionar Saldo', `adm:user:addbal:${user.telegram_id}`)
    .text('➖ Remover Saldo', `adm:user:subbal:${user.telegram_id}`)
    .row()
    .text(user.is_banned ? '✅ Desbanir Cliente' : '🚫 Banir Cliente', `adm:user:ban:${user.telegram_id}`)
    .row()
    .text('⬅️ Painel Admin', 'adm:home');

  await renderScreen(ctx, { text, keyboard: kb, bannerType: null, forceNew });
}

export function registerAdminHandlers(bot, repo) {
  bot.command('admin', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await showAdminHome(ctx, repo, { forceNew: true });
  });

  bot.callbackQuery('adm:home', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);
    await showAdminHome(ctx, repo);
  });

  // ==========================================================================
  // 1. ESTATÍSTICAS COMPLETAS
  // ==========================================================================
  bot.callbackQuery('adm:stats', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);

    const s = await repo.getDashboardStats();
    const runtime = await repo.getRuntimeSettings(config);

    let syncBalanceLine = '';
    if (runtime.syncpayClientId && runtime.syncpayClientSecret) {
      try {
        const bal = await getSyncPayBalance({
          clientId: runtime.syncpayClientId,
          clientSecret: runtime.syncpayClientSecret,
        });
        syncBalanceLine = `⚡ <b>Saldo na SyncPay:</b> <code>${formatBRL(Math.round(bal * 100))}</code>\n`;
      } catch {
        syncBalanceLine = `⚡ <b>Saldo na SyncPay:</b> <i>Indisponível agora</i>\n`;
      }
    }

    const outList =
      s.outOfStockProducts.length > 0
        ? s.outOfStockProducts
            .map((p) => {
              const wait = p.waiting_count > 0 ? ` (${p.waiting_count} 🔔 aguardando)` : '';
              return `  • ${escapeHtml(p.name)}${wait}`;
            })
            .join('\n')
        : '  <i>Todos os produtos ativos possuem estoque!</i>';

    const text =
      `📊 <b>Relatório Geral • ${escapeHtml(runtime.storeName)}</b>\n\n` +
      `${syncBalanceLine}` +
      `👥 <b>Total de clientes:</b> ${s.totalUsers}\n` +
      `💼 <b>Saldo em carteiras:</b> <code>${formatBRL(s.totalWalletBalanceCents)}</code>\n` +
      `🏦 <b>Total recarregado:</b> <code>${formatBRL(s.totalDepositedCents)}</code>\n\n` +
      `📅 <b>Vendas Hoje:</b> ${s.todayOrders} pedido(s) • <code>${formatBRL(s.todayRevenueCents)}</code>\n` +
      `🏆 <b>Vendas Totais:</b> ${s.totalOrders} pedido(s) (${s.totalAccountsSold} contas) • <code>${formatBRL(s.totalRevenueCents)}</code>\n\n` +
      `📦 <b>Estoque disponível:</b> ${s.availableStock}  |  <b>Vendidos:</b> ${s.soldStock}\n` +
      `⭐ <b>Avaliações:</b> ${s.reviewsCount > 0 ? `${s.reviewsAverage.toFixed(1)}/5.0 (${s.reviewsCount})` : 'Nenhuma ainda'}\n\n` +
      `⚠️ <b>Produtos ativos sem estoque:</b>\n${outList}`;

    await renderScreen(ctx, {
      text,
      keyboard: new InlineKeyboard()
        .text('🔄 Atualizar', 'adm:stats')
        .text('⬅️ Painel Admin', 'adm:home'),
      bannerType: null,
    });
  });

  // ==========================================================================
  // 2. DEPÓSITOS PENDENTES & APROVAÇÃO 1-CLIQUE
  // ==========================================================================
  bot.callbackQuery('adm:deps', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);

    const pending = await repo.listPendingDeposits({ limit: 15 });
    const kb = new InlineKeyboard();

    for (const dep of pending) {
      kb.text(
        `✅ #${dep.id} ${truncate(dep.first_name, 12)} (${formatBRL(dep.amount_cents)})`,
        `adm:dep:ok:${dep.id}`
      )
        .text('❌', `adm:dep:no:${dep.id}`)
        .row();
    }
    kb.text('🔄 Atualizar', 'adm:deps').text('⬅️ Painel Admin', 'adm:home');

    const text =
      `💰 <b>Depósitos Pix Pendentes (${pending.length})</b>\n\n` +
      (pending.length > 0
        ? `Clique em <b>✅</b> para aprovar (credita saldo / entrega conta direta automaticamente), ou <b>❌</b> para recusar:`
        : `<i>Não há nenhum depósito pendente no momento.</i>`);

    await renderScreen(ctx, { text, keyboard: kb, bannerType: null });
  });

  bot.callbackQuery(/^adm:dep:ok:(\d+)$/, async (ctx) => {
    if (!guardAdmin(ctx)) return;
    const depositId = Number(ctx.match[1]);

    const result = await repo.approveDeposit(depositId, { reviewedBy: ctx.from.id });
    if (!result.approved) {
      return safeAnswer(ctx, {
        text: result.reason === 'ALREADY_PROCESSED' ? 'Este depósito já foi processado.' : 'Depósito não encontrado.',
        show_alert: true,
      });
    }

    await safeAnswer(ctx, { text: `✅ Aprovado! (${formatBRL(result.deposit.amount_cents)})` });
    await handlePostDepositApprovalNotifications(bot, repo, result);

    const msg = ctx.callbackQuery.message;
    if (msg?.photo || msg?.document) {
      const updatedCaption = `${msg.caption || ''}\n\n✅ <b>APROVADO por Admin (${ctx.from.id})</b>`;
      await ctx.editMessageCaption({ caption: updatedCaption, parse_mode: 'HTML' }).catch(() => {});
    } else {
      await showAdminHome(ctx, repo);
    }
  });

  bot.callbackQuery(/^adm:dep:no:(\d+)$/, async (ctx) => {
    if (!guardAdmin(ctx)) return;
    const depositId = Number(ctx.match[1]);

    const res = await repo.markDepositStatus(depositId, 'rejected', { reviewedBy: ctx.from.id });
    if (!res.updated) {
      return safeAnswer(ctx, { text: 'Depósito já foi processado anteriormente.', show_alert: true });
    }

    await safeAnswer(ctx, { text: '❌ Depósito recusado.' });
    const runtime = await repo.getRuntimeSettings(config);

    await bot.api
      .sendMessage(
        res.deposit.user_id,
        `⚠️ <b>Pix #${depositId} (${formatBRL(res.deposit.amount_cents)}) não aprovado.</b>\n` +
          `Caso tenha ocorrido algum engano, fale com nosso suporte: ${escapeHtml(runtime.supportUsername)}`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});

    const msg = ctx.callbackQuery.message;
    if (msg?.photo || msg?.document) {
      const updatedCaption = `${msg.caption || ''}\n\n❌ <b>RECUSADO por Admin (${ctx.from.id})</b>`;
      await ctx.editMessageCaption({ caption: updatedCaption, parse_mode: 'HTML' }).catch(() => {});
    } else {
      await showAdminHome(ctx, repo);
    }
  });

  // ==========================================================================
  // 3. ESTOQUE EM LOTE (COM NOTIFICAÇÃO AUTOMÁTICA DE REPOSIÇÃO!)
  // ==========================================================================
  bot.callbackQuery('adm:stock:menu', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    clearStep(ctx.from.id);
    await safeAnswer(ctx);

    const products = await repo.listAllProducts({ onlyActive: false });
    const kb = new InlineKeyboard();
    for (const p of products) {
      const badge = p.stock_count > 0 ? `🟢 ${p.stock_count}` : '🔴 0';
      kb.text(`${badge} • ${truncate(p.name, 28)}`, `adm:stock:prod:${p.id}`).row();
    }
    kb.text('⬅️ Painel Admin', 'adm:home');

    await renderScreen(ctx, {
      text: `📥 <b>Gerenciar Estoque de Contas</b>\n\nSelecione o produto para adicionar ou limpar unidades disponíveis:`,
      keyboard: kb,
      bannerType: null,
    });
  });

  bot.callbackQuery(/^adm:stock:prod:(\d+)$/, async (ctx) => {
    if (!guardAdmin(ctx)) return;
    clearStep(ctx.from.id);
    await safeAnswer(ctx);
    const productId = Number(ctx.match[1]);
    const prod = await repo.getProduct(productId);
    if (!prod) return;

    const text =
      `📦 <b>Estoque • ${escapeHtml(prod.name)}</b>\n\n` +
      `🏷️ <b>Categoria:</b> ${prod.category_emoji} ${escapeHtml(prod.category_name)}\n` +
      `💵 <b>Preço atual:</b> <code>${formatBRL(prod.price_cents)}</code>\n` +
      `🟢 <b>Unidades disponíveis:</b> <b>${prod.stock_count}</b>`;

    const kb = new InlineKeyboard()
      .text('➕ Adicionar Contas (Lote)', `adm:stock:add:${prod.id}`)
      .row()
      .text('🗑️ Limpar Estoque Disponível', `adm:stock:clear:${prod.id}`)
      .row()
      .text('⬅️ Voltar ao Estoque', 'adm:stock:menu')
      .text('⚙️ Admin', 'adm:home');

    await renderScreen(ctx, { text, keyboard: kb, bannerType: null });
  });

  bot.callbackQuery(/^adm:stock:add:(\d+)$/, async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);
    const productId = Number(ctx.match[1]);
    const prod = await repo.getProduct(productId);
    if (!prod) return;

    setStep(ctx.from.id, 'admin_add_stock', { productId });

    await renderScreen(ctx, {
      text:
        `📥 <b>Adicionar Contas • ${escapeHtml(prod.name)}</b>\n\n` +
        `Envie agora as contas/acessos que deseja colocar no estoque.\n` +
        `👉 <b>Coloque 1 conta por linha</b> (você pode enviar 1 ou dezenas de linhas de uma vez!).\n\n` +
        `<i>Exemplo:</i>\n` +
        `<code>conta1@gmail.com | senha123\nconta2@gmail.com | senha456</code>`,
      keyboard: cancelStepKeyboard(`adm:stock:prod:${prod.id}`),
      bannerType: null,
    });
  });

  bot.callbackQuery(/^adm:stock:clear:(\d+)$/, async (ctx) => {
    if (!guardAdmin(ctx)) return;
    const productId = Number(ctx.match[1]);
    const removed = await repo.clearAvailableStock(productId);
    await safeAnswer(ctx, { text: `🗑️ ${removed} unidade(s) removida(s).`, show_alert: true });
    const prod = await repo.getProduct(productId);

    await renderScreen(ctx, {
      text: `✅ Estoque disponível de <b>${escapeHtml(prod.name)}</b> foi zerado (${removed} removidos).`,
      keyboard: new InlineKeyboard()
        .text('➕ Adicionar Contas (Lote)', `adm:stock:add:${prod.id}`)
        .row()
        .text('⬅️ Voltar ao Estoque', 'adm:stock:menu'),
      bannerType: null,
    });
  });

  // ==========================================================================
  // 4. PRODUTOS (CRIAR, EDITAR PREÇO/NOME/DESCRIÇÃO, PAUSAR, EXCLUIR)
  // ==========================================================================
  bot.callbackQuery('adm:prod:menu', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    clearStep(ctx.from.id);
    await safeAnswer(ctx);

    const products = await repo.listAllProducts({ onlyActive: false });
    const kb = new InlineKeyboard().text('➕ Criar Novo Produto', 'adm:prod:new').row();

    for (const p of products) {
      const icon = p.is_active ? '🟢' : '⏸️';
      kb.text(`${icon} ${truncate(p.name, 24)} • ${formatBRL(p.price_cents)}`, `adm:prod:manage:${p.id}`).row();
    }
    kb.text('⬅️ Painel Admin', 'adm:home');

    await renderScreen(ctx, {
      text: `🏷️ <b>Gerenciar Produtos (${products.length})</b>\n\nClique em um produto para editar, repor estoque, pausar ou excluir:`,
      keyboard: kb,
      bannerType: null,
    });
  });

  bot.callbackQuery('adm:prod:new', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);

    const categories = await repo.listCategories({ onlyActive: false });
    const kb = new InlineKeyboard();
    for (const c of categories) {
      kb.text(`${c.emoji} ${c.name}`, `adm:prod:newcat:${c.id}`).row();
    }
    kb.text('⬅️ Cancelar', 'adm:prod:menu');

    await renderScreen(ctx, {
      text: `➕ <b>Novo Produto • Passo 1/4</b>\n\nEscolha a categoria:`,
      keyboard: kb,
      bannerType: null,
    });
  });

  bot.callbackQuery(/^adm:prod:newcat:(\d+)$/, async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);
    setStep(ctx.from.id, 'admin_new_prod_name', { categoryId: Number(ctx.match[1]) });

    await renderScreen(ctx, {
      text: `➕ <b>Novo Produto • Passo 2/4</b>\n\nDigite o <b>nome do produto</b>:`,
      keyboard: cancelStepKeyboard('adm:prod:menu'),
      bannerType: null,
    });
  });

  bot.callbackQuery(/^adm:prod:manage:(\d+)$/, async (ctx) => {
    if (!guardAdmin(ctx)) return;
    clearStep(ctx.from.id);
    await safeAnswer(ctx);
    const p = await repo.getProduct(Number(ctx.match[1]));
    if (!p) return;

    const text =
      `🏷️ <b>Produto #${p.id}: ${escapeHtml(p.name)}</b>\n\n` +
      `📂 <b>Categoria:</b> ${p.category_emoji} ${escapeHtml(p.category_name)}\n` +
      `📌 <b>Status:</b> ${p.is_active ? '🟢 Visível na Loja' : '⏸️ Oculto'}\n` +
      `💵 <b>Preço:</b> <code>${formatBRL(p.price_cents)}</code>\n` +
      `📦 <b>Estoque:</b> ${p.stock_count}\n` +
      `🛡️ <b>Garantia:</b> ${escapeHtml(p.warranty)}\n\n` +
      `📝 <b>Descrição:</b>\n${escapeHtml(p.description)}`;

    const kb = new InlineKeyboard()
      .text('💲 Alterar Preço', `adm:prod:price:${p.id}`)
      .text('📥 Repor Estoque', `adm:stock:prod:${p.id}`)
      .row()
      .text('✏️ Editar Nome', `adm:prod:edit:name:${p.id}`)
      .text('📝 Editar Descrição', `adm:prod:edit:description:${p.id}`)
      .row()
      .text(p.is_active ? '⏸️ Ocultar' : '🟢 Ativar', `adm:prod:toggle:${p.id}`)
      .text('🗑️ Excluir', `adm:prod:del:${p.id}`)
      .row()
      .text('⬅️ Lista de Produtos', 'adm:prod:menu');

    await renderScreen(ctx, { text, keyboard: kb, bannerType: null });
  });

  bot.callbackQuery(/^adm:prod:price:(\d+)$/, async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);
    const p = await repo.getProduct(Number(ctx.match[1]));
    if (!p) return;

    setStep(ctx.from.id, 'admin_edit_prod_price', { productId: p.id });

    await renderScreen(ctx, {
      text: `💲 <b>Alterar Preço • ${escapeHtml(p.name)}</b>\n\nAtual: <code>${formatBRL(p.price_cents)}</code>\nDigite o novo preço em R$ (ex: <code>29,90</code>):`,
      keyboard: cancelStepKeyboard(`adm:prod:manage:${p.id}`),
      bannerType: null,
    });
  });

  bot.callbackQuery(/^adm:prod:edit:(name|description):(\d+)$/, async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);
    const field = ctx.match[1];
    const productId = Number(ctx.match[2]);
    const p = await repo.getProduct(productId);
    if (!p) return;

    setStep(ctx.from.id, 'admin_edit_prod_field', { productId, field });
    await renderScreen(ctx, {
      text: `✏️ <b>Editar ${field === 'name' ? 'Nome' : 'Descrição'}</b> • ${escapeHtml(p.name)}\n\nDigite o novo conteúdo:`,
      keyboard: cancelStepKeyboard(`adm:prod:manage:${p.id}`),
      bannerType: null,
    });
  });

  bot.callbackQuery(/^adm:prod:toggle:(\d+)$/, async (ctx) => {
    if (!guardAdmin(ctx)) return;
    const updated = await repo.toggleProductActive(Number(ctx.match[1]));
    if (!updated) return;

    await safeAnswer(ctx, {
      text: updated.is_active ? '🟢 Produto ativado!' : '⏸️ Produto ocultado!',
    });

    await renderScreen(ctx, {
      text: `🏷️ <b>${escapeHtml(updated.name)}</b> agora está: <b>${updated.is_active ? '🟢 Visível' : '⏸️ Oculto'}</b>`,
      keyboard: new InlineKeyboard().text('⬅️ Voltar ao Produto', `adm:prod:manage:${updated.id}`),
      bannerType: null,
    });
  });

  bot.callbackQuery(/^adm:prod:del:(\d+)$/, async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);
    const p = await repo.getProduct(Number(ctx.match[1]));
    if (!p) return;

    await renderScreen(ctx, {
      text: `⚠️ <b>Confirmar Exclusão</b>\n\nTem certeza que deseja excluir o produto <b>${escapeHtml(p.name)}</b>?`,
      keyboard: new InlineKeyboard()
        .text('🗑️ Sim, Excluir Agora', `adm:prod:delok:${p.id}`)
        .text('❌ Cancelar', `adm:prod:manage:${p.id}`),
      bannerType: null,
    });
  });

  bot.callbackQuery(/^adm:prod:delok:(\d+)$/, async (ctx) => {
    if (!guardAdmin(ctx)) return;
    const id = Number(ctx.match[1]);
    try {
      await repo.deleteProduct(id);
      await safeAnswer(ctx, { text: '🗑️ Produto excluído!' });
      await showAdminHome(ctx, repo);
    } catch {
      await safeAnswer(ctx, {
        text: 'Este produto já possui pedidos no histórico; use "Ocultar" para tirá-lo da loja.',
        show_alert: true,
      });
    }
  });

  // ==========================================================================
  // 5. CATEGORIAS
  // ==========================================================================
  bot.callbackQuery('adm:cat:menu', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    clearStep(ctx.from.id);
    await safeAnswer(ctx);

    const categories = await repo.listCategories({ onlyActive: false });
    const kb = new InlineKeyboard().text('➕ Criar Nova Categoria', 'adm:cat:new').row();

    for (const c of categories) {
      const status = c.is_active ? '🟢' : '⏸️';
      kb.text(`${status} ${c.emoji} ${c.name}`, `adm:cat:toggle:${c.id}`).row();
    }
    kb.text('⬅️ Painel Admin', 'adm:home');

    await renderScreen(ctx, {
      text: `📂 <b>Gerenciar Categorias (${categories.length})</b>\n\nToque para ativar/ocultar:`,
      keyboard: kb,
      bannerType: null,
    });
  });

  bot.callbackQuery('adm:cat:new', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);
    setStep(ctx.from.id, 'admin_new_cat_name');

    await renderScreen(ctx, {
      text: `📂 <b>Nova Categoria • Passo 1/3</b>\n\nDigite o <b>nome</b>:`,
      keyboard: cancelStepKeyboard('adm:cat:menu'),
      bannerType: null,
    });
  });

  bot.callbackQuery(/^adm:cat:toggle:(\d+)$/, async (ctx) => {
    if (!guardAdmin(ctx)) return;
    const updated = await repo.toggleCategoryActive(Number(ctx.match[1]));
    if (!updated) return;

    await safeAnswer(ctx, {
      text: updated.is_active ? '🟢 Categoria ativada!' : '⏸️ Categoria ocultada!',
    });

    const categories = await repo.listCategories({ onlyActive: false });
    const kb = new InlineKeyboard().text('➕ Criar Nova Categoria', 'adm:cat:new').row();
    for (const c of categories) {
      kb.text(`${c.is_active ? '🟢' : '⏸️'} ${c.emoji} ${c.name}`, `adm:cat:toggle:${c.id}`).row();
    }
    kb.text('⬅️ Painel Admin', 'adm:home');

    await renderScreen(ctx, {
      text: `📂 <b>Gerenciar Categorias (${categories.length})</b>\n\nToque para ativar/ocultar:`,
      keyboard: kb,
      bannerType: null,
    });
  });

  // ==========================================================================
  // 6. CUPONS
  // ==========================================================================
  bot.callbackQuery('adm:cup:menu', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    clearStep(ctx.from.id);
    await safeAnswer(ctx);

    const coupons = await repo.listCoupons(15);
    const listText =
      coupons.length > 0
        ? coupons
            .map((c) => {
              const val = c.type === 'balance' ? formatBRL(c.value) : `${c.value}% OFF`;
              return `• <code>${escapeHtml(c.code)}</code> — <b>${val}</b> (${c.used_count}/${c.max_uses} usos)`;
            })
            .join('\n')
        : '<i>Nenhum cupom criado ainda.</i>';

    const kb = new InlineKeyboard()
      .text('💰 Criar Cupom de Saldo', 'adm:cup:new:balance')
      .text('🏷️ Criar Cupom % OFF', 'adm:cup:new:percent_discount')
      .row()
      .text('⬅️ Painel Admin', 'adm:home');

    await renderScreen(ctx, {
      text: `🎟️ <b>Cupons & Gift Cards</b>\n\n${listText}`,
      keyboard: kb,
      bannerType: null,
    });
  });

  bot.callbackQuery(/^adm:cup:new:(balance|percent_discount)$/, async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);
    const couponType = ctx.match[1];
    setStep(ctx.from.id, 'admin_new_coupon_code', { couponType });

    await renderScreen(ctx, {
      text:
        `🎟️ <b>Novo Cupom (${couponType === 'balance' ? 'Saldo na Carteira' : 'Desconto %'}) • Passo 1/3</b>\n\n` +
        `Digite o <b>código</b> (ex: <code>GEMINI10</code>):`,
      keyboard: cancelStepKeyboard('adm:cup:menu'),
      bannerType: null,
    });
  });

  // ==========================================================================
  // 7. CONFIGURAÇÕES AO VIVO (SYNCPAY, CHAVE PIX, SUPORTE, CANAL, CASHBACK)
  // ==========================================================================
  bot.callbackQuery('adm:cfg:menu', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);
    await showConfigMenu(ctx, repo);
  });

  bot.callbackQuery('adm:cfg:syncbal', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    const runtime = await repo.getRuntimeSettings(config);
    if (!runtime.syncpayClientId || !runtime.syncpayClientSecret) {
      return safeAnswer(ctx, { text: 'Configure Client ID e Client Secret da SyncPay primeiro.', show_alert: true });
    }
    try {
      const bal = await getSyncPayBalance({
        clientId: runtime.syncpayClientId,
        clientSecret: runtime.syncpayClientSecret,
      });
      await safeAnswer(ctx, {
        text: `⚡ Saldo disponível na SyncPay: ${formatBRL(Math.round(bal * 100))}`,
        show_alert: true,
      });
    } catch (err) {
      await safeAnswer(ctx, { text: `Erro SyncPay: ${err.message}`, show_alert: true });
    }
  });

  bot.callbackQuery('adm:cfg:syncpay', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);
    setStep(ctx.from.id, 'admin_set_syncpay_id');
    await renderScreen(ctx, {
      text: `⚡ <b>Configurar SyncPayments • Passo 1/2</b>\n\nCole seu <b>Client ID (pública)</b>:`,
      keyboard: cancelStepKeyboard('adm:cfg:menu'),
      bannerType: null,
    });
  });

  bot.callbackQuery('adm:cfg:syncwh', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);
    setStep(ctx.from.id, 'admin_set_syncpay_webhook');
    await renderScreen(ctx, {
      text:
        `🌐 <b>Configurar Webhook SyncPay</b>\n\n` +
        `Envie a URL pública HTTPS onde este bot recebe webhooks (ex: <code>https://seudominio.com/webhooks/syncpay</code>).\n` +
        `Vou salvar aqui e tentar registrar automaticamente na API da SyncPay!\n\n` +
        `<i>Envie <code>limpar</code> se quiser remover.</i>`,
      keyboard: cancelStepKeyboard('adm:cfg:menu'),
      bannerType: null,
    });
  });

  bot.callbackQuery('adm:cfg:pixkey', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);
    setStep(ctx.from.id, 'admin_set_pix_key');
    await renderScreen(ctx, {
      text: `💳 <b>Chave Pix Manual (Fallback)</b>\n\nDigite a chave Pix (e-mail, CPF/CNPJ, telefone ou aleatória):`,
      keyboard: cancelStepKeyboard('adm:cfg:menu'),
      bannerType: null,
    });
  });

  bot.callbackQuery('adm:cfg:support', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);
    setStep(ctx.from.id, 'admin_set_support');
    await renderScreen(ctx, {
      text: `🛟 <b>Suporte Oficial</b>\n\nDigite o <code>@username</code> de suporte (ex: <code>@ADMNextFund4</code>):`,
      keyboard: cancelStepKeyboard('adm:cfg:menu'),
      bannerType: null,
    });
  });

  bot.callbackQuery('adm:cfg:channel', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);
    setStep(ctx.from.id, 'admin_set_sales_channel');
    await renderScreen(ctx, {
      text:
        `📣 <b>Canal / Grupo de Vendas (Prova Social)</b>\n\n` +
        `Adicione este bot como Admin no seu canal/grupo e envie o <code>@username</code> do canal ou ID (ex: <code>-1001234567890</code>).\n` +
        `Envie <code>desativar</code> para desligar.`,
      keyboard: cancelStepKeyboard('adm:cfg:menu'),
      bannerType: null,
    });
  });

  bot.callbackQuery('adm:cfg:cashback', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    const runtime = await repo.getRuntimeSettings(config);
    await repo.setSetting('cashback_enabled', runtime.cashbackEnabled ? 'false' : 'true');
    await safeAnswer(ctx, {
      text: runtime.cashbackEnabled ? '⏸️ Cashback VIP desativado.' : '🟢 Cashback VIP ativado!',
    });
    await showConfigMenu(ctx, repo);
  });

  bot.callbackQuery('adm:cfg:refpct', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);
    setStep(ctx.from.id, 'admin_set_ref_pct');
    await renderScreen(ctx, {
      text: `🤝 <b>Comissão de Indicação</b>\n\nDigite a porcentagem de comissão em saldo (de <code>0</code> a <code>50</code>):`,
      keyboard: cancelStepKeyboard('adm:cfg:menu'),
      bannerType: null,
    });
  });

  // ==========================================================================
  // 8. BACKUP & RELATÓRIO EM ARQUIVO .TXT
  // ==========================================================================
  bot.callbackQuery('adm:backup', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx, { text: '📄 Gerando relatório e backup...' });
    const runtime = await repo.getRuntimeSettings(config);
    const report = await repo.generateStoreBackupReport(runtime.storeName);
    const filename = `backup-geminihub-${new Date().toISOString().slice(0, 10)}.txt`;

    await ctx.replyWithDocument(new InputFile(Buffer.from(report, 'utf8'), filename), {
      caption: `📄 <b>Backup & Relatório Completo • ${escapeHtml(runtime.storeName)}</b>`,
      parse_mode: 'HTML',
    });
  });

  // ==========================================================================
  // 9. GERENCIAR CLIENTE / SALDO / BAN
  // ==========================================================================
  bot.callbackQuery('adm:user:prompt', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);
    setStep(ctx.from.id, 'admin_lookup_user');

    await renderScreen(ctx, {
      text: `👤 <b>Gerenciar Cliente</b>\n\nDigite o <b>Telegram ID numérico</b> do cliente:`,
      keyboard: cancelStepKeyboard('adm:home'),
      bannerType: null,
    });
  });

  bot.callbackQuery(/^adm:user:(addbal|subbal):(\d+)$/, async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);
    const action = ctx.match[1];
    const targetId = Number(ctx.match[2]);

    setStep(ctx.from.id, 'admin_adjust_user_balance', {
      targetId,
      mode: action === 'addbal' ? 'credit' : 'debit',
    });

    await renderScreen(ctx, {
      text:
        `${action === 'addbal' ? '➕ <b>Adicionar Saldo</b>' : '➖ <b>Remover Saldo</b>'} • Cliente <code>${targetId}</code>\n\n` +
        `Digite o valor em R$ (ex: <code>30,00</code>):`,
      keyboard: cancelStepKeyboard('adm:home'),
      bannerType: null,
    });
  });

  bot.callbackQuery(/^adm:user:ban:(\d+)$/, async (ctx) => {
    if (!guardAdmin(ctx)) return;
    const targetId = Number(ctx.match[1]);
    const user = await repo.getUser(targetId);
    if (!user) return;

    await repo.setUserBanned(targetId, !user.is_banned);
    await safeAnswer(ctx, {
      text: !user.is_banned ? '🚫 Cliente banido.' : '✅ Cliente desbanido.',
    });
    await showUserCard(ctx, repo, targetId);
  });

  // ==========================================================================
  // 10. BROADCAST
  // ==========================================================================
  bot.callbackQuery('adm:broadcast:prompt', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    await safeAnswer(ctx);
    setStep(ctx.from.id, 'admin_broadcast_text');

    await renderScreen(ctx, {
      text: `📢 <b>Aviso Geral (Broadcast)</b>\n\nDigite a mensagem para todos os clientes ativos:`,
      keyboard: cancelStepKeyboard('adm:home'),
      bannerType: null,
    });
  });

  bot.callbackQuery('adm:broadcast:send', async (ctx) => {
    if (!guardAdmin(ctx)) return;
    const session = getSession(ctx.from.id);
    const messageText = session.data?.broadcastText;

    if (!messageText) {
      return safeAnswer(ctx, { text: 'Nenhuma mensagem em espera.', show_alert: true });
    }

    clearStep(ctx.from.id);
    await safeAnswer(ctx, { text: '🚀 Enviando...' });
    const runtime = await repo.getRuntimeSettings(config);

    const userIds = await repo.listAllUserIds({ excludeBanned: true });
    let sentCount = 0;
    let failedCount = 0;

    for (const uid of userIds) {
      try {
        await bot.api.sendMessage(
          uid,
          `📢 <b>Comunicado • ${escapeHtml(runtime.storeName)}</b>\n\n${escapeHtml(messageText)}`,
          { parse_mode: 'HTML' }
        );
        sentCount++;
      } catch {
        failedCount++;
      }
      await new Promise((r) => setTimeout(r, 40));
    }

    await renderScreen(ctx, {
      text: `✅ <b>Broadcast Concluído!</b>\n\n📨 <b>Entregues:</b> ${sentCount}\n⚠️ <b>Bloqueados:</b> ${failedCount}`,
      keyboard: new InlineKeyboard().text('⬅️ Painel Admin', 'adm:home'),
      bannerType: null,
    });
  });
}

/**
 * Processa atalho '⚙️ Painel Admin' e fluxos conversacionais do Admin.
 */
export async function handleAdminStatefulMessage(ctx, bot, repo) {
  const userId = ctx.from?.id;
  if (!userId || !isAdmin(userId)) return false;

  const text = (ctx.message?.text || '').trim();

  if (text === '⚙️ Painel Admin') {
    await showAdminHome(ctx, repo, { forceNew: true });
    return true;
  }

  const session = getSession(userId);
  if (!session.step || !session.step.startsWith('admin_')) return false;

  if (!text) {
    await ctx.reply('⚠️ Por favor, envie uma mensagem em texto.');
    return true;
  }

  // --- Adicionar Estoque em Lote + Notificar inscritos! ---
  if (session.step === 'admin_add_stock') {
    const { productId } = session.data;
    clearStep(userId);

    const lines = text.split(/\r?\n/);
    const res = await repo.addStockBulk(productId, lines);
    const prod = await repo.getProduct(productId);

    let notifiedCount = 0;
    if (res.subscribersToNotify?.length > 0) {
      for (const subId of res.subscribersToNotify) {
        await bot.api
          .sendMessage(
            subId,
            `🔔 <b>Estoque Reposto • ${escapeHtml(prod.name)}!</b>\n\n` +
              `O plano que você estava aguardando acabou de receber <b>${res.added} unidade(s)</b>!\n` +
              `💵 <b>Valor:</b> <code>${formatBRL(prod.price_cents)}</code>`,
            {
              parse_mode: 'HTML',
              reply_markup: new InlineKeyboard().text('⚡ Garantir Agora', `prd:view:${prod.id}:1`),
            }
          )
          .then(() => {
            notifiedCount++;
          })
          .catch(() => {});
      }
    }

    await ctx.reply(
      `✅ <b>Estoque Atualizado com Sucesso!</b>\n\n` +
        `🏷️ <b>Produto:</b> ${escapeHtml(prod.name)}\n` +
        `➕ <b>Contas adicionadas:</b> ${res.added}\n` +
        `🟢 <b>Total disponível:</b> <b>${res.totalAvailable}</b>` +
        (notifiedCount > 0 ? `\n🔔 <b>Clientes avisados da reposição:</b> ${notifiedCount}` : ''),
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('➕ Adicionar Mais', `adm:stock:add:${productId}`)
          .text('⚙️ Painel Admin', 'adm:home'),
      }
    );
    return true;
  }

  // --- SyncPay ID / Secret ---
  if (session.step === 'admin_set_syncpay_id') {
    setStep(userId, 'admin_set_syncpay_secret', { clientId: text });
    await ctx.reply(`⚡ <b>Passo 2/2:</b> Agora cole seu <b>Client Secret (privada)</b>:`, {
      parse_mode: 'HTML',
      reply_markup: cancelStepKeyboard('adm:cfg:menu'),
    });
    return true;
  }

  if (session.step === 'admin_set_syncpay_secret') {
    const { clientId } = session.data;
    clearStep(userId);
    await repo.setSetting('syncpay_client_id', clientId);
    await repo.setSetting('syncpay_client_secret', text);

    try {
      const bal = await getSyncPayBalance({ clientId, clientSecret: text });
      await ctx.reply(
        `✅ <b>SyncPay conectado com sucesso!</b>\nSaldo atual na conta: <code>${formatBRL(Math.round(bal * 100))}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('🔧 Voltar às Configurações', 'adm:cfg:menu'),
        }
      );
    } catch (err) {
      await ctx.reply(`⚠️ Credenciais salvas, mas o teste falhou: <code>${escapeHtml(err.message)}</code>`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('🔧 Voltar às Configurações', 'adm:cfg:menu'),
      });
    }
    return true;
  }

  if (session.step === 'admin_set_syncpay_webhook') {
    clearStep(userId);
    if (text.toLowerCase() === 'limpar') {
      await repo.setSetting('syncpay_webhook_url', '');
      await showConfigMenu(ctx, repo, { forceNew: true });
      return true;
    }
    if (!/^https?:\/\//i.test(text)) {
      await ctx.reply('⚠️ Envie uma URL válida começando com `https://` ou `http://`.');
      return true;
    }

    await repo.setSetting('syncpay_webhook_url', text);
    const runtime = await repo.getRuntimeSettings(config);
    let whNote = 'URL salva no bot.';
    if (runtime.syncpayClientId && runtime.syncpayClientSecret) {
      try {
        const wh = await createSyncPayWebhook({
          clientId: runtime.syncpayClientId,
          clientSecret: runtime.syncpayClientSecret,
          title: 'Gemini Hub Telegram Bot',
          url: text,
          event: 'cashin',
        });
        if (wh?.token) {
          await repo.setSetting('syncpay_webhook_secret', wh.token);
        }
        whNote = 'Webhook registrado na API da SyncPay e token de segurança salvo automaticamente!';
      } catch (err) {
        whNote = `URL salva localmente (registro automático retornou: ${err.message}).`;
      }
    }

    await ctx.reply(`✅ ${escapeHtml(whNote)}`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('🔧 Voltar às Configurações', 'adm:cfg:menu'),
    });
    return true;
  }

  // --- Config Pix Manual / Suporte / Canal / % Indicação ---
  if (session.step === 'admin_set_pix_key') {
    clearStep(userId);
    await repo.setSetting('pix_key', text);
    await ctx.reply(`✅ Chave Pix atualizada para: <code>${escapeHtml(text)}</code>`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('🔧 Voltar às Configurações', 'adm:cfg:menu'),
    });
    return true;
  }

  if (session.step === 'admin_set_support') {
    clearStep(userId);
    const formatted = text.startsWith('@') ? text : `@${text}`;
    await repo.setSetting('support_username', formatted);
    await showConfigMenu(ctx, repo, { forceNew: true });
    return true;
  }

  if (session.step === 'admin_set_sales_channel') {
    clearStep(userId);
    await repo.setSetting('sales_channel_id', text.toLowerCase() === 'desativar' ? '' : text);
    await showConfigMenu(ctx, repo, { forceNew: true });
    return true;
  }

  if (session.step === 'admin_set_ref_pct') {
    const pct = Number(text.replace('%', '').trim());
    if (!Number.isInteger(pct) || pct < 0 || pct > 50) {
      await ctx.reply('⚠️ Digite um número inteiro entre 0 e 50.');
      return true;
    }
    clearStep(userId);
    await repo.setSetting('referral_commission_pct', String(pct));
    await showConfigMenu(ctx, repo, { forceNew: true });
    return true;
  }

  // --- Criar Categoria ---
  if (session.step === 'admin_new_cat_name') {
    setStep(userId, 'admin_new_cat_emoji', { name: text });
    await ctx.reply(`📂 <b>Passo 2/3:</b> Envie um <b>emoji</b> (ex: <code>💎</code>):`, {
      parse_mode: 'HTML',
      reply_markup: cancelStepKeyboard('adm:cat:menu'),
    });
    return true;
  }

  if (session.step === 'admin_new_cat_emoji') {
    setStep(userId, 'admin_new_cat_desc', { ...session.data, emoji: text.slice(0, 8) });
    await ctx.reply(`📂 <b>Passo 3/3:</b> Digite uma descrição (ou <code>.</code>):`, {
      parse_mode: 'HTML',
      reply_markup: cancelStepKeyboard('adm:cat:menu'),
    });
    return true;
  }

  if (session.step === 'admin_new_cat_desc') {
    const { name, emoji } = session.data;
    clearStep(userId);
    try {
      const cat = await repo.createCategory({ name, emoji, description: text === '.' ? '' : text });
      await ctx.reply(`✅ Categoria <b>${cat.emoji} ${escapeHtml(cat.name)}</b> criada!`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('📂 Ver Categorias', 'adm:cat:menu'),
      });
    } catch (err) {
      await ctx.reply(`❌ Erro: ${escapeHtml(err.message)}`);
    }
    return true;
  }

  // --- Criar Produto ---
  if (session.step === 'admin_new_prod_name') {
    setStep(userId, 'admin_new_prod_price', { ...session.data, name: text });
    await ctx.reply(`➕ <b>Passo 3/4:</b> Digite o <b>preço em R$</b> (ex: <code>29,90</code>):`, {
      parse_mode: 'HTML',
      reply_markup: cancelStepKeyboard('adm:prod:menu'),
    });
    return true;
  }

  if (session.step === 'admin_new_prod_price') {
    const priceCents = parseBRLToCents(text);
    if (!priceCents) {
      await ctx.reply(`⚠️ Valor inválido. Digite como <code>29,90</code>.`);
      return true;
    }
    setStep(userId, 'admin_new_prod_desc', { ...session.data, priceCents });
    await ctx.reply(`➕ <b>Passo 4/4:</b> Digite a <b>descrição</b> do produto:`, {
      parse_mode: 'HTML',
      reply_markup: cancelStepKeyboard('adm:prod:menu'),
    });
    return true;
  }

  if (session.step === 'admin_new_prod_desc') {
    const { categoryId, name, priceCents } = session.data;
    clearStep(userId);
    const prod = await repo.createProduct({
      categoryId,
      name,
      description: text === '.' ? '' : text,
      priceCents,
    });

    await ctx.reply(
      `✅ <b>Produto Criado!</b>\n🏷️ ${escapeHtml(prod.name)} • <code>${formatBRL(prod.price_cents)}</code>`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('📥 Adicionar Estoque Agora', `adm:stock:add:${prod.id}`)
          .text('⚙️ Painel Admin', 'adm:home'),
      }
    );
    return true;
  }

  // --- Editar Preço ou Campo ---
  if (session.step === 'admin_edit_prod_price') {
    const { productId } = session.data;
    const priceCents = parseBRLToCents(text);
    if (!priceCents) {
      await ctx.reply(`⚠️ Preço inválido. Exemplo: <code>29,90</code>`);
      return true;
    }
    clearStep(userId);
    const updated = await repo.updateProductPrice(productId, priceCents);
    await ctx.reply(`✅ Preço atualizado para <b>${formatBRL(updated.price_cents)}</b>!`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('⬅️ Voltar ao Produto', `adm:prod:manage:${productId}`),
    });
    return true;
  }

  if (session.step === 'admin_edit_prod_field') {
    const { productId, field } = session.data;
    clearStep(userId);
    const updated = await repo.updateProductField(productId, field, text);
    await ctx.reply(`✅ Produto <b>${escapeHtml(updated.name)}</b> atualizado!`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('⬅️ Voltar ao Produto', `adm:prod:manage:${productId}`),
    });
    return true;
  }

  // --- Cupons ---
  if (session.step === 'admin_new_coupon_code') {
    const code = text.toUpperCase().replace(/\s+/g, '');
    setStep(userId, 'admin_new_coupon_value', { ...session.data, code });
    await ctx.reply(
      session.data.couponType === 'balance'
        ? `💵 <b>Passo 2/3:</b> Valor em R$ (ex: <code>10,00</code>):`
        : `🏷️ <b>Passo 2/3:</b> Porcentagem de 1 a 95 (ex: <code>15</code>):`,
      { parse_mode: 'HTML', reply_markup: cancelStepKeyboard('adm:cup:menu') }
    );
    return true;
  }

  if (session.step === 'admin_new_coupon_value') {
    const { couponType } = session.data;
    let value;
    if (couponType === 'balance') {
      value = parseBRLToCents(text);
      if (!value) {
        await ctx.reply('⚠️ Valor inválido.');
        return true;
      }
    } else {
      const pct = Number(text.replace('%', '').trim());
      if (!Number.isInteger(pct) || pct < 1 || pct > 95) {
        await ctx.reply('⚠️ Digite um número entre 1 e 95.');
        return true;
      }
      value = pct;
    }
    setStep(userId, 'admin_new_coupon_uses', { ...session.data, value });
    await ctx.reply(`🔢 <b>Passo 3/3:</b> Limite máximo de resgates (ex: <code>10</code>):`, {
      parse_mode: 'HTML',
      reply_markup: cancelStepKeyboard('adm:cup:menu'),
    });
    return true;
  }

  if (session.step === 'admin_new_coupon_uses') {
    const maxUses = Number(text);
    if (!Number.isInteger(maxUses) || maxUses < 1) {
      await ctx.reply('⚠️ Digite um inteiro >= 1.');
      return true;
    }
    const { couponType, code, value } = session.data;
    clearStep(userId);
    try {
      const coupon = await repo.createCoupon({ code, type: couponType, value, maxUses });
      await ctx.reply(`🎉 Cupom <code>${escapeHtml(coupon.code)}</code> criado!`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('🎟️ Ver Cupons', 'adm:cup:menu'),
      });
    } catch (err) {
      await ctx.reply(`❌ Erro: ${escapeHtml(err.message)}`);
    }
    return true;
  }

  // --- Consultar Cliente & Ajustar Saldo ---
  if (session.step === 'admin_lookup_user') {
    if (!/^\d+$/.test(text)) {
      await ctx.reply('⚠️ Digite apenas o ID numérico do Telegram.');
      return true;
    }
    clearStep(userId);
    await showUserCard(ctx, repo, Number(text), { forceNew: true });
    return true;
  }

  if (session.step === 'admin_adjust_user_balance') {
    const { targetId, mode } = session.data;
    const cents = parseBRLToCents(text);
    if (!cents) {
      await ctx.reply('⚠️ Valor inválido.');
      return true;
    }
    clearStep(userId);
    const delta = mode === 'credit' ? cents : -cents;
    try {
      const updatedUser = await repo.adjustUserBalance(
        targetId,
        delta,
        mode === 'credit' ? 'Crédito adicionado pela administração' : 'Ajuste pela administração'
      );
      const runtime = await repo.getRuntimeSettings(config);
      await bot.api
        .sendMessage(
          targetId,
          mode === 'credit'
            ? `💎 <b>Você recebeu +${formatBRL(cents)} na ${escapeHtml(runtime.storeName)}!</b>\nNovo saldo: <code>${formatBRL(updatedUser.balance_cents)}</code>`
            : `ℹ️ <b>Ajuste de carteira: -${formatBRL(cents)}</b>\nSaldo atual: <code>${formatBRL(updatedUser.balance_cents)}</code>`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
      await showUserCard(ctx, repo, targetId, { forceNew: true });
    } catch (err) {
      await ctx.reply(`❌ Erro: ${escapeHtml(err.message)}`);
    }
    return true;
  }

  // --- Broadcast ---
  if (session.step === 'admin_broadcast_text') {
    setStep(userId, 'admin_broadcast_confirm', { broadcastText: text });
    const count = (await repo.listAllUserIds({ excludeBanned: true })).length;
    await ctx.reply(
      `📢 <b>Confirmar envio para ${count} cliente(s)?</b>\n\n${escapeHtml(text)}`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text(`🚀 Disparar (${count})`, 'adm:broadcast:send')
          .text('❌ Cancelar', 'adm:home'),
      }
    );
    return true;
  }

  return false;
}
