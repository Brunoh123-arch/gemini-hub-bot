import crypto from 'node:crypto';
import fs from 'node:fs';
import { InlineKeyboard } from 'grammy';
import { escapeHtml, formatBRL, parseBRLToCents } from '../services/format.js';
import { createSyncPayWebhook, getSyncPayBalance } from '../services/syncpay.js';
import { renderAdminDashboardHtml } from './adminDashboardHtml.js';

const SESSION_COOKIE = 'gh_admin_session';

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function getEffectiveAdminPassword(baseConfig) {
  if (baseConfig.adminWebPassword) return baseConfig.adminWebPassword;
  // Fallback determinístico derivado do botToken caso ADMIN_WEB_PASSWORD não tenha sido definido no .env
  return crypto
    .createHash('sha256')
    .update(`gh-web-admin:${baseConfig.botToken}`)
    .digest('hex')
    .slice(0, 12);
}

function getSigningSecret(baseConfig) {
  return crypto
    .createHash('sha256')
    .update(`gh-cookie-key:${baseConfig.botToken}:${getEffectiveAdminPassword(baseConfig)}`)
    .digest();
}

function createSessionToken(baseConfig) {
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const payload = String(exp);
  const sig = crypto
    .createHmac('sha256', getSigningSecret(baseConfig))
    .update(payload)
    .digest('hex');
  return `${payload}.${sig}`;
}

