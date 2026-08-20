/**
 * China Selection — Supply Network Vendor Backend (MVP)
 * 零依赖 Node 服务：认证 + 产品发布(手动/链接导入) + 询盘管理 + 订单管理 + Stripe(Connect) 收款 + 前端页面
 * 运行： node server.js   （默认端口 3000，可用 PORT 环境变量覆盖）
 *
 * 支付模型（见 china_select_architecture.md §3.4 / §3.5）：
 * - 平台主体 Brand partner Co., Ltd（香港）作 Stripe Connect 平台方；每家 vendor 自带 Connected Account（stripeAccountId）。
 * - 样品单 → Stripe Checkout（款项直达 vendor 子账号，平台抽佣 application_fee_amount）；大货单 → 对公转账 + Escrow.com。
 *
 * 重要红线：
 * - 链接导入只接受「自有内容」或「已授权品牌方素材」。
 * - 后台不碰资金池；大货交易托管由 Escrow.com 等持牌第三方负责。
 *
 * 环境变量（均可选，缺省降级为 mock 以便本地跑通）：
 *   STRIPE_SECRET_KEY        平台主体 Secret Key
 *   STRIPE_WEBHOOK_SECRET    Webhook 签名密钥
 *   PLATFORM_FEE_RATE        平台抽佣比例（默认 0.05）
 *   PUBLIC_BASE              对外 base URL（用于 Checkout 回跳）
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'; // 允许跨域的来源；生产填 A 站域名，如 https://china-selection.com
const PLATFORM_INBOX = process.env.PLATFORM_INBOX || '__platform__'; // 未指定 vendor 时的通用收件箱 ownerId
const DB_FILE = path.join(__dirname, 'db.json');
const COOKIE = 'cs_session';

// ---------- 存储 ----------
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const seed = { users: [], sessions: {}, products: [], inquiries: [], orders: [] };
    // 演示账号：密码 demo1234
    const u = mkUser('Demo Exporter 1', 'demo1', 'demo1234', 'vendor', '');
    seed.users.push(u);
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDB() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
let db = loadDB();

// ---------- 密码 / 会话 ----------
function mkUser(company, username, password, role, email) {
  role = role || 'vendor'; email = email || '';
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  // stripeAccountId：该 vendor 在 Stripe 上的 connected account（子账号）；buyerToken：买家免密登录令牌
  return { id: 'u' + crypto.randomBytes(6).toString('hex'), company, username, salt, hash, role, email, stripeAccountId: '', buyerToken: '', tokenExpiry: 0, createdAt: new Date().toISOString() };
}
// 买家：guest 下单时用邮箱自动建/查账号，并关联订单（关系沉淀，不丢买家信息）
function findOrCreateBuyer(email, name) {
  email = String(email || '').trim().toLowerCase();
  if (!email) return null;
  let b = db.users.find(x => x.role === 'buyer' && (x.email === email || x.username === email));
  if (!b) {
    const tmp = crypto.randomBytes(14).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
    b = mkUser(name || email.split('@')[0], email, tmp, 'buyer', email);
    b.buyerToken = crypto.randomBytes(24).toString('hex');
    b.tokenExpiry = Date.now() + 1000 * 60 * 60 * 24 * 30;
    db.users.push(b); saveDB();
  }
  return b;
}
// 买家免密令牌登录（无邮件也能用；接邮件后改为邮件发送该令牌）
function tokenBuyer(tok) {
  if (!tok) return null;
  const b = db.users.find(x => x.role === 'buyer' && x.buyerToken === tok);
  if (!b || (b.tokenExpiry && Date.now() > b.tokenExpiry)) return null;
  return b;
}
function verify(password, user) {
  const h = crypto.scryptSync(password, user.salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(user.hash, 'hex'));
}
function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = userId;
  saveDB();
  return token;
}
function userFromReq(req) {
  const c = parseCookies(req).cs_session;
  if (!c || !db.sessions[c]) return null;
  return db.users.find(u => u.id === db.sessions[c]) || null;
}

// ---------- HTTP 工具 ----------
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(';').forEach(s => { const [k, v] = s.trim().split('='); out[k] = decodeURIComponent(v || ''); });
  return out;
}
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}
function sendCORS(res, code) {
  res.writeHead(code, {
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  return res.end();
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function readRaw(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 5e6) req.destroy(); });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}
function setCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=864000`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
}

// ---------- 链接导入（抓取 + 自动填字段；AI 改写预留） ----------
async function fetchDraftFromUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('Invalid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http/https URLs');

  const resp = await fetch(u.toString(), { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (China-Selection-Importer)' } });
  if (!resp.ok) throw new Error('Fetch failed: ' + resp.status);
  const html = await resp.text();

  const meta = (prop) => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i')) ||
               html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'));
    return m ? m[1].trim() : '';
  };
  const titleTag = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';

  const title = meta('og:title') || titleTag || '';
  const description = meta('og:description') || meta('description') || '';
  const image = meta('og:image') || '';
  // 尽量从 URL 路径猜测品类
  const pathHint = u.pathname.split('/').filter(Boolean).pop() || '';
  const categoryGuess = /(vacuum|mop|clean|washer)/i.test(html + u.pathname) ? 'Small appliances' : '';

  const descriptionZh = await aiRewrite(description); // 预留：接入 LLM 后做改写/翻译
  return {
    name: title.slice(0, 120),
    description: descriptionZh.slice(0, 2000),
    images: image ? [image] : [],
    category: categoryGuess,
    sourceUrl: u.toString(),
    model: pathHint.slice(0, 60)
  };
}
// AI 改写占位：无 LLM key 时返回原文（接入后替换此函数即可）
async function aiRewrite(text) {
  if (!text) return '';
  // 未来：if (process.env.LLM_API_KEY) { ... 调用模型改写/翻译 ... }
  return text.replace(/\s+/g, ' ').trim();
}

// ---------- Stripe（零依赖：直接用 REST + fetch；Connect 直连各 vendor 子账号） ----------
// 平台主体：Brand partner Co., Ltd（香港）。该主体的 Secret Key 配在环境变量 STRIPE_SECRET_KEY。
// 每家 vendor 自带一个 Connected Account（stripeAccountId），款项直达该子账号，平台佣金走 application_fee_amount。
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WHSEC = process.env.STRIPE_WEBHOOK_SECRET || '';
const PLATFORM_FEE_RATE = Number(process.env.PLATFORM_FEE_RATE || 0.05); // 平台抽佣比例，默认 5%

// 向 Stripe REST 发请求；accountId 存在时走 Connect 子账号
async function stripeRequest(pathname, bodyObj, accountId) {
  if (!STRIPE_KEY) return null; // 无 key → 调用方降级为 mock
  const auth = Buffer.from(STRIPE_KEY + ':').toString('base64');
  const body = new URLSearchParams(bodyObj).toString();
  const headers = { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' };
  if (accountId) headers['Stripe-Account'] = accountId;
  const r = await fetch('https://api.stripe.com' + pathname, { method: 'POST', headers, body });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Stripe error: ' + (json.error && json.error.message || r.status));
  return json;
}

// 为「样品单」创建 Checkout Session：款项直达 vendor 子账号，平台抽佣
async function createSampleCheckout(order, vendor, returnToken) {
  if (!vendor.stripeAccountId) throw new Error('Vendor has no Stripe connected account. Set it in Settings first.');
  const base = process.env.PUBLIC_BASE || 'http://localhost:3000';
  const tok = returnToken ? '&t=' + returnToken : '';
  if (!STRIPE_KEY) {
    // 本地无 key 时返回 mock 链接，便于跑通流程
    return { mock: true, checkoutUrl: 'https://checkout.stripe.com/mock/session_' + order.id, sessionId: 'mock_' + order.id };
  }
  const fee = Math.round(order.amount * PLATFORM_FEE_RATE);
  const sess = await stripeRequest('/v1/checkout/sessions', {
    mode: 'payment',
    'line_items[0][price_data][currency]': (order.currency || 'usd').toLowerCase(),
    'line_items[0][price_data][product_data][name]': order.productRef + ' (Sample)',
    'line_items[0][price_data][unit_amount]': Math.round(order.amount * 100),
    'line_items[0][quantity]': 1,
    'payment_intent_data[application_fee_amount]': fee,
    success_url: base + '/buyer-dashboard?paid=' + order.id + tok,
    cancel_url: base + '/buyer-dashboard' + tok,
    client_reference_id: order.id,
    customer_email: order.buyerEmail || ''
  }, vendor.stripeAccountId);
  return { mock: false, checkoutUrl: sess.url, sessionId: sess.id };
}

// 手验 Stripe Webhook 签名（零依赖，用内置 crypto HMAC）
function verifyStripeSig(rawBody, sigHeader) {
  if (!STRIPE_WHSEC) return true; // 未配密钥则放行（仅本地调试）
  if (!sigHeader) return false;
  const parts = {};
  sigHeader.split(',').forEach(p => { const [k, v] = p.split('='); parts[k] = v; });
  if (!parts.t || !parts.v1) return false;
  const expected = crypto.createHmac('sha256', STRIPE_WHSEC).update(parts.t + '.' + rawBody, 'utf8').digest('hex');
  const got = Buffer.from(parts.v1, 'hex');
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(got, Buffer.from(expected, 'hex'));
}

// ---------- 业务：订单（样品 sample / 大货 bulk） ----------
function ownedOrders(uid) { return db.orders.filter(o => o.ownerId === uid).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
function findOrder(uid, id) { return db.orders.find(o => o.id === id && o.ownerId === uid); }

function addOrder(uid, data) {
  const type = data.type === 'bulk' ? 'bulk' : 'sample';
  const amount = Number(data.amount) || 0;
  const o = {
    id: 'o' + crypto.randomBytes(6).toString('hex'),
    ownerId: uid,
    type,
    productRef: data.productRef || '',
    buyerName: data.buyerName || '',
    buyerEmail: data.buyerEmail || '',
    buyerCompany: data.buyerCompany || '',
    qty: Number(data.qty) || 1,
    currency: (data.currency || 'USD').toUpperCase(),
    amount,
    status: type === 'sample' ? 'draft' : 'draft',
    stripeSessionId: '',
    stripeCheckoutUrl: '',
    escrowRef: '',
    notes: data.notes || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.orders.push(o); saveDB(); return o;
}

// ---------- 业务：产品 / 询盘 ----------
function ownedProducts(uid) { return db.products.filter(p => p.ownerId === uid); }
function findProduct(uid, id) { return db.products.find(p => p.id === id && p.ownerId === uid); }

function addProduct(uid, data) {
  const p = {
    id: 'p' + crypto.randomBytes(6).toString('hex'),
    ownerId: uid,
    category: data.category || '',
    name: data.name || '',
    model: data.model || '',
    priceRange: data.priceRange || '',
    moq: Number(data.moq) || 0,
    markets: data.markets || '',
    certs: data.certs || '',
    images: Array.isArray(data.images) ? data.images : String(data.images || '').split(',').map(s => s.trim()).filter(Boolean),
    description: data.description || '',
    source: data.source || 'manual',
    sourceUrl: data.sourceUrl || '',
    createdAt: new Date().toISOString()
  };
  db.products.push(p); saveDB(); return p;
}

// ---------- 前端页面 ----------
function pageLogin() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>China Selection · Vendor Login</title>
  <style>body{font-family:system-ui,Segoe UI,Arial;background:#f5f6f8;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;color:#14151a}
  .box{background:#fff;padding:32px 36px;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.08);width:340px}
  h1{font-size:20px;margin:0 0 4px}.sub{color:#5b6170;font-size:13px;margin-bottom:20px}
  input{width:100%;padding:10px;margin:8px 0;border:1px solid #d7dbe2;border-radius:8px;box-sizing:border-box}
  button{width:100%;padding:11px;background:#C8102E;color:#fff;border:0;border-radius:8px;font-weight:700;cursor:pointer;margin-top:10px}
  .link{color:#C8102E;cursor:pointer;font-size:13px;text-decoration:underline;background:none;border:0;padding:0}
  .msg{color:#C8102E;font-size:13px;min-height:16px;margin-top:8px}
  .tabs{display:flex;gap:8px;margin-bottom:12px}</style></head>
  <body><div class="box">
    <h1>China Selection</h1><div class="sub">Supply Network — Vendor Console</div>
    <div class="tabs"><button class="link" id="tLogin" style="text-align:left">Login</button><button class="link" id="tReg" style="text-align:left;color:#5b6170">Register</button></div>
    <form id="f">
      <input id="company" placeholder="Company (register only)" style="display:none">
      <input id="username" placeholder="Username" required>
      <input id="password" type="password" placeholder="Password" required>
      <button id="submit" type="submit">Login</button>
      <div class="msg" id="msg"></div>
    </form>
    <div class="sub" style="margin-top:16px">Demo: demo1 / demo1234</div>
  </div>
  <script>
  let mode='login';
  const tL=document.getElementById('tLogin'),tR=document.getElementById('tReg'),company=document.getElementById('company'),submit=document.getElementById('submit'),msg=document.getElementById('msg');
  tR.onclick=()=>{mode='reg';company.style.display='block';submit.textContent='Register';tR.style.color='#C8102E';tL.style.color='#5b6170';msg.textContent=''};
  tL.onclick=()=>{mode='login';company.style.display='none';submit.textContent='Login';tL.style.color='#C8102E';tR.style.color='#5b6170';msg.textContent=''};
  document.getElementById('f').onsubmit=async e=>{e.preventDefault();msg.textContent='';
    const r=await fetch('/api/'+(mode==='login'?'login':'register'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({company:company.value,username:username.value,password:password.value})});
    const j=await r.json(); if(!r.ok){msg.textContent=j.error||'Error';return;}
    location.href='/dashboard';
  };
  </script></body></html>`;
}

function pageDashboard() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>China Selection · Vendor Console</title>
  <style>body{font-family:system-ui,Arial;margin:0;background:#f5f6f8;color:#14151a}
  header{background:#14151a;color:#fff;padding:14px 24px;display:flex;justify-content:space-between;align-items:center}
  header b{color:#fff}.red{color:#C8102E}
  .wrap{max-width:1080px;margin:24px auto;padding:0 16px}
  .card{background:#fff;border:1px solid #e3e6ec;border-radius:10px;padding:18px;margin-bottom:18px}
  h2{font-size:16px;margin:0 0 12px}.sub{color:#5b6170;font-size:13px}
  input,textarea,select{width:100%;padding:9px;margin:6px 0;border:1px solid #d7dbe2;border-radius:8px;box-sizing:border-box;font-family:inherit}
  button{padding:9px 14px;background:#C8102E;color:#fff;border:0;border-radius:8px;font-weight:700;cursor:pointer}
  .ghost{background:#fff;color:#C8102E;border:1px solid #C8102E}
  .prod{border:1px solid #e3e6ec;border-radius:8px;padding:12px;margin:8px 0;display:flex;justify-content:space-between;gap:12px}
  .prod .meta{color:#5b6170;font-size:12px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .pill{display:inline-block;background:#fff5ec;color:#8a4b13;border-radius:20px;padding:2px 10px;font-size:12px;margin-left:8px}
  table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:8px;border-bottom:1px solid #eef0f3}
  .logout{cursor:pointer;color:#fff;font-size:13px;text-decoration:underline;background:none;border:0}
  .red-note{background:#fff5ec;border-left:3px solid #e08a2b;padding:8px 10px;font-size:12px;color:#8a4b13;border-radius:6px;margin-top:8px}
  </style></head>
  <body><header><span><b>China Selection</b> · Vendor Console</span><button class="logout" id="logout">Logout</button></header>
  <div class="wrap">
    <div class="card"><h2>Welcome, <span id="company" class="red"></span></h2>
      <div class="sub">This is your vendor console. List products, import from your own site, and manage inquiries. Trades settle via licensed third-party escrow — not through this site.</div>
    </div>

    <div class="card">
      <h2>Products <span class="pill" id="pcount">0</span></h2>
      <div class="grid2">
        <input id="p_name" placeholder="Product name *">
        <input id="p_category" placeholder="Category (e.g. Small appliances)">
        <input id="p_model" placeholder="Model">
        <input id="p_price" placeholder="Price range (e.g. $20–40)">
        <input id="p_moq" placeholder="MOQ" type="number">
        <input id="p_markets" placeholder="Target markets (comma sep)">
        <input id="p_certs" placeholder="Certs (CE/FCC/...)">
        <input id="p_images" placeholder="Image URLs (comma sep)">
      </div>
      <textarea id="p_desc" rows="3" placeholder="Description"></textarea>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        <button id="add">Add product</button>
        <button id="toggleImport" class="ghost">Import from link</button>
      </div>
      <div id="importBox" style="display:none;margin-top:10px">
        <input id="p_url" placeholder="https://your-own-site.com/product-page  (own/authorized content only)">
        <button id="doImport" class="ghost">Fetch & autofill</button>
        <div class="red-note">Red line: only import your own content or authorized brand material. Do not scrape third-party / Amazon listings — copyright & trademark risk.</div>
      </div>
      <div id="plist" style="margin-top:12px"></div>
    </div>

    <div class="card">
      <h2>Inquiries</h2>
      <table><thead><tr><th>From</th><th>Company</th><th>Message</th><th>Status</th></tr></thead><tbody id="ilist"></tbody></table>
    </div>

    <div class="card">
      <h2>Settings · Stripe Connected Account</h2>
      <div class="sub">Each vendor gets its own Stripe connected account under platform <b>Brand partner Co., Ltd (HK)</b>. Sample-order payments go directly to this account; the platform takes a commission. Bulk orders settle by bank transfer + Escrow.com.</div>
      <div class="grid2">
        <input id="stripe_acct" placeholder="Stripe Connected Account ID (acct_xxx)">
      </div>
      <button id="saveStripe">Save Stripe account</button>
      <div class="red-note">Red line: only enter YOUR OWN Stripe connected account. Never use a third party's account.</div>
    </div>

    <div class="card">
      <h2>Orders <span class="pill" id="ocount">0</span></h2>
      <div class="sub">Sample orders &rarr; pay online via Stripe (your connected account). Bulk orders &rarr; settle by bank transfer + Escrow.com.</div>
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <button class="ghost otab" data-f="all">All</button>
        <button class="ghost otab" data-f="sample">Sample</button>
        <button class="ghost otab" data-f="bulk">Bulk</button>
      </div>
      <div class="grid2">
        <select id="o_type"><option value="sample">Sample (Stripe)</option><option value="bulk">Bulk (Escrow/bank)</option></select>
        <input id="o_product" placeholder="Product / model *">
        <input id="o_buyer" placeholder="Buyer name">
        <input id="o_email" placeholder="Buyer email">
        <input id="o_company" placeholder="Buyer company">
        <input id="o_qty" type="number" placeholder="Qty" value="1">
        <input id="o_amount" type="number" placeholder="Amount (sample total / bulk value)">
        <input id="o_currency" placeholder="Currency (USD)" value="USD">
      </div>
      <textarea id="o_notes" rows="2" placeholder="Notes"></textarea>
      <div style="margin-top:8px"><button id="addOrder">Create order</button></div>
      <div id="olist" style="margin-top:12px"></div>
    </div>
  </div>
  <script>
  const $=id=>document.getElementById(id);
  async function me(){const r=await fetch('/api/me');return r.ok?await r.json():null;}
  async function load(){
    const u=await me(); if(!u){location.href='/login';return;}
    $('company').textContent=u.company;
    $('stripe_acct').value=u.stripeAccountId||'';
    const pr=await (await fetch('/api/products')).json();
    $('pcount').textContent=pr.length;
    $('plist').innerHTML=pr.map(p=>'<div class="prod" data-id="'+p.id+'"><div><b>'+esc(p.name)+'</b> <span class="meta">'+esc(p.category||'')+'</span><br><span class="meta">'+esc(p.model||'')+' · '+esc(p.priceRange||'')+' · MOQ '+p.moq+' · '+esc(p.markets||'')+'</span><br><span class="meta">'+esc((p.description||'').slice(0,90))+'</span></div><div><button class="ghost delbtn">Delete</button></div></div>').join('')||'<div class="sub">No products yet.</div>';
    const ir=await (await fetch('/api/inquiries')).json();
    $('ilist').innerHTML=ir.map(i=>'<tr><td>'+esc(i.email||'')+'</td><td>'+esc(i.company||'')+'</td><td>'+esc((i.message||'').slice(0,80))+'</td><td><select data-id="'+i.id+'" class="stsel"><option '+(i.status==='new'?'selected':'')+'>new</option><option '+(i.status==='contacted'?'selected':'')+'>contacted</option><option '+(i.status==='deal'?'selected':'')+'>deal</option></select></td></tr>').join('')||'<tr><td colspan="4" class="sub">No inquiries yet.</td></tr>';
    loadOrders();
  }
  let allOrders=[];
  async function loadOrders(){ allOrders=await (await fetch('/api/orders')).json(); $('ocount').textContent=allOrders.length; renderOrders(); }
  function renderOrders(){
    const f=window._otab||'all';
    const list=allOrders.filter(o=>f==='all'||o.type===f);
    $('olist').innerHTML=list.map(o=>{
      const isSample=o.type==='sample';
      let pay='';
      if(isSample){
        if(o.status==='draft') pay='<button class="ghost paybtn" data-id="'+o.id+'">Pay via Stripe</button>';
        else if(o.stripeCheckoutUrl) pay='<a class="ghost" href="'+o.stripeCheckoutUrl+'" target="_blank" rel="noopener">Stripe link</a>';
      } else {
        pay='<input class="escrowin" data-id="'+o.id+'" placeholder="Escrow ref" value="'+esc(o.escrowRef||'')+'" style="width:110px;display:inline-block;margin:0">';
      }
      return '<div class="prod" data-id="'+o.id+'"><div><b>'+esc(o.productRef)+'</b> <span class="meta">'+esc(o.type)+' · '+esc(o.currency||'')+' '+esc(o.amount||'')+' · '+esc(o.qty||'')+'pcs</span><br><span class="meta">'+esc(o.buyerName||'')+' · '+esc(o.buyerCompany||'')+' · '+esc(o.buyerEmail||'')+'</span><br><span class="meta">status: '+esc(o.status)+'</span></div><div>'+pay+'<select class="ostatus" data-id="'+o.id+'"><option '+(o.status==='draft'?'selected':'')+'>draft</option><option '+(o.status==='awaiting_payment'?'selected':'')+'>awaiting_payment</option><option '+(o.status==='paid'?'selected':'')+'>paid</option><option '+(o.status==='shipped'?'selected':'')+'>shipped</option><option '+(o.status==='completed'?'selected':'')+'>completed</option><option '+(o.status==='disputed'?'selected':'')+'>disputed</option></select><button class="ghost delobtn">Delete</button></div></div>';
    }).join('')||'<div class="sub">No orders yet.</div>';
  }
  async function payStripe(id){const r=await fetch('/api/orders/'+id+'/checkout',{method:'POST'});const j=await r.json();if(!r.ok){alert(j.error||'Failed');return;}if(j.mock){alert('Mock checkout (no STRIPE_SECRET_KEY set). Link: '+j.checkoutUrl);}else{window.open(j.checkoutUrl,'_blank');}loadOrders();}
  async function delOrder(id){await fetch('/api/orders/'+id,{method:'DELETE'});loadOrders();}
  async function setOrderStatus(id,v){await fetch('/api/orders/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:v})});}
  async function setEscrow(id,v){await fetch('/api/orders/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({escrowRef:v})});}
  function esc(s){return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
  async function del(id){await fetch('/api/products/'+id,{method:'DELETE'});load();}
  async function st(id,v){await fetch('/api/inquiries/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:v})});}
  document.addEventListener('click',e=>{
    const b=e.target.closest('.delbtn');if(b){del(b.closest('.prod').dataset.id);}
    const pb=e.target.closest('.paybtn');if(pb){payStripe(pb.dataset.id);}
    const ob=e.target.closest('.delobtn');if(ob){delOrder(ob.closest('.prod').dataset.id);}
    const t=e.target.closest('.otab');if(t){window._otab=t.dataset.f;renderOrders();}
  });
  document.addEventListener('change',e=>{
    const s=e.target.closest('.stsel');if(s){st(s.dataset.id,s.value);}
    const os=e.target.closest('.ostatus');if(os){setOrderStatus(os.dataset.id,os.value);}
    const ei=e.target.closest('.escrowin');if(ei){setEscrow(ei.dataset.id,ei.value);}
  });
  $('add').onclick=async()=>{const b={name:$('p_name').value,category:$('p_category').value,model:$('p_model').value,priceRange:$('p_price').value,moq:$('p_moq').value,markets:$('p_markets').value,certs:$('p_certs').value,images:$('p_images').value,description:$('p_desc').value};
    if(!b.name){alert('Name required');return;} const r=await fetch('/api/products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}); if(r.ok){['p_name','p_category','p_model','p_price','p_moq','p_markets','p_certs','p_images','p_desc'].forEach(i=>$(i).value='');load();} };
  $('toggleImport').onclick=()=>{$('importBox').style.display=$('importBox').style.display==='none'?'block':'none';};
  $('doImport').onclick=async()=>{const url=$('p_url').value; if(!url){alert('URL required');return;}
    const r=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})}); const j=await r.json();
    if(!r.ok){alert(j.error||'Import failed');return;}
    $('p_name').value=j.name||''; $('p_category').value=j.category||''; $('p_model').value=j.model||''; $('p_desc').value=j.description||''; $('p_images').value=(j.images||[]).join(', '); $('p_url').dataset.src=url;
    alert('Autofilled. Review & click "Add product" to publish (source = import).'); };
  $('addOrder').onclick=async()=>{const b={type:$('o_type').value,productRef:$('o_product').value,buyerName:$('o_buyer').value,buyerEmail:$('o_email').value,buyerCompany:$('o_company').value,qty:$('o_qty').value,amount:$('o_amount').value,currency:$('o_currency').value,notes:$('o_notes').value};
    if(!b.productRef){alert('Product required');return;}const r=await fetch('/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});if(r.ok){$('o_product').value='';$('o_notes').value='';loadOrders();}};
  $('saveStripe').onclick=async()=>{const r=await fetch('/api/me',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({stripeAccountId:$('stripe_acct').value})});if(r.ok){alert('Stripe account saved.');}};
  $('logout').onclick=async()=>{await fetch('/api/logout',{method:'POST'});location.href='/login';};
  load();
  </script></body></html>`;
}

// 买家登录页（支持 ?token= 免密登录 / ?email= 预填）
function pageBuyerLogin() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Buyer sign in — China Selection</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:#f6f7f9;color:#14151a;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.box{background:#fff;border:1px solid #e7e8ec;border-radius:16px;padding:32px;width:360px;box-shadow:0 8px 30px rgba(20,21,26,.06)}
.logo{font-weight:800;font-size:20px;margin-bottom:4px}.logo span{color:#C8102E}
.sub{color:#5b6170;font-size:13px;margin-bottom:18px}
label{display:block;font-size:13px;font-weight:600;margin:12px 0 5px}
input{padding:11px 12px;border:1px solid #e7e8ec;border-radius:9px;font-size:14px;width:100%;box-sizing:border-box}
.btn{margin-top:18px;width:100%;padding:12px;border:none;border-radius:10px;background:#C8102E;color:#fff;font-weight:600;font-size:15px;cursor:pointer}
.toggle{margin-top:14px;font-size:13px;color:#5b6170;text-align:center;cursor:pointer}
.toggle a{color:#C8102E;font-weight:600}
.ok{font-size:13px;color:#C8102E;margin-top:10px;min-height:16px}
h2{font-size:20px;margin:0 0 2px}</style></head>
<body><div class="box">
<div class="logo">China<span>Selection</span></div>
<div class="sub">Buyer account — track samples & bulk orders</div>
<div id="form"><h2 id="title">Sign in</h2>
<label>Email</label><input id="email" type="email" placeholder="you@company.com">
<label>Password</label><input id="pw" type="password" placeholder="••••••••">
<button class="btn" id="submit">Sign in</button>
<div class="ok" id="ok"></div>
<div class="toggle" id="toggle">New here? <a>Create an account</a></div></div>
</div>
<script>
var mode='login';
function params(){return new URLSearchParams(location.search);}
var tok=params().get('token');
if(tok){fetch('/api/buyer/token-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:tok})}).then(function(r){return r.json();}).then(function(j){if(j.ok)location.href='/buyer-dashboard';else{document.getElementById('ok').textContent='Login link invalid or expired.';}});}
if(params().get('email'))document.getElementById('email').value=params().get('email');
document.getElementById('toggle').onclick=function(){mode=mode==='login'?'register':'login';document.getElementById('title').textContent=mode==='login'?'Sign in':'Create account';document.getElementById('submit').textContent=mode==='login'?'Sign in':'Create account';document.getElementById('toggle').innerHTML=mode==='login'?'New here? <a>Create an account</a>':'Have an account? <a>Sign in</a>';};
document.getElementById('submit').onclick=async function(){
  var email=document.getElementById('email').value.trim(),pw=document.getElementById('pw').value;
  if(!email||!pw){document.getElementById('ok').textContent='Email and password required.';return;}
  var url=mode==='login'?'/api/login':'/api/buyer/register';
  var r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:email,email:email,password:pw})});
  var j=await r.json();
  if(!r.ok){document.getElementById('ok').textContent=j.error||'Failed.';return;}
  location.href='/buyer-dashboard';
};
</script></body></html>`;
}

// 买家后台：订单（样品/大货）、付款、复购、发起大货 escrow
function pageBuyerDashboard() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Buyer dashboard — China Selection</title>
<style>:root{--red:#C8102E;--ink:#14151a;--muted:#5b6170;--line:#e7e8ec;--soft:#f6f7f9}
*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:var(--soft);color:var(--ink)}
nav{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;background:#fff;border-bottom:1px solid var(--line)}
.logo{font-weight:800;font-size:19px}.logo span{color:var(--red)}
.wrap{max-width:980px;margin:0 auto;padding:24px}
h2{font-size:24px;font-weight:800;margin:8px 0 4px}.lead{color:var(--muted);margin-bottom:20px}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:14px}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.tag{font-size:11px;font-weight:700;text-transform:uppercase;padding:3px 9px;border-radius:999px;background:#eef1f6;color:var(--muted)}
.tag.sample{background:#e7f6ec;color:#1c7a3e}.tag.bulk{background:#fff5ec;color:#b9690f}
.st{font-size:12px;color:var(--muted);margin-top:6px}
.btn{padding:9px 16px;border-radius:9px;font-weight:600;font-size:14px;cursor:pointer;border:1px solid transparent}
.btn-primary{background:var(--red);color:#fff}.btn-ghost{background:#fff;border-color:var(--line);color:var(--ink)}
.bulkf{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px;margin-top:26px}
.bulkf h3{font-size:18px;margin-bottom:12px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.bulkf input,.bulkf textarea{padding:10px 12px;border:1px solid var(--line);border-radius:9px;font-size:14px;width:100%;font-family:inherit}
.bulkf label{font-size:13px;font-weight:600;margin:8px 0 4px;display:block}
.foot{text-align:center;color:var(--muted);font-size:13px;padding:24px}
@media(max-width:680px){.grid2{grid-template-columns:1fr}}</style></head>
<body><nav><div class="logo">China<span>Selection</span></div><div><span id="who" style="color:var(--muted);font-size:14px;margin-right:14px"></span><button class="btn btn-ghost" id="logout">Log out</button></div></nav>
<div class="wrap">
<h2>My orders</h2><div class="lead">Track your sample purchases and bulk (escrow) requests.</div>
<div id="orders"></div>
<div class="bulkf"><h3>Request a bulk order (settles via Escrow.com)</h3>
<div class="grid2"><div><label>Supplier (vendor username)</label><input id="b_vendor" placeholder="e.g. demo1"></div><div><label>Product</label><input id="b_ref" placeholder="e.g. Robot Vacuum X1"></div></div>
<div class="grid2"><div><label>Quantity</label><input id="b_qty" type="number" value="500"></div><div><label>Estimated amount (USD)</label><input id="b_amt" type="number" placeholder="120000"></div></div>
<label>Message to supplier</label><textarea id="b_msg" placeholder="Target market, specs, timeline…"></textarea>
<button class="btn btn-primary" id="b_submit" style="margin-top:14px">Send bulk request</button><div class="ok" id="b_ok" style="font-size:13px;color:var(--red);margin-top:10px"></div>
</div>
<div class="foot">Samples are paid via Stripe to the supplier's own account. Bulk orders settle by bank transfer + Escrow.com — no funds are held by China Selection.</div>
</div>
<script>
var $=function(id){return document.getElementById(id);};
function esc(s){return (s||'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
async function load(){
  var me=await (await fetch('/api/buyer/me')).json(); if(!me.id){location.href='/buyer-login';return;}
  $('who').textContent=me.email;
  var list=await (await fetch('/api/buyer/orders')).json();
  if(!list.length){$('orders').innerHTML='<div class="card">No orders yet. Browse the <a href="/directory" style="color:var(--red)">Supply Directory</a> to order a sample.</div>';return;}
  $('orders').innerHTML=list.map(function(o){
    var pay=(o.type==='sample'&&o.status!=='paid'&&o.status!=='cancelled')?'<button class="btn btn-primary" data-pay="'+o.id+'">Pay via Stripe</button>':'';
    var cancel=(o.status==='awaiting_payment')?'<button class="btn btn-ghost" data-cancel="'+o.id+'">Cancel</button>':'';
    var payinfo=(o.type==='sample'&&o.status==='awaiting_payment')?' · <a href="'+esc(o.stripeCheckoutUrl||'')+'" style="color:var(--red)">Stripe link</a>':'';
    return '<div class="card"><div class="row"><div><span class="tag '+o.type+'">'+o.type+'</span> <b>'+esc(o.productRef)+'</b><br><span class="st">Supplier: '+esc(o.vendorCompany||o.vendorUser)+' · Qty '+esc(o.qty)+' · '+(o.currency||'USD')+' '+esc(o.amount)+'</span></div><div>'+pay+cancel+'</div></div><div class="st">Status: '+esc(o.status)+payinfo+(o.escrowRef?(' · Escrow: '+esc(o.escrowRef)):'')+'</div></div>';
  }).join('');
}
document.addEventListener('click',function(e){
  var p=e.target.closest('[data-pay]'); if(p){pay(p.dataset.pay);return;}
  var c=e.target.closest('[data-cancel]'); if(c){cancel(c.dataset.cancel);return;}
});
async function pay(id){var r=await fetch('/api/buyer/orders/'+id+'/checkout',{method:'POST'});var j=await r.json();if(!r.ok){alert(j.error||'Failed');return;}if(j.mock){alert('DEMO (no Stripe key): would open '+j.checkoutUrl);}else{location.href=j.checkoutUrl;}}
async function cancel(id){var r=await fetch('/api/buyer/orders/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'cancelled'})});if(r.ok)load();}
$('logout').onclick=async function(){await fetch('/api/logout',{method:'POST'});location.href='/buyer-login';};
$('b_submit').onclick=async function(){
  var b={vendor:$('b_vendor').value.trim(),productRef:$('b_ref').value.trim(),qty:$('b_qty').value,amount:$('b_amt').value,message:$('b_msg').value};
  if(!b.vendor||!b.productRef){$('b_ok').textContent='Supplier and product required.';return;}
  var r=await fetch('/api/buyer/bulk-request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});var j=await r.json();
  if(!r.ok){$('b_ok').textContent=j.error||'Failed.';return;}
  $('b_ok').style.color='#1c7a3e';$('b_ok').textContent='✓ Bulk request sent to '+b.vendor+'. They will follow up on Escrow.';$('b_msg').value='';load();
};
load();
</script></body></html>`;
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const path = u.pathname;
  const method = req.method;

  try {
    // 页面
    if (method === 'GET' && path === '/') { const user = userFromReq(req); res.writeHead(302, { Location: user ? '/dashboard' : '/login' }); return res.end(); }
    if (method === 'GET' && path === '/login') return res.end(pageLogin());
    if (method === 'GET' && path === '/dashboard') {
      const user = userFromReq(req);
      if (!user) { res.writeHead(302, { Location: '/login' }); return res.end(); }
      return res.end(pageDashboard());
    }
    if (method === 'GET' && path === '/buyer-login') return res.end(pageBuyerLogin());
    if (method === 'GET' && path === '/buyer-dashboard') {
      const t = new URL(req.url, 'http://' + req.headers.host).searchParams.get('t');
      const u = userFromReq(req) || tokenBuyer(t);
      if (!u || u.role !== 'buyer') { res.writeHead(302, { Location: '/buyer-login' }); return res.end(); }
      return res.end(pageBuyerDashboard());
    }

    // API
    if (path.startsWith('/api/')) {
      const user = userFromReq(req);

      // 跨域预检
      if (method === 'OPTIONS') return sendCORS(res, 204);

      // Stripe Webhook：Stripe 不带 session cookie，须在登录校验前处理
      if (path === '/api/stripe/webhook' && method === 'POST') {
        const raw = await readRaw(req);
        const sig = req.headers['stripe-signature'] || '';
        if (!verifyStripeSig(raw, sig)) return sendJSON(res, 400, { error: 'bad signature' });
        let ev; try { ev = JSON.parse(raw); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
        if (ev.type === 'checkout.session.completed') {
          const oid = ev.data && ev.data.object && ev.data.object.client_reference_id;
          const ord = db.orders.find(o => o.id === oid);
          if (ord && ord.status !== 'paid') { ord.status = 'paid'; ord.updatedAt = new Date().toISOString(); saveDB(); }
        }
        return sendJSON(res, 200, { received: true });
      }

      // 公开询盘入口（A 站表单调用，免登录）：按 vendor 用户名路由到对应商家账号；无 vendor 或查不到则入平台收件箱
      if (path === '/api/public/inquiry' && method === 'POST') {
        const b = await readBody(req);
        if (!b.email) return sendJSON(res, 400, { error: 'email required' });
        let ownerId = PLATFORM_INBOX;
        let routedTo = 'platform';
        if (b.vendor) {
          const v = db.users.find(x => x.username === String(b.vendor).trim());
          if (v) { ownerId = v.id; routedTo = v.username; }
        }
        const i = {
          id: 'i' + crypto.randomBytes(6).toString('hex'),
          ownerId,
          email: String(b.email).slice(0, 200),
          company: String(b.company || b.name || '').slice(0, 200),
          message: ('[' + (b.type || 'website') + '] ' + (b.message || '')).slice(0, 2000),
          status: 'new',
          source: 'website',
          createdAt: new Date().toISOString()
        };
        db.inquiries.push(i); saveDB();
        return sendJSON(res, 200, { ok: true, id: i.id, routedTo });
      }

      // 公开：买家搜索供应商产品（无需登录）。支持 ?q=&category=&market= 过滤
      if (path === '/api/public/products' && method === 'GET') {
        const u = new URL(req.url, 'http://localhost');
        const q = (u.searchParams.get('q') || '').toLowerCase().trim();
        const cat = (u.searchParams.get('category') || '').toLowerCase().trim();
        const market = (u.searchParams.get('market') || '').toLowerCase().trim();
        const list = db.products.map(p => {
          const v = db.users.find(x => x.id === p.ownerId);
          return {
            id: p.id, name: p.name, category: p.category || '', model: p.model || '',
            priceRange: p.priceRange || '', moq: p.moq, markets: p.markets || '',
            certs: p.certs || '', images: p.images || '', description: p.description || '',
            vendor: v ? v.username : '', vendorCompany: v ? v.company : '',
            hasStripe: !!(v && v.stripeAccountId)
          };
        }).filter(p => {
          if (cat && (p.category || '').toLowerCase() !== cat) return false;
          if (market && !((p.markets || '').toLowerCase().includes(market))) return false;
          if (q) {
            const hay = (p.name + ' ' + p.category + ' ' + p.description + ' ' + p.markets + ' ' + p.model + ' ' + p.vendorCompany).toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        });
        return sendJSON(res, 200, { count: list.length, products: list });
      }

      // 公开：买家免登录下样品单（款项直达对应 vendor 的 Stripe 子账号，平台抽佣）
      // 同时按 buyerEmail 自动建/查买家账号并关联订单 → 买家信息沉淀，未来可登录看订单
      if (path === '/api/public/order-sample' && method === 'POST') {
        const b = await readBody(req);
        if (!b.vendor) return sendJSON(res, 400, { error: 'vendor required' });
        if (!b.buyerEmail) return sendJSON(res, 400, { error: 'buyerEmail required' });
        const amount = Number(b.amount);
        if (!amount || amount <= 0) return sendJSON(res, 400, { error: 'valid amount required' });
        const v = db.users.find(x => x.username === String(b.vendor).trim());
        if (!v) return sendJSON(res, 404, { error: 'vendor not found' });
        const buyer = findOrCreateBuyer(b.buyerEmail, b.buyerName);
        let ref = b.productRef || 'Sample order';
        if (b.productId) { const pr = db.products.find(x => x.id === b.productId && x.ownerId === v.id); if (pr) ref = pr.name; }
        const o = addOrder(v.id, { type: 'sample', productRef: ref, buyerName: b.buyerName || '', buyerEmail: b.buyerEmail, qty: Number(b.qty) || 1, amount, currency: (b.currency || 'USD').toUpperCase() });
        o.buyerId = buyer ? buyer.id : '';
        try {
          const c = await createSampleCheckout(o, v, buyer ? buyer.buyerToken : '');
          o.stripeCheckoutUrl = c.checkoutUrl; o.stripeSessionId = c.sessionId; o.status = 'awaiting_payment'; o.updatedAt = new Date().toISOString(); saveDB();
          return sendJSON(res, 200, { ok: true, orderId: o.id, checkoutUrl: c.checkoutUrl, mock: c.mock, buyerToken: buyer ? buyer.buyerToken : '', buyerEmail: b.buyerEmail });
        } catch (e) { return sendJSON(res, 400, { error: e.message }); }
      }

      // 买家注册（公开）：用邮箱+密码建买家账号
      if (path === '/api/buyer/register' && method === 'POST') {
        const b = await readBody(req);
        if (!b.email || !b.password) return sendJSON(res, 400, { error: 'email and password required' });
        const email = String(b.email).trim().toLowerCase();
        if (db.users.find(x => x.role === 'buyer' && (x.email === email || x.username === email))) return sendJSON(res, 409, { error: 'email already registered' });
        const u = mkUser(b.name || email.split('@')[0], email, b.password, 'buyer', email);
        db.users.push(u); saveDB(); setCookie(res, newSession(u.id));
        return sendJSON(res, 200, { ok: true, id: u.id, email: u.email });
      }
      // 买家免密令牌登录（公开）：接邮件前用于把 guest 账号转成可登录会话
      if (path === '/api/buyer/token-login' && method === 'POST') {
        const b = await readBody(req);
        const u = tokenBuyer(b.token);
        if (!u) return sendJSON(res, 400, { error: 'invalid or expired token' });
        setCookie(res, newSession(u.id));
        return sendJSON(res, 200, { ok: true });
      }

      if (path === '/api/register' && method === 'POST') {
        const b = await readBody(req);
        if (!b.username || !b.password || !b.company) return sendJSON(res, 400, { error: 'company, username, password required' });
        if (db.users.find(x => x.username === b.username)) return sendJSON(res, 409, { error: 'username taken' });
        const nu = mkUser(b.company, b.username, b.password);
        db.users.push(nu); saveDB();
        setCookie(res, newSession(nu.id));
        return sendJSON(res, 200, { ok: true, id: nu.id, company: nu.company });
      }
      if (path === '/api/login' && method === 'POST') {
        const b = await readBody(req);
        const u2 = db.users.find(x => x.username === b.username || (x.email && x.email === String(b.username || '').trim().toLowerCase()));
        if (!u2 || !verify(b.password || '', u2)) return sendJSON(res, 401, { error: 'invalid credentials' });
        setCookie(res, newSession(u2.id));
        return sendJSON(res, 200, { ok: true, id: u2.id, company: u2.company, role: u2.role });
      }
      if (path === '/api/logout' && method === 'POST') {
        const c = parseCookies(req).cs_session; if (c) delete db.sessions[c]; saveDB(); clearCookie(res);
        return sendJSON(res, 200, { ok: true });
      }
      if (path === '/api/me' && method === 'GET') {
        if (!user) return sendJSON(res, 401, { error: 'unauthorized' });
        return sendJSON(res, 200, { id: user.id, company: user.company, username: user.username, stripeAccountId: user.stripeAccountId || '' });
      }
      if (path === '/api/me' && method === 'PATCH') {
        if (!user) return sendJSON(res, 401, { error: 'unauthorized' });
        const b = await readBody(req);
        if (typeof b.stripeAccountId === 'string') user.stripeAccountId = b.stripeAccountId.trim();
        if (b.company) user.company = b.company;
        saveDB();
        return sendJSON(res, 200, { ok: true, stripeAccountId: user.stripeAccountId });
      }

      // 以下均需登录；并按角色隔离 vendor / buyer 接口
      if (!user) return sendJSON(res, 401, { error: 'unauthorized' });
      const isBuyerApi = path.startsWith('/api/buyer/');
      if (isBuyerApi && user.role !== 'buyer') return sendJSON(res, 403, { error: 'buyer account required' });
      if (!isBuyerApi && user.role !== 'vendor') return sendJSON(res, 403, { error: 'vendor account required' });

      if (path === '/api/products' && method === 'GET') return sendJSON(res, 200, ownedProducts(user.id));
      if (path === '/api/products' && method === 'POST') {
        const b = await readBody(req);
        if (!b.name) return sendJSON(res, 400, { error: 'name required' });
        return sendJSON(res, 200, addProduct(user.id, b));
      }
      let m;
      if ((m = path.match(/^\/api\/products\/(.+)$/)) && method === 'DELETE') {
        const p = findProduct(user.id, m[1]); if (!p) return sendJSON(res, 404, { error: 'not found' });
        db.products = db.products.filter(x => x.id !== m[1]); saveDB(); return sendJSON(res, 200, { ok: true });
      }
      if (path === '/api/import' && method === 'POST') {
        const b = await readBody(req);
        try { return sendJSON(res, 200, await fetchDraftFromUrl(b.url)); }
        catch (e) { return sendJSON(res, 400, { error: e.message }); }
      }
      if (path === '/api/inquiries' && method === 'GET') {
        const list = db.inquiries.filter(i => i.ownerId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return sendJSON(res, 200, list);
      }
      if (path === '/api/inquiries' && method === 'POST') {
        const b = await readBody(req);
        const i = { id: 'i' + crypto.randomBytes(6).toString('hex'), ownerId: user.id, email: b.email || '', company: b.company || '', message: b.message || '', status: 'new', createdAt: new Date().toISOString() };
        db.inquiries.push(i); saveDB(); return sendJSON(res, 200, i);
      }
      if ((m = path.match(/^\/api\/inquiries\/(.+)$/)) && method === 'PATCH') {
        const i = db.inquiries.find(x => x.id === m[1] && x.ownerId === user.id); if (!i) return sendJSON(res, 404, { error: 'not found' });
        const b = await readBody(req); if (b.status) i.status = b.status; saveDB(); return sendJSON(res, 200, i);
      }

      // ---------- 订单 ----------
      if (path === '/api/orders' && method === 'GET') return sendJSON(res, 200, ownedOrders(user.id));
      if (path === '/api/orders' && method === 'POST') {
        const b = await readBody(req);
        if (!b.productRef) return sendJSON(res, 400, { error: 'productRef required' });
        return sendJSON(res, 200, addOrder(user.id, b));
      }
      if ((m = path.match(/^\/api\/orders\/(.+)\/checkout$/)) && method === 'POST') {
        const o = findOrder(user.id, m[1]); if (!o) return sendJSON(res, 404, { error: 'not found' });
        if (o.type !== 'sample') return sendJSON(res, 400, { error: 'only sample orders support Stripe checkout' });
        try {
          const c = await createSampleCheckout(o, user);
          o.stripeCheckoutUrl = c.checkoutUrl; o.stripeSessionId = c.sessionId; o.status = 'awaiting_payment'; o.updatedAt = new Date().toISOString(); saveDB();
          return sendJSON(res, 200, c);
        } catch (e) { return sendJSON(res, 400, { error: e.message }); }
      }
      if ((m = path.match(/^\/api\/orders\/(.+)$/)) && method === 'PATCH') {
        const o = findOrder(user.id, m[1]); if (!o) return sendJSON(res, 404, { error: 'not found' });
        const b = await readBody(req);
        if (b.status) o.status = b.status;
        if (b.escrowRef !== undefined) o.escrowRef = b.escrowRef;
        if (b.notes !== undefined) o.notes = b.notes;
        o.updatedAt = new Date().toISOString(); saveDB(); return sendJSON(res, 200, o);
      }
      if ((m = path.match(/^\/api\/orders\/(.+)$/)) && method === 'DELETE') {
        const o = findOrder(user.id, m[1]); if (!o) return sendJSON(res, 404, { error: 'not found' });
        db.orders = db.orders.filter(x => x.id !== m[1]); saveDB(); return sendJSON(res, 200, { ok: true });
      }

      // ---------- 买家接口（user.role === 'buyer'） ----------
      if (path === '/api/buyer/me' && method === 'GET') {
        return sendJSON(res, 200, { id: user.id, email: user.email, name: user.company, role: user.role });
      }
      if (path === '/api/buyer/orders' && method === 'GET') {
        const list = db.orders.filter(o => o.buyerId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(o => { const v = db.users.find(x => x.id === o.ownerId); return Object.assign({}, o, { vendorCompany: v ? v.company : '', vendorUser: v ? v.username : '' }); });
        return sendJSON(res, 200, list);
      }
      if ((m = path.match(/^\/api\/buyer\/orders\/(.+)\/checkout$/)) && method === 'POST') {
        const o = db.orders.find(x => x.id === m[1] && x.buyerId === user.id); if (!o) return sendJSON(res, 404, { error: 'not found' });
        if (o.type !== 'sample') return sendJSON(res, 400, { error: 'only sample orders support Stripe checkout' });
        if (o.status === 'paid') return sendJSON(res, 400, { error: 'already paid' });
        const v = db.users.find(x => x.id === o.ownerId);
        try {
          const c = await createSampleCheckout(o, v, user.buyerToken);
          o.stripeCheckoutUrl = c.checkoutUrl; o.stripeSessionId = c.sessionId; o.status = 'awaiting_payment'; o.updatedAt = new Date().toISOString(); saveDB();
          return sendJSON(res, 200, c);
        } catch (e) { return sendJSON(res, 400, { error: e.message }); }
      }
      // 买家发起大货单（escrow）：订单归属 vendor，buyerId 指向自己
      if (path === '/api/buyer/bulk-request' && method === 'POST') {
        const b = await readBody(req);
        if (!b.vendor) return sendJSON(res, 400, { error: 'vendor required' });
        const v = db.users.find(x => x.username === String(b.vendor).trim());
        if (!v) return sendJSON(res, 404, { error: 'vendor not found' });
        const o = addOrder(v.id, { type: 'bulk', productRef: b.productRef || 'Bulk order', buyerName: b.buyerName || user.company, buyerEmail: user.email, qty: Number(b.qty) || 1, amount: Number(b.amount) || 0, currency: (b.currency || 'USD').toUpperCase(), notes: b.message || '' });
        o.buyerId = user.id; o.status = 'awaiting_payment';
        saveDB();
        return sendJSON(res, 200, o);
      }
      if ((m = path.match(/^\/api\/buyer\/orders\/(.+)$/)) && method === 'PATCH') {
        const o = db.orders.find(x => x.id === m[1] && x.buyerId === user.id); if (!o) return sendJSON(res, 404, { error: 'not found' });
        const b = await readBody(req);
        if (b.status === 'cancelled' && o.status !== 'paid') { o.status = 'cancelled'; o.updatedAt = new Date().toISOString(); saveDB(); }
        return sendJSON(res, 200, o);
      }

      return sendJSON(res, 404, { error: 'not found' });
    }
    sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`China Selection vendor backend on http://localhost:${PORT}`));
