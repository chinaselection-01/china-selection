# China Selection — Supply Network Vendor Backend (MVP)

B 端「供应网络」的 vendor 后台：每家真实出口实体一个账号，可手动发布产品、从自有链接导入上架、管理询盘。零依赖 Node 服务（不装任何 npm 包），本地直接跑。

> 与 A 端策展站（GitHub Pages 静态站 china-select-site）分离：**A 不放商家后台**，后台只属于 B。详见 `../china_select_architecture.md`。

## 运行（本地）
```bash
cd china-select-backend
node server.js          # 默认 http://localhost:3000 ，可用 PORT 环境变量覆盖
```
首次启动自动生成 `db.json`（含演示账号 `demo1` / `demo1234`）。

## 功能
- **认证**：注册 / 登录 / 登出，scrypt 密码哈希 + HttpOnly session cookie。每家 vendor 只能读写自己的数据。
- **产品发布（手动）**：字段 = 品类 / 名称 / 型号 / 价格区间 / MOQ / 目标市场 / 认证 / 图片 / 描述。
- **链接导入**：粘贴一个链接 → 服务端抓取 → 解析 title / og:description / og:image / og:title → 自动填字段 → 前端确认后发布（不直接发布，防误填）。
- **AI 改写**：`aiRewrite()` 现为占位（无 LLM key 时返回原文）。接入大模型后替换该函数即可做描述改写 / 多语言翻译（目标市场含俄 / 阿语时尤其有用）。
- **询盘管理**：接收询盘、状态标记 new / contacted / deal。
- **订单管理（样品 / 大货双轨）**：每家 vendor 在自己的后台建订单。样品单 → 一键生成 **Stripe Checkout 链接**（款项直达该 vendor 的 Stripe Connected Account 子账号，平台抽佣）；大货单 → 填 Escrow 单号 + 对公转账标记。
- **Stripe Connected Account**：每家 vendor 在 Settings 填自己的 `acct_xxx`（平台主体 Brand partner Co., Ltd 香港），样品收款直达自家子账号。
- **买家账号（自动建 + 登录后台）**：买家在搜索页免登录下样品单时，后端按 `buyerEmail` 自动建/查一个 `role:'buyer'` 账号并关联订单（关系沉淀，不丢买家信息）。买家可用邮箱+密码注册/登录，或凭下单时返回的免密令牌（`buyerToken`）登录。买家后台 `/buyer-dashboard`：看自己的样品/大货订单、付款、复购、发起大货 escrow 请求。vendor / buyer 接口按角色隔离（403 互防）。

## 支付模型（详见 `../china_select_architecture.md` §3.4 / §3.5）
- **样品（首次合作小额）走 Stripe**：买家点 Checkout 信用卡付款，钱直达 vendor 的 connected account，平台按 `PLATFORM_FEE_RATE` 抽佣（默认 5%）。后端用 Stripe REST 直连 + `Stripe-Account` 头实现 Connect 分账，无需 stripe npm 包。
- **大货（大额）走对公 + Escrow.com**：不在线收款，后台只记 Escrow 单号与状态，资金由持牌托管方处理。
- Webhook `/api/stripe/webhook` 用内置 crypto 手验签名，付款成功后自动把订单置为 `paid`。

## 环境变量（均可选；缺省降级为 mock 以便本地跑通）
| 变量 | 默认 | 说明 |
|---|---|---|
| `STRIPE_SECRET_KEY` | 空 | 平台主体（Brand partner Co., Ltd）Stripe Secret Key。空 → Checkout/webhook 走 mock。 |
| `STRIPE_WEBHOOK_SECRET` | 空 | Webhook 签名密钥。空 → 不验签（仅本地调试，生产必填）。 |
| `PLATFORM_FEE_RATE` | 0.05 | 平台抽佣比例。 |
| `PUBLIC_BASE` | http://localhost:3000 | Checkout 成功回跳 base URL。 |

