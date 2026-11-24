import http from 'node:http';
import { getSyncPayTransactionStatus } from './syncpay.js';
import { handleWebAdminRequest } from '../web/adminRoutes.js';

function readJsonBody(req, maxBytes = 1024 * 512) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });

    req.on('error', reject);
  });
}

/**
 * Servidor HTTP unificado:
 * - GET/HEAD / e /health -> Health Check (Render + UptimeRobot)
 * - POST /webhooks/syncpay -> Webhook instantâneo SyncPayments (responde <5s)
 * - GET /admin + /api/admin/* -> Painel Administrativo Web completo
 */
export function startWebhookServer({ port, repo, baseConfig, bot = null, onDepositApproved }) {
  const server = http.createServer(async (req, res) => {
    const reqUrl = (req.url || '/').split('?')[0];

    if ((req.method === 'GET' || req.method === 'HEAD') && (reqUrl === '/' || reqUrl === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(JSON.stringify({ ok: true, service: 'Gemini Hub Webhook & Web Admin Server' }));
      }
      return;
    }

    if (req.method === 'POST' && reqUrl === '/webhooks/syncpay') {
      const runtime = await repo.getRuntimeSettings(baseConfig);

      if (runtime.syncpayWebhookSecret) {
        const authHeader = String(req.headers.authorization || '');
        const expected = `Bearer ${runtime.syncpayWebhookSecret}`;
        if (authHeader !== expected) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

      let payload;
      try {
        payload = await readJsonBody(req);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));

      setImmediate(async () => {
        try {
          const txId = String(
            payload?.id ||
              payload?.identifier ||
              payload?.reference_id ||
              payload?.data?.id ||
              payload?.data?.reference_id ||
              ''
          ).trim();

          if (!txId) return;

          const deposit = await repo.getDepositByProviderPaymentId(txId);
          if (!deposit || deposit.status !== 'pending') return;

          let status = String(payload?.status || payload?.data?.status || '').toLowerCase();

          if (!status && runtime.syncpayClientId && runtime.syncpayClientSecret) {
            if (deposit.status_checks_count < 5) {
              await repo.incrementDepositCheckCount(deposit.id);
              const checkRes = await getSyncPayTransactionStatus({
                clientId: runtime.syncpayClientId,
                clientSecret: runtime.syncpayClientSecret,
                identifier: txId,
              }).catch(() => null);
              status = checkRes?.status || '';
            }
          }

          if (status === 'completed' || status === 'paid' || status === 'approved') {
            const approved = await repo.approveDeposit(deposit.id);
            if (approved.approved && typeof onDepositApproved === 'function') {
              await onDepositApproved(approved);
            }
          } else if (status === 'failed' || status === 'refunded' || status === 'cancelled') {
            await repo.markDepositStatus(deposit.id, 'rejected');
          }
        } catch (err) {
          console.error('⚠️ Erro ao processar webhook SyncPay:', err.message);
        }
      });
      return;
    }

    const handledByWebAdmin = await handleWebAdminRequest({
      req,
      res,
      reqUrl,
      readJsonBody,
      repo,
      baseConfig,
      bot,
      onDepositApproved,
    });
    if (handledByWebAdmin) return;

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`🌐 Webhook & Painel Web Admin ativos na porta ${port} (/admin e /webhooks/syncpay)`);
  });

  server.on('error', (err) => {
    console.warn(`⚠️ Não foi possível abrir servidor HTTP na porta ${port}: ${err.message}`);
  });

  return server;
}
