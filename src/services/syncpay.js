const SYNCPAY_BASE_URL = 'https://api.syncpayments.com.br';

// Cache de token Bearer por client_id (validade oficial: 1 hora / 3600s)
const tokenCache = new Map();

/**
 * Gera um CPF matematicamente válido e determinístico a partir do Telegram ID do cliente
 * (para checkout rápido sem exigir formulário de CPF no chat, atendendo à validação do dígito verificador da SyncPay).
 */
export function generateValidCpfFromSeed(seedNum) {
  const s = String(Math.abs(Number(seedNum) || 123456789) + 100000000)
    .slice(-9)
    .padStart(9, '1');
  const digits = s.split('').map(Number);
  if (digits.every((d) => d === digits[0])) {
    digits[8] = (digits[0] + 1) % 10;
  }

  let sum1 = 0;
  for (let i = 0; i < 9; i++) sum1 += digits[i] * (10 - i);
  let d1 = 11 - (sum1 % 11);
  if (d1 >= 10) d1 = 0;
  digits.push(d1);

  let sum2 = 0;
  for (let i = 0; i < 10; i++) sum2 += digits[i] * (11 - i);
  let d2 = 11 - (sum2 % 11);
  if (d2 >= 10) d2 = 0;
  digits.push(d2);

  return digits.join('');
}

/**
 * Obtém e cacheia o Bearer Token da SyncPayments (POST /api/partner/v1/auth-token).
 * Renova somente quando faltar <= 60s para expirar.
 */
export async function getSyncPayAccessToken({ clientId, clientSecret, forceRefresh = false }) {
  if (!clientId || !clientSecret) {
    throw new Error('SYNCPAY_CLIENT_ID ou SYNCPAY_CLIENT_SECRET não configurados.');
  }

  const cacheKey = `${clientId}:${clientSecret.slice(0, 6)}`;
  const cached = tokenCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAtMs - Date.now() > 60_000) {
    return cached.accessToken;
  }

  const response = await fetch(`${SYNCPAY_BASE_URL}/api/partner/v1/auth-token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const detail = data?.error_description || data?.message || data?.error || `HTTP ${response.status}`;
    throw new Error(`SyncPay Auth erro: ${detail}`);
  }

  const expiresInSec = Number(data.expires_in || 3600);
  const parsedExpiresAt = data.expires_at ? Date.parse(data.expires_at) : NaN;
  const expiresAtMs = Number.isFinite(parsedExpiresAt)
    ? parsedExpiresAt
    : Date.now() + expiresInSec * 1000;

  tokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAtMs,
  });

  return data.access_token;
}

async function syncPayFetch(path, { clientId, clientSecret, method = 'GET', body = null } = {}) {
  let token = await getSyncPayAccessToken({ clientId, clientSecret });

  const doRequest = async (bearer) => {
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${bearer}`,
    };
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
    }

    return fetch(`${SYNCPAY_BASE_URL}${path}`, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
  };

  let res = await doRequest(token);
  if (res.status === 401) {
    token = await getSyncPayAccessToken({ clientId, clientSecret, forceRefresh: true });
    res = await doRequest(token);
  }

  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/**
 * Consulta o saldo da conta parceiro na SyncPayments (GET /api/partner/v1/balance).
 */
export async function getSyncPayBalance({ clientId, clientSecret }) {
  const { ok, status, data } = await syncPayFetch('/api/partner/v1/balance', {
    clientId,
    clientSecret,
    method: 'GET',
  });

  if (!ok) {
    throw new Error(data?.message || `Erro ao consultar saldo SyncPay (HTTP ${status})`);
  }

  return Number(data?.balance ?? 0);
}

/**
 * Cria cobrança Pix CashIn na SyncPayments (POST /api/partner/v1/cash-in).
 */
export async function createSyncPayPix({
  clientId,
  clientSecret,
  amountCents,
  description,
  webhookUrl = '',
  userId,
  clientName = 'Cliente Gemini Hub',
  clientEmail = '',
  clientPhone = '11999999999',
  clientDocument = '',
}) {
  const safeName = String(clientName || 'Cliente Gemini Hub')
    .replace(/[^\p{L}\p{N} .-]/gu, '')
    .trim();

  const payload = {
    amount: Number((amountCents / 100).toFixed(2)),
    description: String(description || 'Gemini Hub Pix').slice(0, 120),
    client: {
      name: safeName.length >= 2 ? safeName.slice(0, 60) : 'Cliente Gemini Hub',
      document: clientDocument || generateValidCpfFromSeed(userId),
      email: clientEmail || `cliente${userId || '0'}@geminihub.store`,
      phone: clientPhone || '11999999999',
    },
  };

  if (webhookUrl && /^https?:\/\//i.test(webhookUrl)) {
    payload.webhook_url = webhookUrl;
  }

  const { ok, status, data } = await syncPayFetch('/api/partner/v1/cash-in', {
    clientId,
    clientSecret,
    method: 'POST',
    body: payload,
  });

  if (!ok || !data?.pix_code || !data?.identifier) {
    const detail = data?.message || JSON.stringify(data?.errors || data || `HTTP ${status}`);
    throw new Error(`SyncPay CashIn erro: ${detail}`);
  }

  return {
    providerPaymentId: String(data.identifier),
    pixCode: String(data.pix_code),
    message: data.message || 'Cashin request successfully submitted',
  };
}

/**
 * Consulta o status da transação na SyncPayments (GET /api/partner/v1/transaction/{identifier}).
 * ATENÇÃO: Limite oficial da SyncPay = MÁXIMO 5 consultas por transação (HTTP 429 na 6ª).
 */
export async function getSyncPayTransactionStatus({ clientId, clientSecret, identifier }) {
  if (!identifier) {
    throw new Error('Identificador SyncPay inválido.');
  }

  const { ok, status, data } = await syncPayFetch(
    `/api/partner/v1/transaction/${encodeURIComponent(identifier)}`,
    {
      clientId,
      clientSecret,
      method: 'GET',
    }
  );

  if (status === 429) {
    const err = new Error('Limite de 5 consultas atingido para este Pix na SyncPay. Aguarde o webhook.');
    err.code = 'RATE_LIMIT_5';
    throw err;
  }

  if (!ok) {
    throw new Error(data?.message || `SyncPay status HTTP ${status}`);
  }

  const tx = data?.data || {};
  return {
    referenceId: tx.reference_id || identifier,
    status: String(tx.status || 'pending').toLowerCase(), // pending, completed, failed, refunded, med
    amount: Number(tx.amount || 0),
    transactionDate: tx.transaction_date || null,
  };
}

/**
 * Registra um webhook na SyncPayments via API (POST /api/partner/v1/webhooks).
 */
export async function createSyncPayWebhook({ clientId, clientSecret, title, url, event = 'cashin' }) {
  const { ok, status, data } = await syncPayFetch('/api/partner/v1/webhooks', {
    clientId,
    clientSecret,
    method: 'POST',
    body: {
      title: title || 'Gemini Hub Bot Webhook',
      url,
      event,
      trigger_all_products: true,
    },
  });

  if (!ok) {
    throw new Error(data?.message || `Erro ao criar webhook SyncPay (HTTP ${status})`);
  }

  return data;
}
