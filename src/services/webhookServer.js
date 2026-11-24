import http from 'node:http';
import { getSyncPayTransactionStatus } from './syncpay.js';

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
 * Servidor HTTP leve para receber Webhooks da SyncPayments (timeout oficial SyncPay = 5s).
 * Responde 200 imediatamente e processa a entrega de forma assíncrona!
 */
export function startWebhookServer({ port, repo, baseConfig, onDepositApproved }) {
  const server = http.createServer(async (req, res) => {
    const reqUrl = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && (reqUrl === '/' || reqUrl === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'Gemini Hub Webhook Server' }));
      return;
    }

    if (req.method === 'POST' && reqUrl === '/webhooks/syncpay') {
      const runtime = await repo.getRuntimeSettings(baseConfig);

      // Se o admin configurou SYNCPAY_WEBHOOK_SECRET, valida o Bearer Token do header Authorization
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

      // Responde 200 imediatamente para nunca estourar o timeout de 5 segundos da SyncPay
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));

      // Processa evento em background
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

          // No contrato cashin.old (payload só com { id }), faz 1 consulta única para confirmar status
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

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`🌐 Webhook Server SyncPay ativo na porta ${port} (POST /webhooks/syncpay)`);
  });

  server.on('error', (err) => {
    console.warn(`⚠️ Não foi possível abrir Webhook Server na porta ${port}: ${err.message}`);
  });

  return server;
}
