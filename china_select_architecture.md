# China Selection 架构分法：A 策展引流 / B 自有供应网络（分开）

> 决策日期：2026-08-19
> 用户已确认：五六家公司是**真实出口实体**（有真产品、能出货）；要 **A 和 B 都要，但分开**。

---

## 一、核心原则：信任资产不能混

China Selection 最大的资产是"**独立第三方策展眼光**"。一旦把自家公司塞进策展清单当"入驻商家"，这个信任瞬间归零。

所以严格分两套：

| | A · China Selection（策展站） | B · Supply Network（供应网络） |
|---|---|---|
| 定位 | 独立第三方策展 / 流量入口 | 你真实的出口实体集合，透明展示 |
| 域名 | china-selection.com | 子路径 `/network` 或独立站 china-time-honored-brand.com |
| 内容 | 可公开引用、注明来源的真实品牌（Roborock/Dreame…） | 你旗下各公司的真实产品 |
| 关联声明 | 不出现自家公司 | **作为「Sponsored 赞助商」分区展示，明确标注付费 + 关联（affiliated sponsor）** |
| 后端 | 无商家后台（编辑自己更新） | 每家有 vendor 后台，可发产品 |
| 收口 | 引流 → 留资 → 你接单 / Escrow.com | 直接接单（真实公司签约出货） |

A 和 B 之间**只做单向导流**：A 的清单吸引来的、匹配你供应能力的询盘，引导到 B 接单。但 B 的产品**不出现在 A 的策展清单里**。

---

## 二、A 端（China Selection 策展站）——保持现在

- 已在 GitHub Pages 上线（仓库 `china-selection`）。
- 冷启动内容：Issue 01 小家电（10 个真实出海品牌），后续 Issue 02 充电宝、Issue 03 杯子。
- 不塞任何自家公司，标注 "editorial selection / as featured"，注明来源。
- trust bar 加 "funds held in escrow by a licensed third party (Escrow.com) until goods verified" —— 仅作流程说明，不碰钱。

---

## 三、B 端（Supply Network 供应网络）—— 给真实出口实体建透明后台

### 3.1 页面层（访客看）—— 用「Sponsored 赞助商」分区，而非伪装成策展
- 在 China Selection 内**单独划一个 "Sponsored Partners / 赞助商" 区**，和编辑策展清单（Issue 01 小家电等）**物理分隔、视觉区分（角标 Sponsored）**。
- 每家赞助商：公司名、负责品类、简介、**明确标注 "Sponsored · affiliated exporter（付费赞助 · 关联出口实体）"**、各自网站链接、能出货的证明（过往提单/客户评价可选）。
- 每家有产品列表页。
- **为什么不伪装**：标注 Sponsored = 如实声明商业关系，是合法广告模型（FTC/各国都要求披露付费关系）；而把自家公司塞进"策展精选"假装独立推荐，才是欺骗、会毁信任。
- **红线**：赞助商产品**绝不进入**编辑策展清单 / 不带 "Selected by China Select" 徽章；赞助区和策展区不得混排。

### 3.1b 「担保感」从哪来（重要）
你担心赞助模式"又没有平台担保的感觉了"——这里要分清楚两件事：
- **策展信任**（"这清单挑得好"）：来自 A 的独立编辑眼光，靠 Roborock/Dreame 这类被市场验证的品牌撑着，和你自家公司无关。
- **交易安全**（"钱付了货不对板怎么办"）：**不靠"平台担保"，靠 Escrow.com 资金托管**——见 `china_select_trust_flow.md`。任何地方都不得写 "China Selection guarantees / we hold your money"，托管主语只能是持牌第三方。

所以"担保感"来自**escrow 流程的透明**，不是来自"假装这些公司是我们独立挑的好货"。赞助商如实标注 Sponsored，交易仍走 Escrow.com，买家该有的安全感一点不少，还更诚实。

### 3.2 后台层（每家 vendor 登录）
每家实体一个账号，登录后可用功能：

1. **发布产品（手动）**
   - 字段：品类、名称、规格、价格区间、MOQ、目标市场、认证、图片、描述。
2. **AI 从链接导入上架**（用户明确要求）
   - 流程：粘贴一个链接 → 抓取标题/图/参数 → AI 生成改写后的产品描述 + 自动填充字段 → 预览 → 发布到该商家店。
   - **红线（必须）**：导入源只能是你**自有内容**（你各公司的网站）或**你被授权分销的品牌方素材**。绝不允许无授权抓第三方（亚马逊/竞品）的图文——欧美版权/商标侵权极严。
   - 实现建议：抓取你们自己站点的页面（同源，无版权问题）；若是授权品牌方，要求对方提供可授权链接或素材包。
