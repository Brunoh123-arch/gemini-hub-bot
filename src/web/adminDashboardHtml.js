function escapeText(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderAdminDashboardHtml({ storeName = 'Gemini Hub', authenticated = false }) {
  const safeStore = escapeText(storeName);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeStore} — Painel Admin Web</title>
  <style>
    :root {
      --bg: #050711;
      --bg-2: #0a0f24;
      --card: rgba(15, 22, 48, 0.78);
      --card-border: rgba(92, 225, 255, 0.16);
      --text: #f8fafc;
      --muted: #94a3b8;
      --cyan: #5ce1ff;
      --blue: #4285f4;
      --violet: #a855f7;
      --green: #22c55e;
      --red: #ef4444;
      --amber: #f59e0b;
      --grad: linear-gradient(135deg, #5ce1ff 0%, #4285f4 45%, #8b5cf6 100%);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background:
        radial-gradient(circle at 12% 10%, rgba(66, 133, 244, 0.22), transparent 42%),
        radial-gradient(circle at 88% 82%, rgba(168, 85, 247, 0.18), transparent 44%),
        var(--bg);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.45;
    }
    .container { max-width: 1220px; margin: 0 auto; padding: 20px 16px 48px; }
    .glass {
      background: var(--card);
      border: 1px solid var(--card-border);
      backdrop-filter: blur(16px);
      border-radius: 18px;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.42);
    }
    .topbar {
      display: flex; align-items: center; justify-content: space-between; gap: 14px;
      padding: 14px 20px; margin-bottom: 18px; flex-wrap: wrap;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand img { width: 44px; height: 44px; border-radius: 12px; object-fit: cover; border: 1px solid rgba(92,225,255,0.35); }
    .brand h1 { font-size: 1.15rem; font-weight: 700; letter-spacing: -0.02em; }
    .brand span { font-size: 0.78rem; color: var(--cyan); display: block; }
    .top-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

    .btn {
      border: 1px solid rgba(148,163,184,0.22);
      background: rgba(255,255,255,0.05);
      color: var(--text);
      padding: 9px 14px;
      border-radius: 11px;
      font-size: 0.86rem;
      font-weight: 600;
      cursor: pointer;
      transition: 0.16s ease;
      text-decoration: none;
      display: inline-flex; align-items: center; gap: 6px;
    }
    .btn:hover { background: rgba(255,255,255,0.11); transform: translateY(-1px); }
    .btn-primary { background: var(--grad); border: none; color: #040814; }
    .btn-primary:hover { filter: brightness(1.08); }
    .btn-danger { background: rgba(239, 68, 68, 0.16); border-color: rgba(239, 68, 68, 0.4); color: #fca5a5; }
    .btn-success { background: rgba(34, 197, 94, 0.16); border-color: rgba(34, 197, 94, 0.4); color: #86efac; }
    .btn-sm { padding: 6px 10px; font-size: 0.78rem; border-radius: 8px; }

    .tabs {
      display: flex; gap: 8px; overflow-x: auto; padding-bottom: 6px; margin-bottom: 18px;
      scrollbar-width: thin;
    }
    .tab-btn {
      white-space: nowrap;
      padding: 9px 15px;
      border-radius: 12px;
      background: rgba(15, 22, 48, 0.7);
      border: 1px solid rgba(148, 163, 184, 0.16);
      color: var(--muted);
      font-weight: 600;
      font-size: 0.86rem;
      cursor: pointer;
    }
    .tab-btn.active {
      background: linear-gradient(135deg, rgba(92,225,255,0.22), rgba(139,92,246,0.22));
      border-color: rgba(92, 225, 255, 0.55);
      color: var(--text);
    }

    .grid-kpi {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(195px, 1fr));
      gap: 14px;
      margin-bottom: 18px;
    }
    .kpi { padding: 16px 18px; }
    .kpi .label { font-size: 0.78rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .kpi .val { font-size: 1.45rem; font-weight: 700; margin-top: 6px; }
    .kpi .sub { font-size: 0.78rem; color: var(--cyan); margin-top: 4px; }

    .panel { padding: 20px; margin-bottom: 18px; }
    .panel h2 { font-size: 1.05rem; margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }

    .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .field label { display: block; font-size: 0.78rem; color: var(--muted); margin-bottom: 5px; font-weight: 600; }
    input, select, textarea {
      width: 100%;
      background: rgba(5, 8, 22, 0.85);
      border: 1px solid rgba(148, 163, 184, 0.24);
      border-radius: 10px;
      color: var(--text);
      padding: 10px 12px;
      font-size: 0.9rem;
      font-family: inherit;
    }
    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: var(--cyan);
      box-shadow: 0 0 0 3px rgba(92, 225, 255, 0.14);
    }
    textarea { min-height: 110px; resize: vertical; }

    table { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid rgba(148,163,184,0.12); vertical-align: middle; }
    th { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .table-wrap { overflow-x: auto; }

    .badge {
      display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 0.74rem; font-weight: 700;
    }
    .b-green { background: rgba(34,197,94,0.16); color: #86efac; }
    .b-red { background: rgba(239,68,68,0.16); color: #fca5a5; }
    .b-cyan { background: rgba(92,225,255,0.16); color: #67e8f9; }
    .b-amber { background: rgba(245,158,11,0.18); color: #fcd34d; }

    .login-wrap {
      max-width: 420px; margin: 9vh auto 0; padding: 28px; text-align: center;
    }
    .login-wrap img { width: 82px; height: 82px; border-radius: 20px; margin-bottom: 14px; border: 1px solid rgba(92,225,255,0.4); }
    .login-wrap h1 { font-size: 1.4rem; margin-bottom: 6px; }
    .login-wrap p { color: var(--muted); font-size: 0.9rem; margin-bottom: 20px; }

    .toast {
      position: fixed; bottom: 20px; right: 20px; z-index: 99;
      padding: 12px 16px; border-radius: 12px; font-size: 0.88rem; font-weight: 600;
      background: #0f172a; border: 1px solid var(--cyan); color: var(--text);
      box-shadow: 0 12px 35px rgba(0,0,0,0.5);
      display: none;
    }
    .hidden { display: none !important; }
    code { background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 6px; font-size: 0.82rem; }
  </style>
</head>
<body>
  <div class="container">
    <!-- TELA DE LOGIN -->
    <div id="loginView" class="glass login-wrap ${authenticated ? 'hidden' : ''}">
      <img src="/assets/logo.jpg" alt="${safeStore}" />
      <h1>${safeStore} • Admin Web</h1>
      <p>Controle estoque, preços, Pix SyncPay, clientes e avisos pelo navegador.</p>
      <form id="loginForm">
        <div class="field" style="text-align:left; margin-bottom:14px;">
          <label>Senha do Painel Admin</label>
          <input type="password" id="loginPassword" placeholder="Digite sua senha de administrador" required />
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%; justify-content:center; padding:11px;">
          🔓 Entrar no Painel
        </button>
      </form>
      <div id="loginErr" style="color:#fca5a5; font-size:0.84rem; margin-top:12px;"></div>
    </div>

    <!-- DASHBOARD PRINCIPAL -->
    <div id="appView" class="${authenticated ? '' : 'hidden'}">
      <div class="glass topbar">
        <div class="brand">
          <img src="/assets/logo.jpg" alt="${safeStore}" />
          <div>
            <h1>${safeStore} • Central Web</h1>
            <span id="gatewayStatusBadge">Carregando status...</span>
          </div>
        </div>
        <div class="top-actions">
          <button class="btn" onclick="loadOverview()">🔄 Atualizar</button>
          <a class="btn" href="/api/admin/backup" target="_blank">📄 Backup .txt</a>
          <button class="btn btn-danger" onclick="logout()">Sair</button>
        </div>
      </div>

      <div class="tabs">
        <button class="tab-btn active" data-tab="tabOverview" onclick="switchTab(this)">📊 Visão Geral</button>
        <button class="tab-btn" data-tab="tabStock" onclick="switchTab(this)">📥 Estoque</button>
        <button class="tab-btn" data-tab="tabProducts" onclick="switchTab(this)">🏷️ Produtos & Preços</button>
        <button class="tab-btn" data-tab="tabDeposits" onclick="switchTab(this)">💰 Depósitos Pix <span id="depBadge"></span></button>
        <button class="tab-btn" data-tab="tabUsers" onclick="switchTab(this)">👤 Clientes</button>
        <button class="tab-btn" data-tab="tabCoupons" onclick="switchTab(this)">🎟️ Cupons</button>
        <button class="tab-btn" data-tab="tabBroadcast" onclick="switchTab(this)">📢 Broadcast</button>
        <button class="tab-btn" data-tab="tabSettings" onclick="switchTab(this)">🔧 Config SyncPay & Loja</button>
      </div>

      <!-- TAB 1: VISÃO GERAL -->
      <div id="tabOverview" class="tab-pane">
        <div class="grid-kpi" id="kpiGrid"></div>
        <div class="glass panel">
          <h2>🛍️ Últimos Pedidos Entregues</h2>
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>#</th><th>Cliente</th><th>Plano</th><th>Qtd</th><th>Total</th><th>Data</th></tr>
              </thead>
              <tbody id="recentOrdersBody"></tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- TAB 2: ESTOQUE -->
      <div id="tabStock" class="tab-pane hidden">
        <div class="glass panel">
          <h2>📥 Repor Contas em Lote</h2>
          <div class="form-grid" style="margin-bottom:12px;">
            <div class="field">
              <label>Produto para abastecer</label>
              <select id="stockProductSelect" onchange="loadProductStock()"></select>
            </div>
          </div>
          <div class="field" style="margin-bottom:12px;">
            <label>Cole as contas / acessos (1 conta por linha)</label>
            <textarea id="bulkStockText" placeholder="conta1@gmail.com | senha123&#10;conta2@gmail.com | senha456"></textarea>
          </div>
          <div style="display:flex; gap:10px; flex-wrap:wrap;">
            <button class="btn btn-primary" onclick="addBulkStock()">➕ Adicionar Contas ao Estoque</button>
            <button class="btn btn-danger" onclick="clearProductStock()">🗑️ Zerar Estoque deste Produto</button>
          </div>
        </div>

        <div class="glass panel">
          <h2>📦 Itens Disponíveis neste Produto (<span id="stockListCount">0</span>)</h2>
          <div class="table-wrap">
            <table>
              <thead><tr><th>ID</th><th>Credencial</th><th>Ação</th></tr></thead>
              <tbody id="stockItemsBody"></tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- TAB 3: PRODUTOS & CATEGORIAS -->
      <div id="tabProducts" class="tab-pane hidden">
        <div class="glass panel">
          <h2>🏷️ Produtos Cadastrados</h2>
          <div id="productsList"></div>
        </div>

        <div class="glass panel">
          <h2>➕ Criar Novo Produto</h2>
          <div class="form-grid">
            <div class="field"><label>Categoria</label><select id="newProdCat"></select></div>
            <div class="field"><label>Nome</label><input id="newProdName" placeholder="Ex: Gemini Ultra — 30 Dias" /></div>
            <div class="field"><label>Preço (R$)</label><input id="newProdPrice" placeholder="59,90" /></div>
            <div class="field"><label>Garantia</label><input id="newProdWarranty" value="30 dias de garantia e suporte Gemini Hub" /></div>
          </div>
          <div class="field" style="margin-top:10px;">
            <label>Descrição</label>
            <input id="newProdDesc" placeholder="Entrega imediata no chat..." />
          </div>
          <button class="btn btn-primary" style="margin-top:12px;" onclick="createProduct()">✅ Criar Produto</button>
        </div>

        <div class="glass panel">
          <h2>📂 Categorias</h2>
          <div id="categoriesList" style="margin-bottom:14px;"></div>
          <div class="form-grid">
            <div class="field"><label>Emoji</label><input id="newCatEmoji" value="💎" /></div>
            <div class="field"><label>Nome da Categoria</label><input id="newCatName" placeholder="Ex: Planos Gemini" /></div>
            <div class="field"><label>Descrição</label><input id="newCatDesc" placeholder="Opcional" /></div>
          </div>
          <button class="btn" style="margin-top:10px;" onclick="createCategory()">➕ Nova Categoria</button>
        </div>
      </div>

      <!-- TAB 4: DEPÓSITOS PIX -->
      <div id="tabDeposits" class="tab-pane hidden">
        <div class="glass panel">
          <h2>💰 Depósitos Pix Pendentes</h2>
          <div class="table-wrap">
            <table>
              <thead><tr><th>#</th><th>Cliente</th><th>Valor</th><th>Método</th><th>TXID / ID</th><th>Ações</th></tr></thead>
              <tbody id="depositsBody"></tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- TAB 5: CLIENTES -->
      <div id="tabUsers" class="tab-pane hidden">
        <div class="glass panel">
          <h2>
            <span>👤 Clientes da Loja</span>
            <span style="display:flex; gap:8px;">
              <input id="userSearchInput" placeholder="Buscar por ID ou @user" style="width:210px;" />
              <button class="btn btn-sm" onclick="loadOverview()">🔍 Buscar</button>
            </span>
          </h2>
          <div class="table-wrap">
            <table>
              <thead><tr><th>ID</th><th>Cliente</th><th>Saldo</th><th>Gasto Total</th><th>Status</th><th>Ações</th></tr></thead>
              <tbody id="usersBody"></tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- TAB 6: CUPONS -->
      <div id="tabCoupons" class="tab-pane hidden">
        <div class="glass panel">
          <h2>➕ Criar Cupom</h2>
          <div class="form-grid">
            <div class="field"><label>Código</label><input id="cupCode" placeholder="GEMINI10" /></div>
            <div class="field">
              <label>Tipo</label>
              <select id="cupType">
                <option value="percent_discount">Desconto (% OFF)</option>
                <option value="balance">Vale-Saldo (R$)</option>
              </select>
            </div>
            <div class="field"><label>Valor (% ou R$)</label><input id="cupValue" placeholder="10" /></div>
            <div class="field"><label>Máximo de usos</label><input id="cupMaxUses" type="number" value="20" /></div>
          </div>
          <button class="btn btn-primary" style="margin-top:12px;" onclick="createCoupon()">🎟️ Criar Cupom</button>
        </div>
        <div class="glass panel">
          <h2>🎟️ Cupons Ativos & Histórico</h2>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Código</th><th>Benefício</th><th>Usos</th><th>Status</th><th>Ação</th></tr></thead>
              <tbody id="couponsBody"></tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- TAB 7: BROADCAST -->
      <div id="tabBroadcast" class="tab-pane hidden">
        <div class="glass panel">
          <h2>📢 Enviar Aviso Geral no Telegram</h2>
          <div class="field">
            <label>Mensagem para todos os clientes ativos</label>
            <textarea id="broadcastText" placeholder="🔥 Estoque de Gemini Pro e Gemini Ultra reabastecido! Aproveite agora!"></textarea>
          </div>
          <button class="btn btn-primary" style="margin-top:12px;" onclick="sendBroadcast()">🚀 Disparar Broadcast Agora</button>
        </div>
      </div>

      <!-- TAB 8: CONFIGURAÇÕES -->
      <div id="tabSettings" class="tab-pane hidden">
        <div class="glass panel">
          <h2>🔧 Configurações ao Vivo (SyncPay & Loja)</h2>
          <div class="form-grid">
            <div class="field"><label>SyncPay Client ID</label><input id="cfgSyncId" /></div>
            <div class="field"><label>SyncPay Client Secret (deixe vazio p/ manter)</label><input id="cfgSyncSecret" type="password" placeholder="••••••••" /></div>
            <div class="field"><label>SyncPay Webhook URL</label><input id="cfgSyncWebhook" placeholder="https://gemini-hub-bot.onrender.com/webhooks/syncpay" /></div>
            <div class="field"><label>Chave Pix Manual (Fallback)</label><input id="cfgPixKey" /></div>
            <div class="field"><label>Suporte (@username)</label><input id="cfgSupport" /></div>
            <div class="field"><label>Canal de Vendas (@canal ou ID)</label><input id="cfgChannel" /></div>
            <div class="field"><label>Comissão Indique & Ganhe (%)</label><input id="cfgRefPct" type="number" min="0" max="50" /></div>
            <div class="field">
              <label>Cashback VIP Automático</label>
              <select id="cfgCashback">
                <option value="true">🟢 Ativado (2% a 8%)</option>
                <option value="false">⏸️ Desativado</option>
              </select>
            </div>
          </div>
          <div style="display:flex; gap:10px; margin-top:14px; flex-wrap:wrap;">
            <button class="btn btn-primary" onclick="saveSettings(false)">💾 Salvar Configurações</button>
            <button class="btn" onclick="saveSettings(true)">🌐 Salvar + Registrar Webhook na SyncPay</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    let STATE = null;
    const fmtBRL = (cents) => (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    function toast(msg, isErr = false) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.style.borderColor = isErr ? '#ef4444' : '#5ce1ff';
      el.style.display = 'block';
      clearTimeout(window._toastTimer);
      window._toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3600);
    }

    async function api(url, opts = {}) {
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
        ...opts,
      });
      if (res.status === 401) {
        document.getElementById('appView').classList.add('hidden');
        document.getElementById('loginView').classList.remove('hidden');
        throw new Error('Sessão expirada');
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('Erro HTTP ' + res.status));
      return data;
    }

    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      document.getElementById('loginErr').textContent = '';
      try {
        await api('/api/admin/login', {
          method: 'POST',
          body: JSON.stringify({ password: document.getElementById('loginPassword').value })
        });
        document.getElementById('loginView').classList.add('hidden');
        document.getElementById('appView').classList.remove('hidden');
        await loadOverview();
      } catch (err) {
        document.getElementById('loginErr').textContent = err.message;
      }
    });

    async function logout() {
      await fetch('/api/admin/logout', { method: 'POST' });
      location.reload();
    }

    function switchTab(btn) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.remove('hidden');
    }

    async function loadOverview() {
      const search = document.getElementById('userSearchInput')?.value || '';
      STATE = await api('/api/admin/overview?userSearch=' + encodeURIComponent(search));
      renderAll();
    }

    function renderAll() {
      const { stats, syncpayBalance, settings, categories, products, pendingDeposits, users, recentOrders, coupons } = STATE;

      const modeMap = { syncpay: '🟢 SyncPay Automático', auto: '🟢 Mercado Pago', manual: '🟡 Pix Manual', unconfigured: '🔴 Pix não configurado' };
      document.getElementById('gatewayStatusBadge').textContent =
        (modeMap[settings.effectivePixMode] || settings.effectivePixMode) +
        (syncpayBalance !== null ? ' • Saldo SyncPay: ' + fmtBRL(Math.round(syncpayBalance * 100)) : '');

      document.getElementById('depBadge').textContent = pendingDeposits.length > 0 ? ' (' + pendingDeposits.length + ')' : '';

      // KPIs
      const kpis = [
        { label: 'Faturamento Total', val: fmtBRL(stats.totalRevenueCents), sub: stats.totalOrders + ' pedido(s)' },
        { label: 'Vendas Hoje', val: fmtBRL(stats.todayRevenueCents), sub: stats.todayOrders + ' pedido(s) hoje' },
        { label: 'Saldo SyncPay', val: syncpayBalance !== null ? fmtBRL(Math.round(syncpayBalance * 100)) : '—', sub: 'Conta Parceiro' },
        { label: 'Estoque Disponível', val: stats.availableStock + ' un.', sub: stats.soldStock + ' vendida(s)' },
        { label: 'Clientes Totais', val: stats.totalUsers, sub: 'Carteiras: ' + fmtBRL(stats.totalWalletBalanceCents) },
      ];
      document.getElementById('kpiGrid').innerHTML = kpis.map(k =>
        '<div class="glass kpi"><div class="label">' + esc(k.label) + '</div><div class="val">' + esc(k.val) + '</div><div class="sub">' + esc(k.sub) + '</div></div>'
      ).join('');

      // Pedidos recentes
      document.getElementById('recentOrdersBody').innerHTML = recentOrders.length
        ? recentOrders.map(o =>
            '<tr><td>#' + o.id + '</td><td>' + esc(o.username ? '@' + o.username : o.first_name) + ' <code>' + o.user_id + '</code></td><td>' + esc(o.product_name) + '</td><td>' + o.quantity + 'x</td><td><b>' + fmtBRL(o.total_cents) + '</b></td><td>' + esc(String(o.created_at).slice(0, 16)) + '</td></tr>'
          ).join('')
        : '<tr><td colspan="6" style="color:var(--muted)">Nenhum pedido registrado ainda.</td></tr>';

      // Select estoque & categorias
      const prevStockProd = document.getElementById('stockProductSelect').value;
      document.getElementById('stockProductSelect').innerHTML = products.map(p =>
        '<option value="' + p.id + '">' + esc(p.name) + ' (' + p.stock_count + ' em estoque)</option>'
      ).join('');
      if (prevStockProd && products.some(p => String(p.id) === prevStockProd)) {
        document.getElementById('stockProductSelect').value = prevStockProd;
      }
      loadProductStock();

      document.getElementById('newProdCat').innerHTML = categories.map(c =>
        '<option value="' + c.id + '">' + esc(c.emoji + ' ' + c.name) + '</option>'
      ).join('');

      // Produtos
      document.getElementById('productsList').innerHTML = products.map(p =>
        '<div style="border:1px solid rgba(148,163,184,0.16); border-radius:12px; padding:14px; margin-bottom:10px;">' +
          '<div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom:8px;">' +
            '<div><b>#' + p.id + ' • ' + esc(p.name) + '</b> <span class="badge ' + (p.is_active ? 'b-green' : 'b-amber') + '">' + (p.is_active ? 'Ativo' : 'Oculto') + '</span> <span class="badge b-cyan">' + p.stock_count + ' em estoque</span></div>' +
            '<div style="display:flex; gap:6px;">' +
              '<button class="btn btn-sm" onclick="toggleProd(' + p.id + ')">' + (p.is_active ? '⏸️ Ocultar' : '🟢 Ativar') + '</button>' +
              '<button class="btn btn-sm btn-danger" onclick="deleteProd(' + p.id + ')">🗑️</button>' +
            '</div>' +
          '</div>' +
          '<div class="form-grid">' +
            '<div class="field"><label>Nome</label><input id="pName_' + p.id + '" value="' + esc(p.name) + '" /></div>' +
            '<div class="field"><label>Preço (R$)</label><input id="pPrice_' + p.id + '" value="' + (p.price_cents / 100).toFixed(2).replace('.', ',') + '" /></div>' +
            '<div class="field"><label>Descrição</label><input id="pDesc_' + p.id + '" value="' + esc(p.description) + '" /></div>' +
          '</div>' +
          '<button class="btn btn-sm btn-primary" style="margin-top:8px;" onclick="saveProd(' + p.id + ')">💾 Salvar Produto</button>' +
        '</div>'
      ).join('');

      // Categorias
      document.getElementById('categoriesList').innerHTML = categories.map(c =>
        '<div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid rgba(148,163,184,0.12);">' +
          '<span>' + esc(c.emoji + ' ' + c.name) + ' <span class="badge ' + (c.is_active ? 'b-green' : 'b-amber') + '">' + (c.is_active ? 'Ativa' : 'Oculta') + '</span></span>' +
          '<button class="btn btn-sm" onclick="toggleCat(' + c.id + ')">Alternar</button>' +
        '</div>'
      ).join('');

      // Depósitos pendentes
      document.getElementById('depositsBody').innerHTML = pendingDeposits.length
        ? pendingDeposits.map(d =>
            '<tr><td>#' + d.id + '</td><td>' + esc(d.first_name) + ' <code>' + d.user_id + '</code></td><td><b>' + fmtBRL(d.amount_cents) + '</b></td><td>' + esc(d.method) + '</td><td><code>' + esc(d.provider_payment_id || d.txid) + '</code></td><td style="display:flex; gap:6px;"><button class="btn btn-sm btn-success" onclick="depAction(' + d.id + ', \\'approve\\')">✅ Aprovar</button><button class="btn btn-sm btn-danger" onclick="depAction(' + d.id + ', \\'reject\\')">❌ Recusar</button></td></tr>'
          ).join('')
        : '<tr><td colspan="6" style="color:var(--muted)">Nenhum depósito pendente.</td></tr>';

      // Clientes
      document.getElementById('usersBody').innerHTML = users.map(u =>
        '<tr><td><code>' + u.telegram_id + '</code></td><td>' + esc(u.username ? '@' + u.username : u.first_name) + '</td><td><b>' + fmtBRL(u.balance_cents) + '</b></td><td>' + fmtBRL(u.total_spent_cents) + '</td><td><span class="badge ' + (u.is_banned ? 'b-red' : 'b-green') + '">' + (u.is_banned ? 'Banido' : 'Ativo') + '</span></td><td style="display:flex; gap:6px; flex-wrap:wrap;"><button class="btn btn-sm btn-success" onclick="adjustUserBal(' + u.telegram_id + ', \\'credit\\')">➕ Saldo</button><button class="btn btn-sm" onclick="adjustUserBal(' + u.telegram_id + ', \\'debit\\')">➖ Saldo</button><button class="btn btn-sm btn-danger" onclick="toggleBan(' + u.telegram_id + ')">' + (u.is_banned ? 'Desbanir' : 'Banir') + '</button></td></tr>'
      ).join('');

      // Cupons
      document.getElementById('couponsBody').innerHTML = coupons.length
        ? coupons.map(c =>
            '<tr><td><code>' + esc(c.code) + '</code></td><td>' + (c.type === 'balance' ? fmtBRL(c.value) : c.value + '% OFF') + '</td><td>' + c.used_count + '/' + c.max_uses + '</td><td><span class="badge ' + (c.is_active ? 'b-green' : 'b-amber') + '">' + (c.is_active ? 'Ativo' : 'Pausado') + '</span></td><td><button class="btn btn-sm" onclick="toggleCoupon(' + c.id + ')">Alternar</button></td></tr>'
          ).join('')
        : '<tr><td colspan="5" style="color:var(--muted)">Nenhum cupom criado.</td></tr>';

      // Configurações
      document.getElementById('cfgSyncId').value = settings.syncpayClientId || '';
      document.getElementById('cfgSyncWebhook').value = settings.syncpayWebhookUrl || '';
      document.getElementById('cfgPixKey').value = settings.pixKey || '';
      document.getElementById('cfgSupport').value = settings.supportUsername || '';
      document.getElementById('cfgChannel').value = settings.salesChannelId || '';
      document.getElementById('cfgRefPct').value = settings.referralCommissionPct ?? 10;
      document.getElementById('cfgCashback').value = settings.cashbackEnabled ? 'true' : 'false';
    }

    async function loadProductStock() {
      const pid = document.getElementById('stockProductSelect').value;
      if (!pid) return;
      const { items } = await api('/api/admin/products/' + pid + '/stock');
      document.getElementById('stockListCount').textContent = items.length;
      document.getElementById('stockItemsBody').innerHTML = items.length
        ? items.map(it =>
            '<tr><td>#' + it.id + '</td><td><code>' + esc(it.credential) + '</code></td><td><button class="btn btn-sm btn-danger" onclick="delStockItem(' + it.id + ')">Remover</button></td></tr>'
          ).join('')
        : '<tr><td colspan="3" style="color:var(--muted)">Nenhuma conta disponível neste produto.</td></tr>';
    }

    async function addBulkStock() {
      const pid = document.getElementById('stockProductSelect').value;
      const lines = document.getElementById('bulkStockText').value;
      if (!lines.trim()) return toast('Cole ao menos 1 conta.', true);
      try {
        const res = await api('/api/admin/products/' + pid + '/stock', {
          method: 'POST', body: JSON.stringify({ lines })
        });
        document.getElementById('bulkStockText').value = '';
        toast('✅ +' + res.added + ' conta(s) adicionada(s)! (' + res.totalAvailable + ' disponíveis)');
        await loadOverview();
      } catch (e) { toast(e.message, true); }
    }

    async function clearProductStock() {
      const pid = document.getElementById('stockProductSelect').value;
      if (!confirm('Zerar todo o estoque disponível deste produto?')) return;
      await api('/api/admin/products/' + pid + '/stock', { method: 'DELETE' });
      toast('🗑️ Estoque zerado.');
      await loadOverview();
    }

    async function delStockItem(id) {
      await api('/api/admin/stock/' + id, { method: 'DELETE' });
      toast('Item removido.');
      await loadOverview();
    }

    async function saveProd(id) {
      try {
        await api('/api/admin/products/' + id, {
          method: 'PATCH',
          body: JSON.stringify({
            name: document.getElementById('pName_' + id).value,
            priceBrl: document.getElementById('pPrice_' + id).value,
            description: document.getElementById('pDesc_' + id).value,
          })
        });
        toast('✅ Produto atualizado!');
        await loadOverview();
      } catch (e) { toast(e.message, true); }
    }

    async function toggleProd(id) {
      await api('/api/admin/products/' + id, { method: 'PATCH', body: JSON.stringify({ toggleActive: true }) });
      toast('Status atualizado!');
      await loadOverview();
    }

    async function deleteProd(id) {
      if (!confirm('Excluir este produto?')) return;
      try {
        await api('/api/admin/products/' + id, { method: 'DELETE' });
        toast('🗑️ Produto excluído.');
        await loadOverview();
      } catch (e) { toast(e.message, true); }
    }

    async function createProduct() {
      try {
        await api('/api/admin/products', {
          method: 'POST',
          body: JSON.stringify({
            categoryId: document.getElementById('newProdCat').value,
            name: document.getElementById('newProdName').value,
            priceBrl: document.getElementById('newProdPrice').value,
            warranty: document.getElementById('newProdWarranty').value,
            description: document.getElementById('newProdDesc').value,
          })
        });
        document.getElementById('newProdName').value = '';
        document.getElementById('newProdPrice').value = '';
        toast('✅ Produto criado!');
        await loadOverview();
      } catch (e) { toast(e.message, true); }
    }

    async function createCategory() {
      try {
        await api('/api/admin/categories', {
          method: 'POST',
          body: JSON.stringify({
            emoji: document.getElementById('newCatEmoji').value,
            name: document.getElementById('newCatName').value,
            description: document.getElementById('newCatDesc').value,
          })
        });
        document.getElementById('newCatName').value = '';
        toast('✅ Categoria criada!');
        await loadOverview();
      } catch (e) { toast(e.message, true); }
    }

    async function toggleCat(id) {
      await api('/api/admin/categories/' + id + '/toggle', { method: 'POST' });
      await loadOverview();
    }

    async function depAction(id, action) {
      try {
        await api('/api/admin/deposits/' + id + '/' + action, { method: 'POST' });
        toast(action === 'approve' ? '✅ Depósito aprovado!' : '❌ Depósito recusado.');
        await loadOverview();
      } catch (e) { toast(e.message, true); }
    }

    async function adjustUserBal(id, mode) {
      const val = prompt(mode === 'credit' ? 'Valor em R$ para ADICIONAR (ex: 30,00):' : 'Valor em R$ para REMOVER (ex: 10,00):');
      if (!val) return;
      try {
        await api('/api/admin/users/' + id + '/balance', {
          method: 'POST', body: JSON.stringify({ amountBrl: val, mode })
        });
        toast('✅ Saldo atualizado!');
        await loadOverview();
      } catch (e) { toast(e.message, true); }
    }

    async function toggleBan(id) {
      await api('/api/admin/users/' + id + '/ban', { method: 'POST' });
      toast('Status do cliente atualizado.');
      await loadOverview();
    }

    async function createCoupon() {
      try {
        await api('/api/admin/coupons', {
          method: 'POST',
          body: JSON.stringify({
            code: document.getElementById('cupCode').value,
            type: document.getElementById('cupType').value,
            value: document.getElementById('cupValue').value,
            maxUses: document.getElementById('cupMaxUses').value,
          })
        });
        document.getElementById('cupCode').value = '';
        toast('🎟️ Cupom criado!');
        await loadOverview();
      } catch (e) { toast(e.message, true); }
    }

    async function toggleCoupon(id) {
      await api('/api/admin/coupons/' + id + '/toggle', { method: 'POST' });
      await loadOverview();
    }

    async function sendBroadcast() {
      const msg = document.getElementById('broadcastText').value;
      if (!msg.trim() || !confirm('Enviar comunicado agora para todos os clientes?')) return;
      try {
        const res = await api('/api/admin/broadcast', {
          method: 'POST', body: JSON.stringify({ message: msg })
        });
        document.getElementById('broadcastText').value = '';
        toast('🚀 Enviado para ' + res.sent + ' cliente(s)!');
      } catch (e) { toast(e.message, true); }
    }

    async function saveSettings(registerSyncpayWebhook) {
      try {
        await api('/api/admin/settings', {
          method: 'POST',
          body: JSON.stringify({
            syncpayClientId: document.getElementById('cfgSyncId').value,
            syncpayClientSecret: document.getElementById('cfgSyncSecret').value,
            syncpayWebhookUrl: document.getElementById('cfgSyncWebhook').value,
            pixKey: document.getElementById('cfgPixKey').value,
            supportUsername: document.getElementById('cfgSupport').value,
            salesChannelId: document.getElementById('cfgChannel').value,
            referralCommissionPct: document.getElementById('cfgRefPct').value,
            cashbackEnabled: document.getElementById('cfgCashback').value === 'true',
            registerSyncpayWebhook,
          })
        });
        document.getElementById('cfgSyncSecret').value = '';
        toast('✅ Configurações salvas!');
        await loadOverview();
      } catch (e) { toast(e.message, true); }
    }

    if (${authenticated ? 'true' : 'false'}) {
      loadOverview().catch(() => {});
    }
  </script>
</body>
</html>`;
}
