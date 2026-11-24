import { formatBRL, formatDateBR, getVipTier } from '../services/format.js';

function getStartOfTodayIsoInSaoPaulo() {
  // Calcula meia-noite no fuso de São Paulo (-03:00) e retorna timestamp ISO UTC
  const now = new Date();
  const brDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return new Date(`${brDateStr}T00:00:00-03:00`).toISOString();
}

export class StoreRepository {
  constructor(db) {
    this.db = db;
  }

  // ==========================================================================
  // DYNAMIC SETTINGS (CONFIGURAÇÃO PELO TELEGRAM + CACHE LEVE)
  // ==========================================================================
  async getAllSettingsMap() {
    const rows = await this.db.queryAll('SELECT key, value FROM settings');
    const map = new Map();
    for (const row of rows) {
      map.set(row.key, row.value);
    }
    return map;
  }

  async getSetting(key, fallback = '') {
    const row = await this.db.queryOne('SELECT value FROM settings WHERE key = ?', [String(key)]);
    return row !== undefined && row !== null ? row.value : fallback;
  }

  async setSetting(key, value) {
    await this.db.run(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = CURRENT_TIMESTAMP`,
      [String(key), String(value ?? '').trim()]
    );
  }

  async getRuntimeSettings(baseConfig) {
    const settings = await this.getAllSettingsMap();
    const get = (k, fb) => (settings.has(k) ? settings.get(k) : fb);

    const pixKey = get('pix_key', baseConfig.pixKey);
    const pixMerchantName = get('pix_merchant_name', baseConfig.pixMerchantName);
    const pixMerchantCity = get('pix_merchant_city', baseConfig.pixMerchantCity);
    const syncpayClientId = get('syncpay_client_id', baseConfig.syncpayClientId);
    const syncpayClientSecret = get('syncpay_client_secret', baseConfig.syncpayClientSecret);
    const syncpayWebhookUrl = get('syncpay_webhook_url', baseConfig.syncpayWebhookUrl);
    const syncpayWebhookSecret = get('syncpay_webhook_secret', baseConfig.syncpayWebhookSecret);
    const mpToken = get('mercadopago_access_token', baseConfig.mercadoPagoAccessToken);
    const supportUsername = get('support_username', baseConfig.supportUsername);
    const salesChannelId = get('sales_channel_id', '');
    const referralPctRaw = Number(get('referral_commission_pct', '10'));
    const cashbackEnabled = get('cashback_enabled', 'true') !== 'false';

    const hasValidPixKey = Boolean(pixKey && pixKey !== 'sua-chave-pix@email.com');
    const hasSyncPay = Boolean(syncpayClientId && syncpayClientSecret);

    let effectivePixMode = 'unconfigured';
    if (baseConfig.pixMode === 'syncpay') {
      effectivePixMode = hasSyncPay ? 'syncpay' : 'unconfigured';
    } else if (baseConfig.pixMode === 'auto') {
      effectivePixMode = mpToken ? 'auto' : 'unconfigured';
    } else if (baseConfig.pixMode === 'manual') {
      effectivePixMode = hasValidPixKey ? 'manual' : 'unconfigured';
    } else {
      if (hasSyncPay) effectivePixMode = 'syncpay';
      else if (mpToken) effectivePixMode = 'auto';
      else if (hasValidPixKey) effectivePixMode = 'manual';
    }

    return {
      storeName: baseConfig.storeName,
      pixKey: hasValidPixKey ? pixKey : '',
      pixMerchantName,
      pixMerchantCity,
      syncpayClientId,
      syncpayClientSecret,
      syncpayWebhookUrl,
      syncpayWebhookSecret,
      mercadoPagoAccessToken: mpToken,
      supportUsername,
      salesChannelId,
      referralCommissionPct: Number.isFinite(referralPctRaw) ? Math.max(0, Math.min(50, referralPctRaw)) : 10,
      cashbackEnabled,
      effectivePixMode,
    };
  }

  // ==========================================================================
  // USERS, WALLET & REFERRALS
  // ==========================================================================
  async upsertUser({ id, username = null, first_name = 'Cliente', last_name = null }) {
    const existing = await this.getUser(id);
    await this.db.run(
      `INSERT INTO users (telegram_id, username, first_name, last_name)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET
         username = excluded.username,
         first_name = excluded.first_name,
         last_name = excluded.last_name,
         updated_at = CURRENT_TIMESTAMP`,
      [Number(id), username || null, first_name || 'Cliente', last_name || null]
    );

    const updated = await this.getUser(id);
    return Object.assign(updated, { isNewUser: !existing });
  }

  async bindReferrer(userId, referrerId) {
    const uid = Number(userId);
    const refId = Number(referrerId);
    if (!uid || !refId || uid === refId) {
      return { bound: false };
    }

    return this.db.transaction(async (tx) => {
      const user = await tx.queryOne('SELECT * FROM users WHERE telegram_id = ?', [uid]);
      const referrer = await tx.queryOne('SELECT * FROM users WHERE telegram_id = ?', [refId]);
      if (!user || !referrer || referrer.is_banned) {
        return { bound: false };
      }
      if (user.referred_by || Number(user.total_deposited_cents) > 0 || Number(user.total_spent_cents) > 0) {
        return { bound: false };
      }

      await tx.run('UPDATE users SET referred_by = ? WHERE telegram_id = ?', [refId, uid]);
      await tx.run('UPDATE users SET referrals_count = referrals_count + 1 WHERE telegram_id = ?', [refId]);

      return {
        bound: true,
        referrer: await tx.queryOne('SELECT * FROM users WHERE telegram_id = ?', [refId]),
      };
    });
  }

  async getUser(telegramId) {
    return this.db.queryOne('SELECT * FROM users WHERE telegram_id = ?', [Number(telegramId)]);
  }

  async listAllUserIds({ excludeBanned = true } = {}) {
    const sql = excludeBanned
      ? 'SELECT telegram_id FROM users WHERE is_banned = 0'
      : 'SELECT telegram_id FROM users';
    const rows = await this.db.queryAll(sql);
    return rows.map((row) => Number(row.telegram_id));
  }

  async setUserBanned(telegramId, banned) {
    const res = await this.db.run(
      'UPDATE users SET is_banned = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?',
      [banned ? 1 : 0, Number(telegramId)]
    );
    return res.changes > 0;
  }

  async adjustUserBalance(telegramId, deltaCents, description, { type } = {}) {
    if (!Number.isInteger(deltaCents) || deltaCents === 0) {
      throw new Error('O ajuste de saldo precisa ser um valor inteiro diferente de zero.');
    }

    return this.db.transaction(async (tx) => {
      const user = await tx.queryOne('SELECT * FROM users WHERE telegram_id = ?', [Number(telegramId)]);
      if (!user) {
        throw new Error('Usuário não encontrado no banco de dados.');
      }

      const newBalance = Number(user.balance_cents) + deltaCents;
      if (newBalance < 0) {
        throw new Error('Saldo insuficiente para realizar esse débito.');
      }

      const txType = type || (deltaCents > 0 ? 'admin_credit' : 'admin_debit');

      await tx.run(
        `UPDATE users
         SET balance_cents = ?,
             total_deposited_cents = total_deposited_cents + ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE telegram_id = ?`,
        [newBalance, deltaCents > 0 && txType === 'deposit' ? deltaCents : 0, Number(telegramId)]
      );

      await tx.run(
        `INSERT INTO wallet_transactions (user_id, type, amount_cents, balance_after_cents, description)
         VALUES (?, ?, ?, ?, ?)`,
        [Number(telegramId), txType, deltaCents, newBalance, description]
      );

      return tx.queryOne('SELECT * FROM users WHERE telegram_id = ?', [Number(telegramId)]);
    });
  }

  async getWalletHistory(telegramId, limit = 12) {
    return this.db.queryAll(
      `SELECT * FROM wallet_transactions
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT ?`,
      [Number(telegramId), limit]
    );
  }

  // ==========================================================================
  // CATEGORIES & PRODUCTS
  // ==========================================================================
  async listCategories({ onlyActive = true } = {}) {
    const where = onlyActive ? 'WHERE c.is_active = 1' : '';
    return this.db.queryAll(`
      SELECT
        c.*,
        (
          SELECT COUNT(*)
          FROM products p
          WHERE p.category_id = c.id AND p.is_active = 1
        ) AS active_products_count,
        (
          SELECT COUNT(*)
          FROM stock_items s
          JOIN products p ON p.id = s.product_id
          WHERE p.category_id = c.id AND p.is_active = 1 AND s.status = 'available'
        ) AS available_stock_count
      FROM categories c
      ${where}
      ORDER BY c.sort_order ASC, c.id ASC
    `);
  }

  async getCategory(categoryId) {
    return this.db.queryOne('SELECT * FROM categories WHERE id = ?', [Number(categoryId)]);
  }

  async createCategory({ name, emoji = '📦', description = '', sortOrder = 0 }) {
    const id = await this.db.insertReturningId(
      'INSERT INTO categories (name, emoji, description, sort_order) VALUES (?, ?, ?, ?)',
      [name.trim(), (emoji || '📦').trim(), description.trim(), sortOrder]
    );
    return this.getCategory(id);
  }

  async toggleCategoryActive(categoryId) {
    const cat = await this.getCategory(categoryId);
    if (!cat) return null;
    const next = cat.is_active ? 0 : 1;
    await this.db.run('UPDATE categories SET is_active = ? WHERE id = ?', [next, Number(categoryId)]);
    return this.getCategory(categoryId);
  }

  async deleteCategory(categoryId) {
    const res = await this.db.run('DELETE FROM categories WHERE id = ?', [Number(categoryId)]);
    return res.changes > 0;
  }

  async listProductsByCategory(categoryId, { onlyActive = true } = {}) {
    const activeClause = onlyActive ? 'AND p.is_active = 1' : '';
    return this.db.queryAll(
      `SELECT
        p.*,
        (
          SELECT COUNT(*)
          FROM stock_items s
          WHERE s.product_id = p.id AND s.status = 'available'
        ) AS stock_count
       FROM products p
       WHERE p.category_id = ? ${activeClause}
       ORDER BY p.id ASC`,
      [Number(categoryId)]
    );
  }

  async listAllProducts({ onlyActive = false } = {}) {
    const where = onlyActive ? 'WHERE p.is_active = 1' : '';
    return this.db.queryAll(`
      SELECT
        p.*,
        c.name AS category_name,
        c.emoji AS category_emoji,
        (
          SELECT COUNT(*)
          FROM stock_items s
          WHERE s.product_id = p.id AND s.status = 'available'
        ) AS stock_count
      FROM products p
      JOIN categories c ON c.id = p.category_id
      ${where}
      ORDER BY c.sort_order ASC, p.id ASC
    `);
  }

  async getProduct(productId) {
    return this.db.queryOne(
      `SELECT
        p.*,
        c.name AS category_name,
        c.emoji AS category_emoji,
        (
          SELECT COUNT(*)
          FROM stock_items s
          WHERE s.product_id = p.id AND s.status = 'available'
        ) AS stock_count
       FROM products p
       JOIN categories c ON c.id = p.category_id
       WHERE p.id = ?`,
      [Number(productId)]
    );
  }

  async createProduct({
    categoryId,
    name,
    description = '',
    warranty = 'Garantia de acesso e suporte pós-venda',
    priceCents,
  }) {
    const id = await this.db.insertReturningId(
      'INSERT INTO products (category_id, name, description, warranty, price_cents) VALUES (?, ?, ?, ?, ?)',
      [Number(categoryId), name.trim(), description.trim(), warranty.trim(), Number(priceCents)]
    );
    return this.getProduct(id);
  }

  async updateProductPrice(productId, priceCents) {
    await this.db.run('UPDATE products SET price_cents = ? WHERE id = ?', [Number(priceCents), Number(productId)]);
    return this.getProduct(productId);
  }

  async updateProductField(productId, field, value) {
    const allowed = new Set(['name', 'description', 'warranty']);
    if (!allowed.has(field)) {
      throw new Error('Campo inválido.');
    }
    await this.db.run(`UPDATE products SET ${field} = ? WHERE id = ?`, [String(value).trim(), Number(productId)]);
    return this.getProduct(productId);
  }

  async toggleProductActive(productId) {
    const prod = await this.getProduct(productId);
    if (!prod) return null;
    const next = prod.is_active ? 0 : 1;
    await this.db.run('UPDATE products SET is_active = ? WHERE id = ?', [next, Number(productId)]);
    return this.getProduct(productId);
  }

  async deleteProduct(productId) {
    const res = await this.db.run('DELETE FROM products WHERE id = ?', [Number(productId)]);
    return res.changes > 0;
  }

  // ==========================================================================
  // STOCK MANAGEMENT & RESTOCK ALERTS
  // ==========================================================================
  async addStockBulk(productId, rawLines) {
    const lines = rawLines
      .map((line) => String(line).trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      return {
        added: 0,
        totalAvailable: await this.getAvailableStockCount(productId),
        subscribersToNotify: [],
      };
    }

    return this.db.transaction(async (tx) => {
      const product = await tx.queryOne('SELECT id FROM products WHERE id = ?', [Number(productId)]);
      if (!product) {
        throw new Error('Produto não encontrado.');
      }

      for (const cred of lines) {
        await tx.run('INSERT INTO stock_items (product_id, credential) VALUES (?, ?)', [
          Number(productId),
          cred,
        ]);
      }

      const subRows = await tx.queryAll('SELECT user_id FROM stock_alerts WHERE product_id = ?', [
        Number(productId),
      ]);
      const subscribers = subRows.map((r) => Number(r.user_id));

      if (subscribers.length > 0) {
        await tx.run('DELETE FROM stock_alerts WHERE product_id = ?', [Number(productId)]);
      }

      const countRow = await tx.queryOne(
        "SELECT COUNT(*) AS count FROM stock_items WHERE product_id = ? AND status = 'available'",
        [Number(productId)]
      );

      return {
        added: lines.length,
        totalAvailable: Number(countRow?.count || 0),
        subscribersToNotify: subscribers,
      };
    });
  }

  async subscribeStockAlert(userId, productId) {
    const existing = await this.db.queryOne(
      'SELECT 1 AS ok FROM stock_alerts WHERE product_id = ? AND user_id = ?',
      [Number(productId), Number(userId)]
    );
    if (existing) {
      return { alreadySubscribed: true };
    }
    await this.db.run('INSERT INTO stock_alerts (product_id, user_id) VALUES (?, ?)', [
      Number(productId),
      Number(userId),
    ]);
    return { alreadySubscribed: false };
  }

  async isSubscribedStockAlert(userId, productId) {
    const row = await this.db.queryOne(
      'SELECT 1 AS ok FROM stock_alerts WHERE product_id = ? AND user_id = ?',
      [Number(productId), Number(userId)]
    );
    return Boolean(row);
  }

  async getAvailableStockCount(productId) {
    const row = await this.db.queryOne(
      "SELECT COUNT(*) AS count FROM stock_items WHERE product_id = ? AND status = 'available'",
      [Number(productId)]
    );
    return Number(row?.count || 0);
  }

  async clearAvailableStock(productId) {
    const res = await this.db.run(
      "DELETE FROM stock_items WHERE product_id = ? AND status = 'available'",
      [Number(productId)]
    );
    return res.changes;
  }

  // ==========================================================================
  // PRICING PREVIEW & ATOMIC PURCHASE ENGINE (WITH VIP CASHBACK!)
  // ==========================================================================
  async calculateCheckoutQuote({ userId, product, quantity = 1, discountCouponCode = null, tx = null }) {
    const runner = tx || this.db;
    const qty = Math.max(1, Number(quantity));
    const subtotalCents = product.price_cents * qty;
    let discountCents = 0;
    let appliedCoupon = null;

    if (discountCouponCode) {
      const cleanCode = String(discountCouponCode).trim().toUpperCase();
      const coupon = await runner.queryOne('SELECT * FROM coupons WHERE code = ?', [cleanCode]);
      if (coupon && coupon.is_active && coupon.type === 'percent_discount' && coupon.used_count < coupon.max_uses) {
        const alreadyUsed = await runner.queryOne(
          'SELECT 1 AS ok FROM coupon_redemptions WHERE coupon_id = ? AND user_id = ?',
          [coupon.id, Number(userId)]
        );
        if (!alreadyUsed) {
          discountCents = Math.min(subtotalCents - 1, Math.floor((subtotalCents * coupon.value) / 100));
          appliedCoupon = coupon;
        }
      }
    }

    const totalCents = Math.max(0, subtotalCents - discountCents);
    const user = await runner.queryOne('SELECT * FROM users WHERE telegram_id = ?', [Number(userId)]);
    const userBalance = Number(user?.balance_cents || 0);
    const missingCents = Math.max(0, totalCents - userBalance);

    const cashbackSetting = await runner.queryOne("SELECT value FROM settings WHERE key = 'cashback_enabled'");
    const cashbackEnabled = cashbackSetting ? cashbackSetting.value !== 'false' : true;
    const vip = getVipTier(Number(user?.total_spent_cents || 0));
    const cashbackCents = cashbackEnabled ? Math.floor((totalCents * vip.cashbackPct) / 100) : 0;

    return {
      qty,
      subtotalCents,
      discountCents,
      totalCents,
      userBalance,
      missingCents,
      canAffordWithWallet: userBalance >= totalCents,
      appliedCoupon,
      vip,
      cashbackCents,
    };
  }

  async purchaseProduct({ userId, productId, quantity = 1, discountCouponCode = null }) {
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new Error('Quantidade inválida.');
    }

    return this.db.transaction(async (tx) => {
      const user = await tx.queryOne('SELECT * FROM users WHERE telegram_id = ?', [Number(userId)]);
      if (!user) {
        throw new Error('Usuário não cadastrado. Use /start.');
      }
      if (user.is_banned) {
        throw new Error('Sua conta está suspensa. Entre em contato com o suporte.');
      }

      const product = await tx.queryOne('SELECT * FROM products WHERE id = ?', [Number(productId)]);
      if (!product || !product.is_active) {
        throw new Error('Este produto não está mais disponível no catálogo.');
      }

      const stockLockSuffix = this.db.dialect === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : '';
      const stockRows = await tx.queryAll(
        `SELECT id, credential
         FROM stock_items
         WHERE product_id = ? AND status = 'available'
         ORDER BY id ASC
         LIMIT ?${stockLockSuffix}`,
        [Number(productId), qty]
      );

      if (stockRows.length < qty) {
        throw new Error(
          stockRows.length === 0
            ? 'Este produto acabou de esgotar! Aguarde reposição de estoque.'
            : `Estoque insuficiente. Apenas ${stockRows.length} unidade(s) disponível(is).`
        );
      }

      const quote = await this.calculateCheckoutQuote({
        userId,
        product,
        quantity: qty,
        discountCouponCode,
        tx,
      });

      if (!quote.canAffordWithWallet) {
        const err = new Error('Saldo insuficiente para concluir esta compra.');
        err.code = 'INSUFFICIENT_BALANCE';
        err.missingCents = quote.missingCents;
        err.totalCents = quote.totalCents;
        throw err;
      }

      const balanceAfterDebit = Number(user.balance_cents) - quote.totalCents;
      const finalBalance = balanceAfterDebit + quote.cashbackCents;
      const credentials = stockRows.map((row) => row.credential);

      // 1. Criar pedido
      const orderId = await tx.insertReturningId(
        `INSERT INTO orders (
          user_id, product_id, product_name, quantity,
          unit_price_cents, discount_cents, cashback_cents, total_cents,
          coupon_code, delivered_payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Number(userId),
          product.id,
          product.name,
          qty,
          product.price_cents,
          quote.discountCents,
          quote.cashbackCents,
          quote.totalCents,
          quote.appliedCoupon ? quote.appliedCoupon.code : null,
          JSON.stringify(credentials),
        ]
      );

      // 2. Marcar estoque como vendido
      for (const row of stockRows) {
        const updated = await tx.run(
          `UPDATE stock_items
           SET status = 'sold', order_id = ?, sold_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'available'`,
          [orderId, row.id]
        );
        if (updated.changes !== 1) {
          throw new Error('Conflito de estoque detectado. Tente novamente.');
        }
      }

      // 3. Registrar uso do cupom
      if (quote.appliedCoupon) {
        await tx.run('INSERT INTO coupon_redemptions (coupon_id, user_id) VALUES (?, ?)', [
          quote.appliedCoupon.id,
          Number(userId),
        ]);
        await tx.run('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?', [
          quote.appliedCoupon.id,
        ]);
      }

      // 4. Debitar carteira e somar cashback VIP
      await tx.run(
        `UPDATE users
         SET balance_cents = ?,
             total_spent_cents = total_spent_cents + ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE telegram_id = ?`,
        [finalBalance, quote.totalCents, Number(userId)]
      );

      // 5. Extrato compra
      await tx.run(
        `INSERT INTO wallet_transactions (user_id, type, amount_cents, balance_after_cents, description, reference_id)
         VALUES (?, 'purchase', ?, ?, ?, ?)`,
        [
          Number(userId),
          -quote.totalCents,
          balanceAfterDebit,
          `Compra #${orderId}: ${qty}x ${product.name}`,
          `order:${orderId}`,
        ]
      );

      // 6. Extrato cashback
      if (quote.cashbackCents > 0) {
        await tx.run(
          `INSERT INTO wallet_transactions (user_id, type, amount_cents, balance_after_cents, description, reference_id)
           VALUES (?, 'cashback', ?, ?, ?, ?)`,
          [
            Number(userId),
            quote.cashbackCents,
            finalBalance,
            `Cashback ${quote.vip.name} (${quote.vip.cashbackPct}%) • Pedido #${orderId}`,
            `cashback:${orderId}`,
          ]
        );
      }

      const orderRow = await tx.queryOne('SELECT * FROM orders WHERE id = ?', [orderId]);
      const remainRow = await tx.queryOne(
        "SELECT COUNT(*) AS count FROM stock_items WHERE product_id = ? AND status = 'available'",
        [product.id]
      );

      return {
        order: { ...orderRow, credentials: JSON.parse(orderRow.delivered_payload || '[]') },
        credentials,
        cashbackCents: quote.cashbackCents,
        vipTier: getVipTier(Number(user.total_spent_cents) + quote.totalCents),
        balanceAfterCents: finalBalance,
        remainingStock: Number(remainRow?.count || 0),
      };
    });
  }

  async getOrder(orderId) {
    const row = await this.db.queryOne('SELECT * FROM orders WHERE id = ?', [Number(orderId)]);
    if (!row) return null;
    return {
      ...row,
      credentials: JSON.parse(row.delivered_payload || '[]'),
    };
  }

  async listUserOrders(userId, limit = 15) {
    const rows = await this.db.queryAll(
      `SELECT * FROM orders
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT ?`,
      [Number(userId), limit]
    );
    return rows.map((row) => ({
      ...row,
      credentials: JSON.parse(row.delivered_payload || '[]'),
    }));
  }

  async countUserOrders(userId) {
    const row = await this.db.queryOne('SELECT COUNT(*) AS count FROM orders WHERE user_id = ?', [
      Number(userId),
    ]);
    return Number(row?.count || 0);
  }

  // ==========================================================================
  // DEPOSITS (WALLET RECHARGE & DIRECT PRODUCT PIX!)
  // ==========================================================================
  async createDeposit({
    userId,
    amountCents,
    method,
    txid,
    providerPaymentId = null,
    pixCode,
    expiresAt = null,
    targetProductId = null,
    targetQuantity = 1,
    targetCouponCode = null,
  }) {
    const id = await this.db.insertReturningId(
      `INSERT INTO deposits (
        user_id, amount_cents, method, status, txid,
        provider_payment_id, pix_code, expires_at,
        target_product_id, target_quantity, target_coupon_code
      )
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(userId),
        Number(amountCents),
        method,
        txid,
        providerPaymentId,
        pixCode,
        expiresAt,
        targetProductId ? Number(targetProductId) : null,
        Number(targetQuantity || 1),
        targetCouponCode || null,
      ]
    );

    return this.getDeposit(id);
  }

  async getDeposit(depositId) {
    return this.db.queryOne('SELECT * FROM deposits WHERE id = ?', [Number(depositId)]);
  }

  async getDepositByProviderPaymentId(providerPaymentId) {
    return this.db.queryOne('SELECT * FROM deposits WHERE provider_payment_id = ?', [
      String(providerPaymentId),
    ]);
  }

  async incrementDepositCheckCount(depositId) {
    await this.db.run(
      `UPDATE deposits
       SET status_checks_count = status_checks_count + 1,
           last_checked_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [Number(depositId)]
    );
    return this.getDeposit(depositId);
  }

  /**
   * Contingência SyncPay: respeita intervalo mínimo de 5 minutos e máx 3 checagens automáticas (de 5 permitidas).
   */
  async listSyncPayDepositsDueForContingencyCheck(limit = 10) {
    const fiveMinAgoIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const rows = await this.db.queryAll(
      `SELECT * FROM deposits
       WHERE status = 'pending'
         AND method = 'syncpay_pix'
         AND provider_payment_id IS NOT NULL
         AND status_checks_count < 3
       ORDER BY id ASC
       LIMIT ?`,
      [limit * 2]
    );

    const fiveMinAgoMs = Date.parse(fiveMinAgoIso);
    return rows
      .filter((dep) => {
        const createdMs = new Date(
          String(dep.created_at).includes('T') ? dep.created_at : `${dep.created_at}Z`
        ).getTime();
        if (createdMs > fiveMinAgoMs) return false;
        if (!dep.last_checked_at) return true;
        const checkedMs = new Date(
          String(dep.last_checked_at).includes('T') ? dep.last_checked_at : `${dep.last_checked_at}Z`
        ).getTime();
        return checkedMs <= fiveMinAgoMs;
      })
      .slice(0, limit);
  }

  async attachDepositProof(depositId, { fileId = null, type = 'text', note = '' }) {
    await this.db.run(
      `UPDATE deposits
       SET proof_file_id = ?, proof_type = ?, proof_note = ?
       WHERE id = ? AND status = 'pending'`,
      [fileId, type, note, Number(depositId)]
    );
    return this.getDeposit(depositId);
  }

  async listPendingDeposits({ method = null, limit = 25 } = {}) {
    if (method) {
      return this.db.queryAll(
        `SELECT d.*, u.first_name, u.username
         FROM deposits d
         JOIN users u ON u.telegram_id = d.user_id
         WHERE d.status = 'pending' AND d.method = ?
         ORDER BY d.id ASC
         LIMIT ?`,
        [method, limit]
      );
    }

    return this.db.queryAll(
      `SELECT d.*, u.first_name, u.username
       FROM deposits d
       JOIN users u ON u.telegram_id = d.user_id
       WHERE d.status = 'pending'
       ORDER BY d.id DESC
       LIMIT ?`,
      [limit]
    );
  }

  /**
   * Aprovação IDEMPOTENTE de Pix + comissão automática de Indicação + auto-compra se for Pix Direto!
   */
  async approveDeposit(depositId, { reviewedBy = null } = {}) {
    const txResult = await this.db.transaction(async (tx) => {
      const deposit = await tx.queryOne('SELECT * FROM deposits WHERE id = ?', [Number(depositId)]);
      if (!deposit) {
        return { approved: false, reason: 'NOT_FOUND', deposit: null };
      }
      if (deposit.status !== 'pending') {
        return { approved: false, reason: 'ALREADY_PROCESSED', deposit };
      }

      const updateRes = await tx.run(
        `UPDATE deposits
         SET status = 'approved',
             reviewed_by = ?,
             approved_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'pending'`,
        [reviewedBy ? Number(reviewedBy) : null, Number(depositId)]
      );

      if (updateRes.changes !== 1) {
        return {
          approved: false,
          reason: 'ALREADY_PROCESSED',
          deposit: await tx.queryOne('SELECT * FROM deposits WHERE id = ?', [Number(depositId)]),
        };
      }

      const user = await tx.queryOne('SELECT * FROM users WHERE telegram_id = ?', [deposit.user_id]);
      const newBalance = Number(user.balance_cents) + Number(deposit.amount_cents);

      await tx.run(
        `UPDATE users
         SET balance_cents = ?,
             total_deposited_cents = total_deposited_cents + ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE telegram_id = ?`,
        [newBalance, deposit.amount_cents, deposit.user_id]
      );

      const txDescription =
        deposit.method === 'syncpay_pix'
          ? `Recarga Pix SyncPay #${deposit.id}`
          : deposit.method === 'mercadopago_pix'
            ? `Recarga Pix MercadoPago #${deposit.id}`
            : `Recarga Pix #${deposit.id} (Aprovado)`;

      await tx.run(
        `INSERT INTO wallet_transactions (user_id, type, amount_cents, balance_after_cents, description, reference_id)
         VALUES (?, 'deposit', ?, ?, ?, ?)`,
        [
          deposit.user_id,
          deposit.amount_cents,
          newBalance,
          txDescription,
          `deposit:${deposit.id}`,
        ]
      );

      let referralReward = null;
      const pctRow = await tx.queryOne("SELECT value FROM settings WHERE key = 'referral_commission_pct'");
      const commissionPct = pctRow ? Number(pctRow.value) : 10;

      if (user.referred_by && commissionPct > 0) {
        const referrer = await tx.queryOne('SELECT * FROM users WHERE telegram_id = ?', [
          user.referred_by,
        ]);
        if (referrer && !referrer.is_banned) {
          const bonusCents = Math.floor((Number(deposit.amount_cents) * commissionPct) / 100);
          if (bonusCents > 0) {
            const refNewBalance = Number(referrer.balance_cents) + bonusCents;
            await tx.run(
              `UPDATE users
               SET balance_cents = ?,
                   referral_earnings_cents = referral_earnings_cents + ?,
                   updated_at = CURRENT_TIMESTAMP
               WHERE telegram_id = ?`,
              [refNewBalance, bonusCents, referrer.telegram_id]
            );

            await tx.run(
              `INSERT INTO wallet_transactions (user_id, type, amount_cents, balance_after_cents, description, reference_id)
               VALUES (?, 'referral_bonus', ?, ?, ?, ?)`,
              [
                referrer.telegram_id,
                bonusCents,
                refNewBalance,
                `Comissão de indicação (${commissionPct}%) • Recarga #${deposit.id}`,
                `ref_dep:${deposit.id}`,
              ]
            );

            referralReward = {
              referrerId: Number(referrer.telegram_id),
              bonusCents,
              newBalanceCents: refNewBalance,
            };
          }
        }
      }

      return {
        approved: true,
        deposit: await tx.queryOne('SELECT * FROM deposits WHERE id = ?', [Number(depositId)]),
        user: await tx.queryOne('SELECT * FROM users WHERE telegram_id = ?', [deposit.user_id]),
        referralReward,
      };
    });

    if (!txResult.approved) {
      return txResult;
    }

    let autoPurchase = null;
    let autoPurchaseError = null;
    if (txResult.deposit.target_product_id) {
      try {
        autoPurchase = await this.purchaseProduct({
          userId: txResult.deposit.user_id,
          productId: txResult.deposit.target_product_id,
          quantity: txResult.deposit.target_quantity || 1,
          discountCouponCode: txResult.deposit.target_coupon_code || null,
        });
        txResult.user = await this.getUser(txResult.deposit.user_id);
      } catch (err) {
        autoPurchaseError = err.message;
      }
    }

    return {
      ...txResult,
      autoPurchase,
      autoPurchaseError,
    };
  }

  async markDepositStatus(depositId, status, { reviewedBy = null } = {}) {
    const res = await this.db.run(
      `UPDATE deposits
       SET status = ?, reviewed_by = ?
       WHERE id = ? AND status = 'pending'`,
      [status, reviewedBy ? Number(reviewedBy) : null, Number(depositId)]
    );
    return {
      updated: res.changes === 1,
      deposit: await this.getDeposit(depositId),
    };
  }

  // ==========================================================================
  // COUPONS
  // ==========================================================================
  async createCoupon({ code, type, value, maxUses = 1 }) {
    const normalizedCode = String(code).trim().toUpperCase().replace(/\s+/g, '');
    if (!normalizedCode) throw new Error('Código de cupom inválido.');
    if (type === 'percent_discount' && (value < 1 || value > 95)) {
      throw new Error('Desconto percentual deve estar entre 1% e 95%.');
    }

    const id = await this.db.insertReturningId(
      `INSERT INTO coupons (code, type, value, max_uses)
       VALUES (?, ?, ?, ?)`,
      [normalizedCode, type, Number(value), Number(maxUses)]
    );

    return this.db.queryOne('SELECT * FROM coupons WHERE id = ?', [id]);
  }

  async listCoupons(limit = 20) {
    return this.db.queryAll('SELECT * FROM coupons ORDER BY id DESC LIMIT ?', [limit]);
  }

  async getCouponByCode(code) {
    const normalized = String(code || '').trim().toUpperCase();
    return this.db.queryOne('SELECT * FROM coupons WHERE code = ?', [normalized]);
  }

  async redeemCoupon(userId, rawCode) {
    const code = String(rawCode || '').trim().toUpperCase();
    return this.db.transaction(async (tx) => {
      const coupon = await tx.queryOne('SELECT * FROM coupons WHERE code = ?', [code]);
      if (!coupon || !coupon.is_active) {
        throw new Error('Cupom não encontrado ou expirado.');
      }
      if (coupon.used_count >= coupon.max_uses) {
        throw new Error('Este cupom já atingiu o limite máximo de resgates.');
      }

      const alreadyRedeemed = await tx.queryOne(
        'SELECT 1 AS ok FROM coupon_redemptions WHERE coupon_id = ? AND user_id = ?',
        [coupon.id, Number(userId)]
      );
      if (alreadyRedeemed) {
        throw new Error('Você já utilizou este cupom anteriormente.');
      }

      if (coupon.type === 'percent_discount') {
        return {
          mode: 'percent_discount',
          coupon,
        };
      }

      const user = await tx.queryOne('SELECT * FROM users WHERE telegram_id = ?', [Number(userId)]);
      if (!user) throw new Error('Usuário não encontrado.');

      const newBalance = Number(user.balance_cents) + Number(coupon.value);
      await tx.run('INSERT INTO coupon_redemptions (coupon_id, user_id) VALUES (?, ?)', [
        coupon.id,
        Number(userId),
      ]);
      await tx.run('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?', [coupon.id]);
      await tx.run(
        'UPDATE users SET balance_cents = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?',
        [newBalance, Number(userId)]
      );
      await tx.run(
        `INSERT INTO wallet_transactions (user_id, type, amount_cents, balance_after_cents, description, reference_id)
         VALUES (?, 'coupon_credit', ?, ?, ?, ?)`,
        [
          Number(userId),
          coupon.value,
          newBalance,
          `Resgate do cupom ${coupon.code}`,
          `coupon:${coupon.id}`,
        ]
      );

      return {
        mode: 'balance',
        coupon,
        creditedCents: Number(coupon.value),
        balanceAfterCents: newBalance,
      };
    });
  }

  // ==========================================================================
  // VERIFIED REVIEWS
  // ==========================================================================
  async saveOrderReview({ orderId, userId, rating, comment = '' }) {
    const order = await this.getOrder(orderId);
    if (!order || Number(order.user_id) !== Number(userId)) {
      throw new Error('Pedido inválido para avaliação.');
    }

    const r = Math.max(1, Math.min(5, Number(rating)));
    await this.db.run(
      `INSERT INTO reviews (order_id, user_id, product_name, rating, comment)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(order_id) DO UPDATE SET
         rating = excluded.rating,
         comment = CASE WHEN excluded.comment != '' THEN excluded.comment ELSE reviews.comment END`,
      [Number(orderId), Number(userId), order.product_name, r, String(comment || '').trim().slice(0, 280)]
    );

    return this.db.queryOne('SELECT * FROM reviews WHERE order_id = ?', [Number(orderId)]);
  }

  async getReviewSummary() {
    const row = await this.db.queryOne(`
      SELECT COUNT(*) AS count, COALESCE(AVG(rating), 5.0) AS avg_rating
      FROM reviews
    `);
    return {
      count: Number(row?.count || 0),
      average: Number(row?.avg_rating || 5.0),
    };
  }

  async listRecentReviews(limit = 8) {
    return this.db.queryAll(
      `SELECT r.*, u.first_name, u.username
       FROM reviews r
       JOIN users u ON u.telegram_id = r.user_id
       ORDER BY r.id DESC
       LIMIT ?`,
      [limit]
    );
  }

  // ==========================================================================
  // ADMIN ANALYTICS & REPORT EXPORT
  // ==========================================================================
  async getDashboardStats() {
    const users = await this.db.queryOne(`
      SELECT
        COUNT(*) AS total_users,
        COALESCE(SUM(balance_cents), 0) AS total_wallet_balance_cents,
        COALESCE(SUM(total_deposited_cents), 0) AS total_deposited_cents
      FROM users
    `);

    const ordersAll = await this.db.queryOne(`
      SELECT
        COUNT(*) AS total_orders,
        COALESCE(SUM(quantity), 0) AS total_accounts_sold,
        COALESCE(SUM(total_cents), 0) AS total_revenue_cents
      FROM orders
    `);

    const todayStart = getStartOfTodayIsoInSaoPaulo();
    const ordersToday = await this.db.queryOne(
      `SELECT
        COUNT(*) AS today_orders,
        COALESCE(SUM(total_cents), 0) AS today_revenue_cents
       FROM orders
       WHERE created_at >= ?`,
      [todayStart]
    );

    const stock = await this.db.queryOne(`
      SELECT
        SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available_stock,
        SUM(CASE WHEN status = 'sold' THEN 1 ELSE 0 END) AS sold_stock
      FROM stock_items
    `);

    const pendingDeposits = await this.db.queryOne(
      "SELECT COUNT(*) AS count FROM deposits WHERE status = 'pending'"
    );

    const waitingAlerts = await this.db.queryOne('SELECT COUNT(*) AS count FROM stock_alerts');

    const outOfStockProducts = await this.db.queryAll(`
      SELECT
        p.id,
        p.name,
        (SELECT COUNT(*) FROM stock_alerts a WHERE a.product_id = p.id) AS waiting_count
      FROM products p
      WHERE p.is_active = 1
        AND (SELECT COUNT(*) FROM stock_items s WHERE s.product_id = p.id AND s.status = 'available') = 0
      ORDER BY waiting_count DESC, p.id ASC
    `);

    const reviews = await this.getReviewSummary();

    return {
      totalUsers: Number(users?.total_users || 0),
      totalWalletBalanceCents: Number(users?.total_wallet_balance_cents || 0),
      totalDepositedCents: Number(users?.total_deposited_cents || 0),
      totalOrders: Number(ordersAll?.total_orders || 0),
      totalAccountsSold: Number(ordersAll?.total_accounts_sold || 0),
      totalRevenueCents: Number(ordersAll?.total_revenue_cents || 0),
      todayOrders: Number(ordersToday?.today_orders || 0),
      todayRevenueCents: Number(ordersToday?.today_revenue_cents || 0),
      availableStock: Number(stock?.available_stock || 0),
      soldStock: Number(stock?.sold_stock || 0),
      pendingDepositsCount: Number(pendingDeposits?.count || 0),
      waitingAlertsCount: Number(waitingAlerts?.count || 0),
      reviewsCount: reviews.count,
      reviewsAverage: reviews.average,
      outOfStockProducts,
    };
  }

  async generateStoreBackupReport(storeName = 'Gemini Hub') {
    const stats = await this.getDashboardStats();
    const products = await this.listAllProducts({ onlyActive: false });
    const availableItems = await this.db.queryAll(`
      SELECT s.id, p.name AS product_name, s.credential, s.created_at
      FROM stock_items s
      JOIN products p ON p.id = s.product_id
      WHERE s.status = 'available'
      ORDER BY p.id ASC, s.id ASC
    `);
    const recentOrders = await this.db.queryAll(`
      SELECT o.id, o.user_id, o.product_name, o.quantity, o.total_cents, o.created_at
      FROM orders o
      ORDER BY o.id DESC
      LIMIT 50
    `);

    let out = '';
    out += `============================================================\n`;
    out += `  RELATÓRIO & BACKUP DE ESTOQUE — ${storeName.toUpperCase()}\n`;
    out += `  Gerado em: ${formatDateBR(new Date())}\n`;
    out += `============================================================\n\n`;
    out += `RESUMO GERAL:\n`;
    out += `- Total de clientes: ${stats.totalUsers}\n`;
    out += `- Pedidos concluídos: ${stats.totalOrders} (${stats.totalAccountsSold} contas entregues)\n`;
    out += `- Faturamento total: ${formatBRL(stats.totalRevenueCents)}\n`;
    out += `- Saldo em carteiras: ${formatBRL(stats.totalWalletBalanceCents)}\n`;
    out += `- Estoque disponível: ${stats.availableStock}\n\n`;

    out += `CATÁLOGO DE PRODUTOS (${products.length}):\n`;
    for (const p of products) {
      out += `[#${p.id}] ${p.is_active ? '[ATIVO]' : '[OCULTO]'} ${p.category_name} > ${p.name} — ${formatBRL(p.price_cents)} (Estoque: ${p.stock_count})\n`;
    }

    out += `\nESTOQUE DISPONÍVEL (${availableItems.length} itens):\n`;
    if (availableItems.length === 0) {
      out += `(Nenhum item disponível em estoque no momento)\n`;
    } else {
      for (const item of availableItems) {
        out += `[${item.product_name}] ${item.credential}\n`;
      }
    }

    out += `\nÚLTIMOS PEDIDOS (até 50):\n`;
    if (recentOrders.length === 0) {
      out += `(Nenhum pedido realizado ainda)\n`;
    } else {
      for (const ord of recentOrders) {
        out += `#${ord.id} | Cliente ${ord.user_id} | ${ord.quantity}x ${ord.product_name} | ${formatBRL(ord.total_cents)} | ${formatDateBR(ord.created_at)}\n`;
      }
    }

    return out;
  }
}