function verifySessionToken(token, baseConfig) {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const exp = Number(payload);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;

  const expectedSig = crypto
    .createHmac('sha256', getSigningSecret(baseConfig))
    .update(payload)
    .digest('hex');

  const a = Buffer.from(String(sig), 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isAuthenticated(req, baseConfig) {
  const cookies = parseCookies(req);
  if (verifySessionToken(cookies[SESSION_COOKIE], baseConfig)) return true;

  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ')) {
    const provided = auth.slice(7).trim();
    const expected = getEffectiveAdminPassword(baseConfig);
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return false;
}

/**
 * Roteia páginas e APIs do Painel Web Administrativo (/admin, /api/admin/*, /assets/logo.jpg).
 * Retorna true se a requisição foi tratada.
 */
export async function handleWebAdminRequest({
  req,
  res,
  reqUrl,
  readJsonBody,
  repo,
  baseConfig,
  bot,
  onDepositApproved,
}) {
  // Logo oficial para o dashboard web
  if (req.method === 'GET' && reqUrl === '/assets/logo.jpg') {
    if (fs.existsSync(baseConfig.logoPath)) {
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
      });
      fs.createReadStream(baseConfig.logoPath).pipe(res);
      return true;
    }
    res.writeHead(404);
    res.end('Not found');
    return true;
  }

  // Página HTML principal do Painel Admin Web
  if (req.method === 'GET' && (reqUrl === '/admin' || reqUrl === '/admin/')) {
    const authed = isAuthenticated(req, baseConfig);
    const runtime = await repo.getRuntimeSettings(baseConfig);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(
      renderAdminDashboardHtml({
        storeName: runtime.storeName,
        authenticated: authed,
      })
    );
    return true;
  }

  // Login
  if (req.method === 'POST' && reqUrl === '/api/admin/login') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'JSON inválido.' });
      return true;
    }

    const provided = String(body?.password || '');
    const expected = getEffectiveAdminPassword(baseConfig);
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      sendJson(res, 401, { error: 'Senha incorreta.' });
      return true;
    }

    const token = createSessionToken(baseConfig);
    const isHttps =
      req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket?.encrypted);
    const cookieFlags = `HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 3600}${isHttps ? '; Secure' : ''}`;

    sendJson(
      res,
      200,
      { ok: true },
      { 'Set-Cookie': `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieFlags}` }
    );
    return true;
  }

  // Logout
  if (req.method === 'POST' && reqUrl === '/api/admin/logout') {
    sendJson(
      res,
      200,
      { ok: true },
      { 'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0` }
    );
    return true;
  }

  if (!reqUrl.startsWith('/api/admin/')) {
    return false;
  }

  // Proteção obrigatória para todas as rotas /api/admin/*
  if (!isAuthenticated(req, baseConfig)) {
    sendJson(res, 401, { error: 'Não autenticado. Faça login novamente.' });
    return true;
  }

  try {
    // 1) Estado completo do dashboard
    if (req.method === 'GET' && reqUrl === '/api/admin/overview') {
      const urlObj = new URL(req.url, 'http://localhost');
      const userSearch = urlObj.searchParams.get('userSearch') || '';

      const [stats, runtime, categories, products, pendingDeposits, users, recentOrders, coupons] =
        await Promise.all([
          repo.getDashboardStats(),
          repo.getRuntimeSettings(baseConfig),
          repo.listCategories({ onlyActive: false }),
          repo.listAllProducts({ onlyActive: false }),
          repo.listPendingDeposits({ limit: 30 }),
          repo.listUsers({ limit: 40, search: userSearch }),
          repo.listRecentOrders(30),
          repo.listCoupons(30),
        ]);

      let syncpayBalance = null;
      if (runtime.syncpayClientId && runtime.syncpayClientSecret) {
        syncpayBalance = await getSyncPayBalance({
          clientId: runtime.syncpayClientId,
          clientSecret: runtime.syncpayClientSecret,
        }).catch(() => null);
      }

      sendJson(res, 200, {
        stats,
        syncpayBalance,
        settings: {
          storeName: runtime.storeName,
          effectivePixMode: runtime.effectivePixMode,
          syncpayClientId: runtime.syncpayClientId,
          hasSyncpaySecret: Boolean(runtime.syncpayClientSecret),
          syncpayWebhookUrl: runtime.syncpayWebhookUrl,
          pixKey: runtime.pixKey,
          pixMerchantName: runtime.pixMerchantName,
          pixMerchantCity: runtime.pixMerchantCity,
          supportUsername: runtime.supportUsername,
          salesChannelId: runtime.salesChannelId,
          cashbackEnabled: runtime.cashbackEnabled,
          referralCommissionPct: runtime.referralCommissionPct,
        },
        categories,
        products,
        pendingDeposits,
        users,
        recentOrders,
        coupons,
      });
      return true;
    }

    // 2) Backup TXT
    if (req.method === 'GET' && reqUrl === '/api/admin/backup') {
      const runtime = await repo.getRuntimeSettings(baseConfig);
      const report = await repo.generateStoreBackupReport(runtime.storeName);
      const dateStr = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="backup-geminihub-${dateStr}.txt"`,
      });
      res.end(report);
      return true;
    }

    // 3) Estoque por produto (GET / DELETE item / POST bulk / DELETE clear)
    const stockMatch = reqUrl.match(/^\/api\/admin\/products\/(\d+)\/stock$/);
    if (stockMatch) {
      const productId = Number(stockMatch[1]);
      if (req.method === 'GET') {
        const items = await repo.listAvailableStockItems(productId, 200);
        sendJson(res, 200, { items });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const lines = String(body?.lines || '').split(/\r?\n/);
        const result = await repo.addStockBulk(productId, lines);
        const prod = await repo.getProduct(productId);

        let notifiedCount = 0;
        if (bot && result.subscribersToNotify?.length > 0 && prod) {
          for (const subId of result.subscribersToNotify) {
            await bot.api
              .sendMessage(
                subId,
                `🔔 <b>Estoque Reposto • ${escapeHtml(prod.name)}!</b>\n\n` +
                  `O plano que você estava aguardando acabou de receber <b>${result.added} unidade(s)</b>!\n` +
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

        sendJson(res, 200, { ...result, notifiedCount });
        return true;
      }
      if (req.method === 'DELETE') {
        const removed = await repo.clearAvailableStock(productId);
        sendJson(res, 200, { removed });
        return true;
      }
    }

    const stockItemMatch = reqUrl.match(/^\/api\/admin\/stock\/(\d+)$/);
    if (stockItemMatch && req.method === 'DELETE') {
      const deleted = await repo.deleteStockItem(Number(stockItemMatch[1]));
      sendJson(res, 200, { deleted });
      return true;
    }

    // 4) Produtos (POST criar, PATCH editar, DELETE excluir)
    if (req.method === 'POST' && reqUrl === '/api/admin/products') {
      const body = await readJsonBody(req);
      const priceCents = parseBRLToCents(body?.priceBrl);
      if (!body?.categoryId || !body?.name || !priceCents) {
        sendJson(res, 400, { error: 'Categoria, nome e preço válido são obrigatórios.' });
        return true;
      }
      const created = await repo.createProduct({
        categoryId: Number(body.categoryId),
        name: String(body.name),
        description: String(body.description || ''),
        warranty: String(body.warranty || '30 dias de garantia e suporte Gemini Hub'),
        priceCents,
      });
      sendJson(res, 201, { product: created });
      return true;
    }

    const prodMatch = reqUrl.match(/^\/api\/admin\/products\/(\d+)$/);
    if (prodMatch) {
      const productId = Number(prodMatch[1]);
      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        if (body.toggleActive) {
          const updated = await repo.toggleProductActive(productId);
          sendJson(res, 200, { product: updated });
          return true;
        }
        if (body.priceBrl !== undefined) {
          const priceCents = parseBRLToCents(body.priceBrl);
          if (!priceCents) {
            sendJson(res, 400, { error: 'Preço inválido.' });
            return true;
          }
          await repo.updateProductPrice(productId, priceCents);
        }
        if (body.name !== undefined && String(body.name).trim()) {
          await repo.updateProductField(productId, 'name', String(body.name));
        }
        if (body.description !== undefined) {
          await repo.updateProductField(productId, 'description', String(body.description));
        }
        if (body.warranty !== undefined && String(body.warranty).trim()) {
          await repo.updateProductField(productId, 'warranty', String(body.warranty));
        }
        sendJson(res, 200, { product: await repo.getProduct(productId) });
        return true;
      }
      if (req.method === 'DELETE') {
        try {
          await repo.deleteProduct(productId);
          sendJson(res, 200, { deleted: true });
        } catch {
          sendJson(res, 409, {
            error: 'Produto possui pedidos no histórico; use "Ocultar" em vez de excluir.',
          });
        }
        return true;
      }
    }

    // 5) Categorias
    if (req.method === 'POST' && reqUrl === '/api/admin/categories') {
      const body = await readJsonBody(req);
      if (!body?.name) {
        sendJson(res, 400, { error: 'Nome da categoria é obrigatório.' });
        return true;
      }
      const created = await repo.createCategory({
        name: String(body.name),
        emoji: String(body.emoji || '💎'),
        description: String(body.description || ''),
      });
      sendJson(res, 201, { category: created });
      return true;
    }

    const catMatch = reqUrl.match(/^\/api\/admin\/categories\/(\d+)\/toggle$/);
    if (catMatch && req.method === 'POST') {
      const updated = await repo.toggleCategoryActive(Number(catMatch[1]));
      sendJson(res, 200, { category: updated });
      return true;
    }

    // 6) Depósitos Pix (aprovar / recusar)
    const depActionMatch = reqUrl.match(/^\/api\/admin\/deposits\/(\d+)\/(approve|reject)$/);
    if (depActionMatch && req.method === 'POST') {
      const depositId = Number(depActionMatch[1]);
      const action = depActionMatch[2];

      if (action === 'approve') {
        const result = await repo.approveDeposit(depositId, { reviewedBy: 0 });
        if (!result.approved) {
          sendJson(res, 409, { error: 'Depósito já processado ou não encontrado.' });
          return true;
        }
        if (typeof onDepositApproved === 'function') {
          await onDepositApproved(result);
        }
        sendJson(res, 200, { ok: true, result });
        return true;
      }

      const resReject = await repo.markDepositStatus(depositId, 'rejected', { reviewedBy: 0 });
      if (!resReject.updated) {
        sendJson(res, 409, { error: 'Depósito já processado.' });
        return true;
      }
      if (bot) {
        const runtime = await repo.getRuntimeSettings(baseConfig);
        await bot.api
          .sendMessage(
            resReject.deposit.user_id,
            `⚠️ <b>Pix #${depositId} (${formatBRL(resReject.deposit.amount_cents)}) não aprovado.</b>\n` +
              `Fale com nosso suporte se houver dúvidas: ${escapeHtml(runtime.supportUsername)}`,
            { parse_mode: 'HTML' }
          )
          .catch(() => {});
      }
      sendJson(res, 200, { ok: true });
      return true;
    }

    // 7) Clientes (saldo / ban)
    const userActionMatch = reqUrl.match(/^\/api\/admin\/users\/(\d+)\/(balance|ban)$/);
    if (userActionMatch && req.method === 'POST') {
      const targetId = Number(userActionMatch[1]);
      const action = userActionMatch[2];
      const body = await readJsonBody(req);

      if (action === 'ban') {
        const user = await repo.getUser(targetId);
        if (!user) {
          sendJson(res, 404, { error: 'Cliente não encontrado.' });
          return true;
        }
        await repo.setUserBanned(targetId, !user.is_banned);
        sendJson(res, 200, { user: await repo.getUser(targetId) });
        return true;
      }

      const cents = parseBRLToCents(body?.amountBrl);
      if (!cents) {
        sendJson(res, 400, { error: 'Valor inválido.' });
        return true;
      }
      const mode = body?.mode === 'debit' ? 'debit' : 'credit';
      const delta = mode === 'credit' ? cents : -cents;
      const updatedUser = await repo.adjustUserBalance(
        targetId,
        delta,
        mode === 'credit' ? 'Crédito adicionado via Painel Web' : 'Ajuste via Painel Web'
      );

      if (bot) {
        const runtime = await repo.getRuntimeSettings(baseConfig);
        await bot.api
          .sendMessage(
            targetId,
            mode === 'credit'
              ? `💎 <b>Você recebeu +${formatBRL(cents)} na ${escapeHtml(runtime.storeName)}!</b>\nNovo saldo: <code>${formatBRL(updatedUser.balance_cents)}</code>`
              : `ℹ️ <b>Ajuste de carteira: -${formatBRL(cents)}</b>\nSaldo atual: <code>${formatBRL(updatedUser.balance_cents)}</code>`,
            { parse_mode: 'HTML' }
          )
          .catch(() => {});
      }

      sendJson(res, 200, { user: updatedUser });
      return true;
    }

    // 8) Cupons
    if (req.method === 'POST' && reqUrl === '/api/admin/coupons') {
      const body = await readJsonBody(req);
      const type = body?.type === 'percent_discount' ? 'percent_discount' : 'balance';
      const value =
        type === 'balance' ? parseBRLToCents(body?.value) : Math.round(Number(body?.value || 0));
      const maxUses = Math.max(1, Math.round(Number(body?.maxUses || 1)));

      if (!body?.code || !value) {
        sendJson(res, 400, { error: 'Código e valor válidos são obrigatórios.' });
        return true;
      }
      const created = await repo.createCoupon({ code: body.code, type, value, maxUses });
      sendJson(res, 201, { coupon: created });
      return true;
    }

    const cupToggleMatch = reqUrl.match(/^\/api\/admin\/coupons\/(\d+)\/toggle$/);
    if (cupToggleMatch && req.method === 'POST') {
      const coupon = await repo.toggleCouponActive(Number(cupToggleMatch[1]));
      sendJson(res, 200, { coupon });
      return true;
    }

    // 9) Broadcast
    if (req.method === 'POST' && reqUrl === '/api/admin/broadcast') {
      if (!bot) {
        sendJson(res, 500, { error: 'Bot Telegram não conectado.' });
        return true;
      }
      const body = await readJsonBody(req);
      const messageText = String(body?.message || '').trim();
      if (!messageText) {
        sendJson(res, 400, { error: 'Digite uma mensagem para o comunicado.' });
        return true;
      }

      const runtime = await repo.getRuntimeSettings(baseConfig);
      const userIds = await repo.listAllUserIds({ excludeBanned: true });
      let sent = 0;
      let failed = 0;

      for (const uid of userIds) {
        try {
          await bot.api.sendMessage(
            uid,
            `📢 <b>Comunicado • ${escapeHtml(runtime.storeName)}</b>\n\n${escapeHtml(messageText)}`,
            { parse_mode: 'HTML' }
          );
          sent++;
        } catch {
          failed++;
        }
        await new Promise((r) => setTimeout(r, 35));
      }

      sendJson(res, 200, { sent, failed, total: userIds.length });
      return true;
    }

    // 10) Configurações ao vivo
    if (req.method === 'POST' && reqUrl === '/api/admin/settings') {
      const body = await readJsonBody(req);
      const map = [
        ['supportUsername', 'support_username'],
        ['salesChannelId', 'sales_channel_id'],
        ['pixKey', 'pix_key'],
        ['pixMerchantName', 'pix_merchant_name'],
        ['pixMerchantCity', 'pix_merchant_city'],
        ['syncpayClientId', 'syncpay_client_id'],
        ['syncpayWebhookUrl', 'syncpay_webhook_url'],
      ];

      for (const [bodyKey, settingKey] of map) {
        if (body[bodyKey] !== undefined) {
          await repo.setSetting(settingKey, String(body[bodyKey]));
        }
      }
      if (body.syncpayClientSecret !== undefined && String(body.syncpayClientSecret).trim() !== '') {
        await repo.setSetting('syncpay_client_secret', String(body.syncpayClientSecret).trim());
      }
      if (body.cashbackEnabled !== undefined) {
        await repo.setSetting('cashback_enabled', body.cashbackEnabled ? 'true' : 'false');
      }
      if (body.referralCommissionPct !== undefined) {
        const pct = Math.max(0, Math.min(50, Math.round(Number(body.referralCommissionPct) || 0)));
        await repo.setSetting('referral_commission_pct', String(pct));
      }

      if (body.registerSyncpayWebhook && body.syncpayWebhookUrl) {
        const runtime = await repo.getRuntimeSettings(baseConfig);
        if (runtime.syncpayClientId && runtime.syncpayClientSecret) {
          const wh = await createSyncPayWebhook({
            clientId: runtime.syncpayClientId,
            clientSecret: runtime.syncpayClientSecret,
            title: `${runtime.storeName} Web Admin`,
            url: String(body.syncpayWebhookUrl).trim(),
            event: 'cashin',
          });
          if (wh?.token) {
            await repo.setSetting('syncpay_webhook_secret', wh.token);
          }
        }
      }

      sendJson(res, 200, { ok: true });
      return true;
    }

    sendJson(res, 404, { error: 'Endpoint não encontrado.' });
    return true;
  } catch (err) {
    sendJson(res, 500, { error: err?.message || 'Erro interno.' });
    return true;
  }
}
