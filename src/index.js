import { Bot } from 'grammy';
import { config, isAdmin } from './config.js';
import { initDatabase } from './db/database.js';
import { StoreRepository } from './db/repository.js';
import {
  handleClientStatefulMessage,
  handlePostDepositApprovalNotifications,
  registerClientHandlers,
  showHomeScreen,
} from './bot/clientHandlers.js';
import { handleAdminStatefulMessage, registerAdminHandlers } from './bot/adminHandlers.js';
import { getMercadoPagoPaymentStatus } from './services/mercadopago.js';
import { getSyncPayTransactionStatus } from './services/syncpay.js';
import { startWebhookServer } from './services/webhookServer.js';

function validateStartupConfig() {
  if (!config.botToken || config.botToken === 'SEU_TOKEN_DO_BOTFATHER_AQUI') {
    console.error('\n❌ ERRO: BOT_TOKEN não configurado!');
    console.error('1. Copie o arquivo ".env.example" para ".env"');
    console.error('2. Coloque o token gerado no @BotFather em BOT_TOKEN=...');
    console.error('3. Coloque seu ID numérico do Telegram em ADMIN_IDS=...');
    console.error('4. Execute novamente: npm start\n');
    process.exit(1);
  }
}

async function main() {
  validateStartupConfig();

  const db = await initDatabase({
    databaseUrl: config.databaseUrl,
    dbPath: config.dbPath,
    seedDemoData: config.seedDemoData,
  });
  const repo = new StoreRepository(db);
  const bot = new Bot(config.botToken);

  bot.use(async (ctx, next) => {
    if (ctx.from && !ctx.from.is_bot) {
      const user = await repo.upsertUser(ctx.from);
      const runtime = await repo.getRuntimeSettings(config);
      if (user.is_banned && !isAdmin(user.telegram_id)) {
        if (ctx.callbackQuery) {
          await ctx.answerCallbackQuery({
            text: '⛔ Sua conta está suspensa. Contate o suporte.',
            show_alert: true,
          }).catch(() => {});
        } else {
          await ctx
            .reply(`⛔ Sua conta está suspensa. Em caso de dúvida, fale com ${runtime.supportUsername}.`)
            .catch(() => {});
        }
        return;
      }
    }
    await next();
  });

  registerClientHandlers(bot, repo);
  registerAdminHandlers(bot, repo);

  bot.on('message', async (ctx) => {
    const handledByAdmin = await handleAdminStatefulMessage(ctx, bot, repo);
    if (handledByAdmin) return;

    const handledByClient = await handleClientStatefulMessage(ctx, bot, repo);
    if (handledByClient) return;

    if (ctx.chat?.type === 'private') {
      await showHomeScreen(ctx, repo, { forceNew: true, withBottomBar: true });
    }
  });

  bot.catch((err) => {
    const desc = String(err?.error?.description || err?.message || '');
    if (desc.includes('query is too old')) return;
    console.error('⚠️ Erro tratado no bot:', err.error || err);
  });

  await bot.api
    .setMyCommands([
      { command: 'start', description: 'Abrir loja Gemini Hub' },
      { command: 'menu', description: 'Exibir menu principal e barra rápida' },
      { command: 'meuid', description: 'Ver seu ID numérico do Telegram' },
      { command: 'admin', description: 'Painel administrativo (restrito)' },
    ])
    .catch(() => {});

  const webhookServer = startWebhookServer({
    port: config.webhookPort,
    repo,
    baseConfig: config,
    bot,
    onDepositApproved: async (approvalResult) => {
      await handlePostDepositApprovalNotifications(bot, repo, approvalResult);
    },
  });

  const pollTimer = setInterval(async () => {
    const runtime = await repo.getRuntimeSettings(config);

    // 1) Contingência SyncPay (5 min após criação, máx 3 automáticas de 5 permitidas)
    if (runtime.syncpayClientId && runtime.syncpayClientSecret) {
      try {
        const dueSyncPay = await repo.listSyncPayDepositsDueForContingencyCheck(10);
        for (const dep of dueSyncPay) {
          if (dep.expires_at && new Date(dep.expires_at).getTime() < Date.now()) {
            await repo.markDepositStatus(dep.id, 'expired');
            continue;
          }

          await repo.incrementDepositCheckCount(dep.id);
          const spStatus = await getSyncPayTransactionStatus({
            clientId: runtime.syncpayClientId,
            clientSecret: runtime.syncpayClientSecret,
            identifier: dep.provider_payment_id,
          }).catch(() => null);

          if (!spStatus) continue;

          if (spStatus.status === 'completed') {
            const approved = await repo.approveDeposit(dep.id);
            if (approved.approved) {
              await handlePostDepositApprovalNotifications(bot, repo, approved);
            }
          } else if (spStatus.status === 'failed' || spStatus.status === 'refunded') {
            await repo.markDepositStatus(dep.id, 'rejected');
          }
        }
      } catch (err) {
        console.error('Erro contingência SyncPay:', err.message);
      }
    }

    // 2) Polling Mercado Pago
    if (runtime.mercadoPagoAccessToken) {
      try {
        const pendingMp = await repo.listPendingDeposits({ method: 'mercadopago_pix', limit: 20 });
        for (const dep of pendingMp) {
          if (!dep.provider_payment_id) continue;

          if (dep.expires_at && new Date(dep.expires_at).getTime() < Date.now()) {
            await repo.markDepositStatus(dep.id, 'expired');
            continue;
          }

          const statusRes = await getMercadoPagoPaymentStatus({
            accessToken: runtime.mercadoPagoAccessToken,
            providerPaymentId: dep.provider_payment_id,
          }).catch(() => null);

          if (!statusRes) continue;

          if (statusRes.status === 'approved') {
            const approved = await repo.approveDeposit(dep.id);
            if (approved.approved) {
              await handlePostDepositApprovalNotifications(bot, repo, approved);
            }
          } else if (statusRes.status === 'cancelled' || statusRes.status === 'rejected') {
            await repo.markDepositStatus(dep.id, 'rejected');
          }
        }
      } catch (err) {
        console.error('Erro polling Mercado Pago:', err.message);
      }
    }
  }, Math.max(10_000, config.pixPollIntervalMs));

  const shutdown = async () => {
    console.log('\n🛑 Encerrando Gemini Hub Bot...');
    clearInterval(pollTimer);
    webhookServer.close();
    bot.stop();
    await db.close();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const me = await bot.api.getMe();
  const runtime = await repo.getRuntimeSettings(config);
  console.log('====================================================');
  console.log(`💎 ${runtime.storeName} Bot V2 Pro iniciado com sucesso!`);
  console.log(`🤖 Username: @${me.username}`);
  console.log(`🗄️ Banco de dados: ${db.dialect === 'postgres' ? 'PostgreSQL (Supabase)' : 'SQLite local'}`);
  console.log(`💳 Gateway Pix ativo: ${runtime.effectivePixMode}`);
  console.log(`👑 Admins configurados: ${[...config.adminIds].join(', ') || 'Nenhum'}`);
  console.log('====================================================');

  await bot.start({
    onStart: () => console.log('🚀 Aguardando clientes no Telegram...'),
  });
}

main().catch((err) => {
  console.error('Erro fatal ao iniciar o bot:', err);
  process.exit(1);
});
