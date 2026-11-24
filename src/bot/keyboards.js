import { InlineKeyboard, Keyboard } from 'grammy';
import { formatBRL, truncate } from '../services/format.js';

/**
 * Barra inferior fixa (Reply Keyboard) estilo App nativo para navegação com 1 toque.
 */
export function persistentBottomKeyboard({ isAdminUser = false } = {}) {
  const kb = new Keyboard()
    .text('💎 Catálogo')
    .text('💳 Adicionar Saldo')
    .row()
    .text('📦 Minhas Compras')
    .text('👤 Minha Carteira')
    .row()
    .text('🎁 Indique & Ganhe')
    .text('⭐ Avaliações');

  if (isAdminUser) {
    kb.row().text('⚙️ Painel Admin');
  }

  return kb.resized().persistent();
}

export function mainMenuKeyboard({ isAdminUser = false, supportUsername = '', reviewsCount = 0 } = {}) {
  const revLabel = reviewsCount > 0 ? `⭐ Avaliações (${reviewsCount})` : '⭐ Avaliações';

  const kb = new InlineKeyboard()
    .text('💎 Explorar Planos & Contas', 'cat:list')
    .row()
    .text('💳 Recarregar Pix', 'wal:recharge')
    .text('📦 Minhas Compras', 'ord:list')
    .row()
    .text('👤 Carteira & VIP', 'wal:info')
    .text('🎟️ Usar Cupom', 'cup:prompt')
    .row()
    .text('🎁 Indique & Ganhe', 'ref:menu')
    .text(revLabel, 'rev:list');

  if (supportUsername) {
    const cleanHandle = supportUsername.replace(/^@/, '').trim();
    if (cleanHandle) {
      kb.row().url('🛟 Falar com o Suporte Oficial', `https://t.me/${cleanHandle}`);
    }
  }

  if (isAdminUser) {
    kb.row().text('⚙️ Painel Admin 2.0 • Gemini Hub', 'adm:home');
  }

  return kb;
}

export function categoriesKeyboard(categories) {
  const kb = new InlineKeyboard();
  for (const cat of categories) {
    const stockBadge = cat.available_stock_count > 0 ? `🟢 ${cat.available_stock_count}` : '🔴 0';
    kb.text(`${cat.emoji} ${truncate(cat.name, 26)} (${stockBadge})`, `cat:view:${cat.id}`).row();
  }
  kb.text('💳 Adicionar Saldo', 'wal:recharge').text('🏠 Início', 'nav:home');
  return kb;
}

export function productsKeyboard(products, { singleCategory = false } = {}) {
  const kb = new InlineKeyboard();
  for (const prod of products) {
    const statusDot = prod.stock_count > 0 ? '🟢' : '🔴';
    const label = `${statusDot} ${truncate(prod.name, 24)} • ${formatBRL(prod.price_cents)}`;
    kb.text(label, `prd:view:${prod.id}:1`).row();
  }
  if (singleCategory) {
    kb.text('💳 Adicionar Saldo', 'wal:recharge').text('🏠 Início', 'nav:home');
  } else {
    kb.text('⬅️ Categorias', 'cat:list').text('🏠 Início', 'nav:home');
  }
  return kb;
}

