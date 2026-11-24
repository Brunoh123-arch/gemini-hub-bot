import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { config } from '../src/config.js';
import { initDatabase } from '../src/db/database.js';
import { StoreRepository } from '../src/db/repository.js';
import { formatBRL, getVipTier, parseBRLToCents } from '../src/services/format.js';
import {
  computeCrc16Ccitt,
  generatePixPayload,
  generatePixQrCodeBuffer,
  verifyPixPayloadCrc,
} from '../src/services/pix.js';
import { generateValidCpfFromSeed } from '../src/services/syncpay.js';
import { renderAdminDashboardHtml } from '../src/web/adminDashboardHtml.js';
import * as clientHandlers from '../src/bot/clientHandlers.js';
import * as adminHandlers from '../src/bot/adminHandlers.js';

function isValidCpfDigits(cpf) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1+$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(cpf[i]) * (10 - i);
  let d1 = 11 - (sum % 11);
  if (d1 >= 10) d1 = 0;
  if (d1 !== Number(cpf[9])) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(cpf[i]) * (11 - i);
  let d2 = 11 - (sum % 11);
  if (d2 >= 10) d2 = 0;
  return d2 === Number(cpf[10]);
}

test('Ativos oficiais e catálogo inicial somente Gemini Pro e Gemini Ultra', async () => {
  assert.equal(fs.existsSync(config.logoPath), true);
  assert.equal(fs.existsSync(config.bannerHomePath), true);
  assert.equal(fs.existsSync(config.bannerCatalogPath), true);
  assert.equal(typeof clientHandlers.registerClientHandlers, 'function');
  assert.equal(typeof adminHandlers.registerAdminHandlers, 'function');

  const db = await initDatabase(':memory:', { seedDemoData: true });
  const repo = new StoreRepository(db);
  const categories = await repo.listCategories({ onlyActive: true });
  const products = await repo.listAllProducts({ onlyActive: true });

  assert.equal(categories.length, 1);
  assert.equal(products.length, 2);
  assert.match(products[0].name, /Gemini Pro/);
  assert.match(products[1].name, /Gemini Ultra/);
  await db.close();
});

test('Conversão BRL, Níveis VIP e validador determinístico de CPF para SyncPay', () => {
  assert.equal(parseBRLToCents('29,90'), 2990);
  assert.equal(parseBRLToCents('59.90'), 5990);
  assert.equal(parseBRLToCents('R$ 1.250,50'), 125050);
  assert.equal(parseBRLToCents('0'), null);
  assert.match(formatBRL(5990), /59,90/);

  assert.equal(getVipTier(0).cashbackPct, 2);
  assert.equal(getVipTier(5000).cashbackPct, 4);
  assert.equal(getVipTier(15000).cashbackPct, 6);
  assert.equal(getVipTier(30000).cashbackPct, 8);

  for (const seed of [1, 6822023910, 999999999, 111111111]) {
    assert.equal(isValidCpfDigits(generateValidCpfFromSeed(seed)), true);
  }
});

test('Geração de código Pix EMV (BACEN) + CRC16-CCITT + QR Code PNG', async () => {
  assert.equal(computeCrc16Ccitt('123456789'), '29B1');

  const payload = generatePixPayload({
    pixKey: 'pagamentos@geminihub.com',
    merchantName: 'GEMINI HUB DIGITAL',
    merchantCity: 'SAO PAULO',
    amountCents: 2990,
    txid: 'GHDEP0001',
    description: 'Recarga Gemini Hub',
  });

  assert.equal(verifyPixPayloadCrc(payload), true);
  const qrPng = await generatePixQrCodeBuffer(payload);
  assert.equal(qrPng[0], 0x89);
  assert.equal(qrPng[1], 0x50);
});

test('SyncPay Pix Direto no Produto + Aprovação Idempotente + Comissão de Indicação + Cashback VIP', async () => {
  const db = await initDatabase(':memory:', { seedDemoData: true });
  const repo = new StoreRepository(db);

  await repo.upsertUser({ id: 1001, username: 'indicador', first_name: 'Carlos' });
  await repo.upsertUser({ id: 1002, username: 'indicado', first_name: 'Ana' });
  const bind = await repo.bindReferrer(1002, 1001);
  assert.equal(bind.bound, true);

  const [geminiPro] = await repo.listAllProducts({ onlyActive: true });
  await repo.addStockBulk(geminiPro.id, ['pro1@gmail.com | senha123']);

  const dep = await repo.createDeposit({
    userId: 1002,
    amountCents: geminiPro.price_cents,
    method: 'syncpay_pix',
    txid: 'GHSYNCPAY1',
    providerPaymentId: 'uuid-syncpay-1',
    pixCode: '000201...',
    targetProductId: geminiPro.id,
    targetQuantity: 1,
  });

  const approval = await repo.approveDeposit(dep.id);
  assert.equal(approval.approved, true);
  assert.equal(approval.referralReward.referrerId, 1001);
  assert.equal(approval.referralReward.bonusCents, 299);
  assert.equal((await repo.getUser(1001)).balance_cents, 299);
  assert.ok(approval.autoPurchase);
  assert.deepEqual(approval.autoPurchase.credentials, ['pro1@gmail.com | senha123']);
  assert.equal(approval.autoPurchase.cashbackCents, 59);
  assert.equal((await repo.getUser(1002)).balance_cents, 59);

  const duplicate = await repo.approveDeposit(dep.id);
  assert.equal(duplicate.approved, false);
  assert.equal(duplicate.reason, 'ALREADY_PROCESSED');
  assert.equal((await repo.getUser(1001)).balance_cents, 299);

  await db.close();
});

test('Alerta de Reposição (Avise-me), Avaliações Verificadas e Backup', async () => {
  const db = await initDatabase(':memory:', { seedDemoData: true });
  const repo = new StoreRepository(db);

  await repo.upsertUser({ id: 3001, username: 'vip', first_name: 'Fernanda' });
  const products = await repo.listAllProducts({ onlyActive: true });
  const geminiUltra = products[1];

  const sub1 = await repo.subscribeStockAlert(3001, geminiUltra.id);
  assert.equal(sub1.alreadySubscribed, false);
  assert.equal(await repo.isSubscribedStockAlert(3001, geminiUltra.id), true);

  const restock = await repo.addStockBulk(geminiUltra.id, ['ultra1@gmail.com | pass1']);
  assert.deepEqual(restock.subscribersToNotify, [3001]);
  assert.equal(await repo.isSubscribedStockAlert(3001, geminiUltra.id), false);

  await repo.adjustUserBalance(3001, 10000, 'Crédito teste');
  const buy = await repo.purchaseProduct({ userId: 3001, productId: geminiUltra.id, quantity: 1 });
  await repo.saveOrderReview({
    orderId: buy.order.id,
    userId: 3001,
    rating: 5,
    comment: 'Entrega imediata no Gemini Ultra!',
  });

  const summary = await repo.getReviewSummary();
  assert.equal(summary.count, 1);
  assert.equal(summary.average, 5);

  const report = await repo.generateStoreBackupReport('Gemini Hub');
  assert.match(report, /GEMINI HUB/);
  assert.match(report, /Gemini Ultra/);

  const htmlLogin = renderAdminDashboardHtml({ storeName: 'Gemini Hub', authenticated: false });
  assert.match(htmlLogin, /Gemini Hub/);
  assert.match(htmlLogin, /loginForm/);

  await db.close();
});