3. **订单/询盘管理**（基础版）
   - 接收来自 A 导流的询盘，状态标记（新/已联系/成交）。
4. **AI 辅助**
   - 描述多语言翻译（英文/俄/阿语，匹配你的目标市场）。
   - 图片合规检查（尺寸/水印）。

### 3.3 为什么后台放 B 不放 A
A 是策展，不是 marketplace；一旦 A 有"商家后台发产品"，就变成无授权分销平台，合规和信任双崩。后台 + AI 导入只属于 B。

### 3.4 订单与支付模型（样品 / 大货分层）
客户每家 vendor 店铺的下单分两层，匹配不同的金额与信任阶段：

1. **样品订单（sample）— 走 Stripe 在线收款**
   - 场景：海外买家首次合作，先买少量样品验证质量。小额、标准化。
   - 支付：Stripe Checkout（信用卡）。买家选样品 → 生成 Stripe Checkout Session / Payment Link → 付款 → 订单标记 paid → 卖家发货。
   - 每家 vendor 后台配置**自己的 Stripe 账号**，收款进各家账户，平台不碰资金。

2. **大货订单（bulk）— 走对公转账 + Escrow.com**
   - 场景：样品满意后放大货。金额大，需合同/发票/认证。
   - 支付：对公银行账户（打公账）+ 走 Escrow.com 资金托管（验货才放款）。**不走 Stripe**——Stripe 对大额/对公不友好、手续费高、且易触发风控。
   - 状态流转：询价 → 合同 → 付托管/对公 → 发货 → 验货放款。

3. **每家后台必备模块**
   - 订单列表（按 sample / bulk 双标签）
   - Stripe 账号配置入口（填入各家的 publishable / secret key 或 Payment Link）
   - 订单状态机：新 / 已付 / 已发货 / 完成 / 争议
   - 样品单自动出 Stripe 链接；大货单走线下标记 + Escrow 指引

### 3.5 支付主体（已确认）
- **Stripe 不接受中国大陆注册的公司作为收款商户**（2023 年起已不支持中国大陆新注册）。金华的实体若直接用 Stripe 收款会失败。
- **已确认方案：平台用香港主体 Brand partner Co., Ltd 作 Stripe Connect 平台方，各 vendor 作 connected account（收款子账号）。**
  - 香港主体可正常注册 Stripe，满足你"每家后台有自己的 Stripe 收款账号"的要求（每家一个 connected account，各自结算、各自看到自己的订单与流水）。
  - 平台可控资金流：样品单平台统一收（Connect 直连收款 → 分账到对应 vendor connected account，平台抽佣），大货单走线下 + Escrow.com。
  - 合规要点：平台需完成 Stripe Connect 的 KYC/合规审查；每个 connected account 也要完成自身 KYC（平台代为收集或引导 vendor 自行完成）。
- 实现上：后台每家 vendor 配置一个 `stripeAccountId`（connected account），样品单创建 Stripe Checkout Session 时指定 `stripe_account`，款项直达该 vendor 子账号，平台佣金通过 `application_fee_amount` 抽取。

---

## 四、A ↔ B 导流（唯一衔接点）

```
China Selection 策展清单（吸引海外买家/车商）
        │
        │  "Want this category sourced? Talk to our verified network"
        ▼
Supply Network（透明列出真实出口实体）
        │
        ▼
每家 vendor 后台接单 → Escrow.com 托管 → 发货 → 放款
```

A 不承诺交易，只做"帮你找靠谱中国供应"的引子；B 用真实实体 + Escrow.com 收口。

---

## 五、落地顺序建议

1. **先稳 A**：DNS 配好 china-selection.com、trust bar 文案、继续 Issue 01。
2. **再搭 B 框架**：先做"供应网络"静态展示页（诚实标注关联）+ 每家产品页。
3. **最后做 B 后台 + AI 导入**：这是工程活，需登录/数据库/抓取模块，建议作为独立小项目迭代，且先把"自有内容导入"跑通，授权品牌方后续接。

---

## 六、红线重申

- A 永不放自家公司、永不做商家后台。
- B 的 AI 导入只限自有/授权内容，无授权抓第三方 = 侵权。
- 任何地方不得写 "funds held by China Selection" / "we guarantee payment"——托管主语只能是 Escrow.com 等持牌第三方。
- **样品走 Stripe、大货走对公 + Escrow.com**，金额分层不可混。
- **Stripe 收款主体须为境外可注册地区（港/新/美/欧）**，大陆主体不可用。