export function productDetailKeyboard({
  product,
  qty,
  quote,
  isSubscribedAlert = false,
}) {
  const kb = new InlineKeyboard();
  const maxQty = Math.min(product.stock_count, 10);

  if (product.stock_count > 0) {
    if (maxQty > 1) {
      const prevQty = Math.max(1, qty - 1);
      const nextQty = Math.min(maxQty, qty + 1);
      kb.text('➖', `prd:view:${product.id}:${prevQty}`)
        .text(`Qtd: ${qty}x`, 'noop')
        .text('➕', `prd:view:${product.id}:${nextQty}`)
        .row();
    }

    if (quote.canAffordWithWallet) {
      kb.text(`⚡ Comprar com Saldo (${formatBRL(quote.totalCents)})`, `prd:confirm:${product.id}:${qty}`).row();
    } else {
      kb.text(`💠 Pagar Direto no Pix (${formatBRL(quote.missingCents)})`, `prd:pixbuy:${product.id}:${qty}`).row();
      kb.text('💳 Recarregar Outro Valor', 'wal:recharge').row();
    }
  } else {
    if (isSubscribedAlert) {
      kb.text('✅ Aviso de Reposição Ativado', 'noop').row();
    } else {
      kb.text('🔔 Avise-me Quando Chegar Estoque', `prd:alert:${product.id}`).row();
    }
  }

  kb.text('🎟️ Aplicar Cupom', 'cup:prompt').row();
  kb.text('⬅️ Voltar', `cat:view:${product.category_id}`).text('🏠 Início', 'nav:home');
  return kb;
}

export function confirmPurchaseKeyboard(product, qty) {
  return new InlineKeyboard()
    .text('✅ Confirmar e Receber Conta Agora', `prd:buy:${product.id}:${qty}`)
    .row()
    .text('⬅️ Voltar ao Produto', `prd:view:${product.id}:${qty}`);
}

export function rechargeAmountsKeyboard() {
  return new InlineKeyboard()
    .text('R$ 15,00', 'wal:amount:1500')
    .text('R$ 29,90', 'wal:amount:2990')
    .row()
    .text('R$ 59,90', 'wal:amount:5990')
    .text('R$ 100,00', 'wal:amount:10000')
    .row()
    .text('✏️ Digitar Outro Valor', 'wal:custom')
    .row()
    .text('🏠 Voltar ao Início', 'nav:home');
}

export function pixPaymentKeyboard(deposit) {
  const kb = new InlineKeyboard();
  if (deposit.method === 'syncpay_pix' || deposit.method === 'mercadopago_pix') {
    kb.text('🔄 Já Paguei • Verificar Agora', `wal:check:${deposit.id}`).row();
  } else {
    kb.text('📎 Enviar Comprovante Pix', `wal:proof:${deposit.id}`).row();
  }
  kb.text('🏠 Menu Principal', 'nav:home:new');
  return kb;
}

export function orderReviewStarsKeyboard(orderId) {
  return new InlineKeyboard()
    .text('⭐ 5 Excelente!', `rev:rate:${orderId}:5`)
    .row()
    .text('4⭐', `rev:rate:${orderId}:4`)
    .text('3⭐', `rev:rate:${orderId}:3`)
    .text('2⭐', `rev:rate:${orderId}:2`)
    .text('1⭐', `rev:rate:${orderId}:1`);
}

export function cancelStepKeyboard(backCallback = 'nav:home') {
  return new InlineKeyboard().text('❌ Cancelar', backCallback);
}

export function adminHomeKeyboard(pendingDepositsCount = 0, waitingAlertsCount = 0) {
  const depBadge = pendingDepositsCount > 0 ? ` (${pendingDepositsCount} 🔔)` : '';
  const stockBadge = waitingAlertsCount > 0 ? ` (${waitingAlertsCount} ⏳)` : '';
  return new InlineKeyboard()
    .text('📊 Dashboard', 'adm:stats')
    .text(`💰 Depósitos${depBadge}`, 'adm:deps')
    .row()
    .text(`📥 Repor Estoque${stockBadge}`, 'adm:stock:menu')
    .text('🏷️ Produtos', 'adm:prod:menu')
    .row()
    .text('📂 Categorias', 'adm:cat:menu')
    .text('🎟️ Cupons', 'adm:cup:menu')
    .row()
    .text('👤 Clientes & Saldo', 'adm:user:prompt')
    .text('🔧 Config Pix & Loja', 'adm:cfg:menu')
    .row()
    .text('📢 Broadcast', 'adm:broadcast:prompt')
    .text('📄 Baixar Backup', 'adm:backup')
    .row()
    .text('🏠 Voltar para a Loja', 'nav:home');
}
