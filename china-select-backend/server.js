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
    const u = mkUser('Demo Exporter 1', 'demo1', 'demo1234');
    seed.users.push(u);
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDB() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
let db = loadDB();

// ---------- 密码 / 会话 ----------
function mkUser(company, username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  // stripeAccountId：该 vendor 在 Stripe 上的 connected account（子账号），由 vendor 在后台填写
  return { id: 'u' + crypto.randomBytes(6).toString('hex'), company, username, salt, hash, stripeAccountId: '', createdAt: new Date().toISOString() };
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
async function createSampleCheckout(order, vendor) {
  if (!vendor.stripeAccountId) throw new Error('Vendor has no Stripe connected account. Set it in Settings first.');
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
    success_url: (process.env.PUBLIC_BASE || 'http://localhost:3000') + '/dashboard?paid=' + order.id,
    cancel_url: (process.env.PUBLIC_BASE || 'http://localhost:3000') + '/dashboard',
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
        const u2 = db.users.find(x => x.username === b.username);
        if (!u2 || !verify(b.password || '', u2)) return sendJSON(res, 401, { error: 'invalid credentials' });
        setCookie(res, newSession(u2.id));
        return sendJSON(res, 200, { ok: true, id: u2.id, company: u2.company });
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

      // 以下均需登录
      if (!user) return sendJSON(res, 401, { error: 'unauthorized' });

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

      return sendJSON(res, 404, { error: 'not found' });
    }
    sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`China Selection vendor backend on http://localhost:${PORT}`));
