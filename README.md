# 💎 Gemini Hub — Bot de Vendas de Contas no Telegram

Bot completo em **Node.js + SQLite nativo + grammY** para venda automatizada de contas digitais (**Gemini Pro, Gemini Ultra, IA, Streaming, Jogos e Licenças**) com **Sistema de Carteira / Saldo via Pix** e **Painel Administrativo completo dentro do Telegram**.

---

## ✨ Recursos Inclusos

### 🛍️ Experiência do Cliente
- **Banners Oficiais Integrados**:
  - `assets/banner-home.jpg` exibido automaticamente no menu principal (`/start`).
  - `assets/banner-catalog.jpg` exibido na navegação do catálogo de planos e contas.
  - Cache inteligente de `file_id` do Telegram para navegação instantânea.
- **Sistema de Saldo / Carteira via Pix**:
  - **Modo Pix Automático (`Mercado Pago`)**: gera QR Code + Copia e Cola e credita o saldo **sozinho em poucos segundos** assim que o cliente paga.
  - **Modo Pix Direto (`Chave Pix própria`)**: gera **BR Code oficial (padrão Banco Central EMV + CRC16)** + QR Code da sua chave Pix; o cliente envia o comprovante e o Admin aprova com **1 clique**.
- **Entrega Instantânea & Transação Atômica**:
  - Zero risco de vender a mesma conta para duas pessoas.
  - Credenciais entregues em blocos copiáveis (`<code>`) e salvas permanentemente em **📦 Minhas Compras**.
- **Cupons Promocionais**:
  - Suporte a **Gift Cards de Saldo** (credita R$ na carteira) e **Cupons de Desconto (`% OFF`)**.

### ⚙️ Painel Admin (`/admin` no próprio Telegram)
- **📊 Estatísticas em tempo real**: clientes, vendas hoje/total, faturamento, saldo em carteiras e alerta de itens sem estoque.
- **📥 Reposição de Estoque em Lote**: cole 1 ou centenas de contas de uma vez (1 por linha).
- **🏷️ Categorias & Produtos**: crie, altere preços em R$ ou oculte/ative itens sem mexer no código.
- **💰 Gestão de Depósitos & Clientes**: aprove/recuse Pix pendentes, adicione/remova saldo manualmente por ID ou bana usuários.
- **📢 Broadcast**: envie comunicados e avisos de reposição para todos os clientes ativos.

---

## 🤖 Passo 1: Criar e Personalizar no `@BotFather`

1. Abra o Telegram e inicie conversa com **[@BotFather](https://t.me/BotFather)**.
2. Envie `/newbot` e defina:
   - **Nome de exibição**: `Gemini Hub`
   - **Username** (deve terminar em `bot`): ex. `GeminiHubStoreBot` ou `GeminiHubOficialBot`
3. Copie o **HTTP API Token** gerado para colocar no seu arquivo `.env`.
4. Suba a logo e o banner oficial no `@BotFather`:
   - `/setuserpic` → selecione seu bot → envie o arquivo `assets/logo.jpg`.
   - `/setabouttext` → cole:
     ```text
     💎 Gemini Hub — Planos Gemini Pro, Gemini Ultra e Contas Digitais com entrega automática 24/7 via Pix.
     ```
   - `/setdescription` → cole:
     ```text
     ✨ Bem-vindo(a) à Gemini Hub!

     ⚡ Entrega automática 24 horas no chat
     💳 Carteira digital com recarga rápida via Pix
     💎 Gemini Pro, Gemini Ultra e Contas Digitais verificadas

     Toque em COMEÇAR abaixo para acessar o catálogo!
     ```
   - *(Opcional)* `/setdescriptionpic` → envie `assets/banner-home.jpg` (aparece antes mesmo da pessoa clicar em *Começar*!).

---

## ⚙️ Passo 2: Configurar o `.env`

Abra o arquivo `.env` na pasta do projeto e preencha:

```env
BOT_TOKEN=SEU_TOKEN_DO_BOTFATHER_AQUI
ADMIN_IDS=SEU_ID_NUMERICO_DO_TELEGRAM
STORE_NAME=Gemini Hub
SUPPORT_USERNAME=@SeuUsuarioDeSuporte
```

> 💡 **Como descobrir seu `ADMIN_IDS`?** Envie qualquer mensagem para `@userinfobot` no Telegram — ele responde com o seu `Id` numérico (ex: `987654321`).

### Configurando o Pix:
- **Para usar sua própria chave Pix (sem precisar de conta Mercado Pago)**:
  Preencha apenas `PIX_KEY=sua-chave-pix`, `PIX_MERCHANT_NAME=GEMINI HUB` e `PIX_MERCHANT_CITY=SAO PAULO`.
- **Para aprovar Pix 100% no automático (Mercado Pago)**:
  Coloque seu Access Token de produção em `MERCADOPAGO_ACCESS_TOKEN=APP_USR-...`. Com `PIX_MODE=hybrid`, ele usa o Mercado Pago automaticamente!

---

## 🚀 Passo 3: Iniciar o Bot

No terminal dentro da pasta `c:\Users\mcass\Downloads\OT`:

```powershell
# Rodar testes automatizados (opcional)
npm test

# Iniciar o bot em produção
npm start
```

Depois de iniciar, abra o bot no Telegram, envie `/start` e clique em **⚙️ Painel Admin • Gemini Hub** (ou envie `/admin`) para adicionar suas primeiras contas em **📥 Repor Estoque**!
