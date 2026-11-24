import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function parseAdminIds(raw = '') {
  const ids = new Set();
  for (const part of String(raw).split(',')) {
    const trimmed = part.trim();
    if (/^\d+$/.test(trimmed)) {
      ids.add(Number(trimmed));
    }
  }
  return ids;
}

function parseMoneyToCents(raw, fallbackCents) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallbackCents;
  }
  const normalized = String(raw).replace(',', '.').trim();
  const num = Number(normalized);
  if (!Number.isFinite(num) || num <= 0) {
    return fallbackCents;
  }
  return Math.round(num * 100);
}

export const config = {
  rootDir: ROOT_DIR,
  assetsDir: path.join(ROOT_DIR, 'assets'),
  logoPath: path.join(ROOT_DIR, 'assets', 'logo.jpg'),
  bannerHomePath: path.join(ROOT_DIR, 'assets', 'banner-home.jpg'),
  bannerCatalogPath: path.join(ROOT_DIR, 'assets', 'banner-catalog.jpg'),

  botToken: (process.env.BOT_TOKEN || '').trim(),
  adminIds: parseAdminIds(process.env.ADMIN_IDS),

  storeName: (process.env.STORE_NAME || 'Gemini Hub').trim(),
  supportUsername: (process.env.SUPPORT_USERNAME || '@SuporteGeminiHub').trim(),

  minDepositCents: parseMoneyToCents(process.env.MIN_DEPOSIT_BRL, 500),
  maxDepositCents: parseMoneyToCents(process.env.MAX_DEPOSIT_BRL, 500000),

  pixMode: (process.env.PIX_MODE || 'hybrid').trim().toLowerCase(),

  // SyncPayments (Gateway Pix Oficial)
  syncpayClientId: (process.env.SYNCPAY_CLIENT_ID || '').trim(),
  syncpayClientSecret: (process.env.SYNCPAY_CLIENT_SECRET || '').trim(),
  syncpayWebhookUrl: (process.env.SYNCPAY_WEBHOOK_URL || '').trim(),
  syncpayWebhookSecret: (process.env.SYNCPAY_WEBHOOK_SECRET || '').trim(),
  webhookPort: Number(process.env.PORT || process.env.WEBHOOK_PORT || 3000),

  // Mercado Pago (alternativo)
  mercadoPagoAccessToken: (process.env.MERCADOPAGO_ACCESS_TOKEN || '').trim(),
  pixPollIntervalMs: Math.max(5, Number(process.env.PIX_POLL_INTERVAL_SECONDS || 10)) * 1000,

  // Pix Manual (alternativo)
  pixKey: (process.env.PIX_KEY || '').trim(),
  pixMerchantName: (process.env.PIX_MERCHANT_NAME || 'GEMINI HUB DIGITAL').trim(),
  pixMerchantCity: (process.env.PIX_MERCHANT_CITY || 'SAO PAULO').trim(),

  dbPath: path.resolve(ROOT_DIR, process.env.DB_PATH || './data/geminihub.sqlite'),
  databaseUrl: (process.env.DATABASE_URL || '').trim(),
  seedDemoData: String(process.env.SEED_DEMO_DATA ?? 'true').toLowerCase() !== 'false',
};

export function isAdmin(telegramId) {
  return config.adminIds.has(Number(telegramId));
}

export function getEffectivePixMode() {
  const hasSyncPay = Boolean(config.syncpayClientId && config.syncpayClientSecret);
  const hasMp = Boolean(config.mercadoPagoAccessToken);
  const hasManual = Boolean(config.pixKey && config.pixKey !== 'sua-chave-pix@email.com');

  if (config.pixMode === 'syncpay') {
    return hasSyncPay ? 'syncpay' : 'unconfigured';
  }
  if (config.pixMode === 'auto') {
    return hasMp ? 'auto' : 'unconfigured';
  }
  if (config.pixMode === 'manual') {
    return hasManual ? 'manual' : 'unconfigured';
  }
  // hybrid priority: SyncPayments -> Mercado Pago -> Manual Pix
  if (hasSyncPay) return 'syncpay';
  if (hasMp) return 'auto';
  if (hasManual) return 'manual';
  return 'unconfigured';
}