## API
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/register` | `{company,username,password}` |
| POST | `/api/login` | 返回 session cookie |
| POST | `/api/logout` | |
| GET  | `/api/me` | 当前用户（含 `stripeAccountId`） |
| PATCH | `/api/me` | `{stripeAccountId?, company?}` 保存 Stripe 子账号 |
| GET/POST | `/api/products` | 列表 / 新增（需登录） |
| DELETE | `/api/products/:id` | 删除自己的产品 |
| POST | `/api/import` | `{url}` → 返回抓取草稿 |
| GET/POST | `/api/inquiries` | 列表 / 新增（需登录） |
| PATCH | `/api/inquiries/:id` | `{status}` |
| GET/POST | `/api/orders` | 列表 / 新增（需登录） |
| POST | `/api/orders/:id/checkout` | 样品单 → 生成 Stripe Checkout（需 vendor 已填 connected account） |
| PATCH | `/api/orders/:id` | `{status?, escrowRef?, notes?}` |
| DELETE | `/api/orders/:id` | 删除订单 |
| POST | `/api/stripe/webhook` | Stripe Webhook（无需登录，验签后把订单置 paid） |
| GET  | `/api/public/products` | **买家公开搜索**：跨所有 vendor 的产品，支持 `?q=&category=&market=`。返回含 `vendor` / `vendorCompany` / `hasStripe`。无需登录。 |
| POST | `/api/public/inquiry` | **买家免登录询盘**：`{vendor, name?, email, type?, message}`。按 vendor 路由进对应商家账号；未知 vendor 落入平台收件箱。 |
| POST | `/api/public/order-sample` | **买家免登录下样品单**：`{vendor, productId?, buyerName?, buyerEmail, qty?, amount, currency?}`。按邮箱自动建/查买家账号并关联订单，生成 Stripe Checkout（款项直达该 vendor 子账号）。返回 `buyerToken`（用于免密登录买家后台）。无 key 时返回 mock 链接。 |
| POST | `/api/buyer/register` | 买家注册：`{email, password, name?}`（公开） |
| POST | `/api/buyer/token-login` | 买家免密令牌登录：`{token}`（公开；接邮件前用于把 guest 账号转成会话） |
| GET  | `/api/buyer/me` | 当前买家（需 buyer 登录） |
| GET  | `/api/buyer/orders` | 买家的全部订单（含供应商公司名） |
| POST | `/api/buyer/orders/:id/checkout` | 买家为样品单付款（Stripe Checkout，需 sample 且未付） |
| POST | `/api/buyer/bulk-request` | 买家发起大货单（escrow）：`{vendor, productRef?, qty?, amount?, message?}`，订单归属该 vendor、buyerId 指向自己 |
| PATCH| `/api/buyer/orders/:id` | 买家取消订单（仅未付时 `{status:'cancelled'}`） |

页面：`/login`（vendor 登录+注册）、`/dashboard`（vendor 后台：产品 / 询盘 / 设置 / 订单）、`/buyer-login`（买家登录/注册，支持 `?token=` 免密登录）、`/buyer-dashboard`（买家后台：订单 / 付款 / 复购 / 大货 escrow）。
买家端搜索页：`../directory.html`（静态页，挂在 A 站域名下；通过 `?backend=` 指向后端公网地址，或改文件内 `BACKEND` 常量）。

## 红线（务必遵守，见架构文档 §3.2 / §六）
1. **链接导入只接受「自有内容」或「已授权品牌方素材」**。无授权抓取亚马逊 / 竞品图文 = 版权 + 商标侵权，欧美尤严。导入前由导入者自行确认授权。
2. **本服务不碰资金池**。样品收款经 Stripe Connect 直达各 vendor 的 connected account（平台仅抽佣，不截留）；大货资金由 Escrow.com 等持牌第三方托管（见 `../china_select_trust_flow.md`）。任何文案不得写 "funds held by China Selection / we guarantee payment"。

## 部署（GitHub Pages 只能托管静态，后台需另行部署；CloudStudio 仅支持纯静态站，跑不了 Node 服务，故用 Render）
本后端是 Node 服务，**不能用 CloudStudio 部署**（它的 deploy 仅支持纯前端静态站）。用 Render（或 Railway）即可，零 npm 依赖：

**方式 A — render.yaml 一键（推荐）**
1. 把 `china-select-backend/` 目录推到 Git 仓库。
2. Render 控制台 → New → Blueprint → 选该仓库 → 它会读 `render.yaml` 自动建好 Web Service。
3. 在 Render 环境变量里填 `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `PUBLIC_BASE`（无则样品 Checkout 走 mock）；`CORS_ORIGIN` 设为 A 站域名（如 `https://china-selection.com`）。

**方式 B — 手动建 Web Service**
- New → Web Service → 连接仓库 → Build Command `echo no-build` → Start Command `node server.js` → 加环境变量（同上）。

**部署后必做**
- 把 A 站 `china_select_mvp.html` 里的 `const BACKEND = 'http://localhost:3000'` 改成你的 Render 公网 URL。
- `CORS_ORIGIN` 设为 A 站域名，否则浏览器会拦截跨域提交。
- 数据持久化：`db.json` 在临时文件系统会被重置——生产建议换成 SQLite（`better-sqlite3`）或外部数据库 / 挂载持久卷。本 MVP 用 JSON 仅为快速验证。
- 域名：可在 `china-selection.com` 下用子路径（如 `/network`）反代，或独立子域。`STRIPE_WEBHOOK_SECRET` 对应 Stripe 后台配的 Webhook 地址：`https://<你的backend>/api/stripe/webhook`。

## 后续迭代建议
- 真实数据库替换 JSON；多图上传（现仅支持图片 URL）；AI 改写接入 LLM。
- 买家免密令牌目前靠前端回显/链接传递（无邮件）。接邮件服务（Resend / SendGrid 等）后，应在 guest 下单后自动发送含 `buyerToken` 的登录链接，而不是由前端暴露令牌。
- A 站留资表单已对接本后端（免登录询盘），搜索页 `directory.html` 已支持买家搜索 / 询盘 / 样品下单，并可在下单后跳转买家后台。
