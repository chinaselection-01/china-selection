# China Selection 国际贸易信任流程设计

## 一、核心结论

**不要在 China Selection 里自建一个"支付宝/ escrow 平台"。**

自己做资金托管 = 同时当裁判和运动员，会触发全球各地的支付牌照要求：

- 美国：MSB / Money Transmitter License（各州都要）
- 欧盟：Payment Institution / E-Money License
- 英国：FCA 授权
- 中国：跨境支付牌照、外汇管制
- AML/KYC、反洗钱、资金托管、客户备付金、争议仲裁……

这些合规成本足够压垮一个 MVP。

**正确路径：China Selection 做"交易结构设计师 + 撮合方"，资金托管交给持牌的第三方 escrow 服务商。**

---

## 二、推荐方案矩阵（按交易规模和场景）

| 单笔交易额 | 适用场景 | 推荐工具 | China Selection 角色 |
|---|---|---|---|
| **<$5,000** | 样品单、小家电试单、dropship 试单 | PayPal / Stripe + 平台纠纷申诉 | 推荐支付通道，提供订单模板 |
| **$5,000 – $50,000** | 小家电/充电宝 B2B 试单、二手车 1-3 台 | **Escrow.com**（国际 B2B escrow 龙头） | 作为撮合方，引导双方走 escrow 流程；不碰钱 |
| **$50,000 – $500,000** | 整车/二手批量、家电柜货 | **信用证 L/C（Letter of Credit）** + 验货条款 | 推荐合作银行/货代/检验机构，协调文件 |
| **>$500,000 / 长期合作** | 年度供货协议、经销权 | 银行保函 + 里程碑付款 + 年度框架合同 | 提供模板、推荐尽调、参与条款设计 |

> 对 China Selection 当前业务：**$5k-$50k 区间是主战场**，Escrow.com 是最快能上的方案。

---

## 三、Escrow.com 标准流程（China Selection 嵌入版）

```
[海外买家]                        [China Selection]                       [中国供应商]
    |                                   |                                       |
    |--- ① 在 China Selection 看到品牌/车源 ------------------------------>        |
    |                                   |                                       |
    |--- ② 提交意向（表单/邮件） --------> China Selection 审核双方资质 ----------->|
    |                                   |                                       |
    |                                   |--- ③ 拉三方沟通群/邮件，确认 SKU/数量/价格 ---|
    |                                   |                                       |
    |<-- ④ 发 Escrow.com 交易邀请链接 --------------------------------------------|
    |                                   |                                       |
    |--- ⑤ 买家打款到 Escrow.com 托管 ------------------------------------------>|
    |                                   |                                       |
    |<-- ⑥ Escrow.com 确认收款，通知供应商发货 -----------------------------------|
    |                                   |                                       |
    |                                   |--- ⑦ 供应商发货 + 提供提单/运单/检验报告 ---->|
    |                                   |                                       |
    |--- ⑧ 买家收货/验货（约定天数内） ------------------------------------------>|
    |                                   |                                       |
    |--- ⑨ 买家在 Escrow.com 确认放行 ---------- Escrow.com 放款给供应商 ----------->|
    |                                   |                                       |
    |<-- ⑩ China Selection 跟进售后/复购 -----------------------------------------|
```

### 关键控制点

1. **资金不经过 China Selection**：买家 → Escrow.com → 供应商。China Selection 只收撮合服务费（可单独收）。
2. **验收窗口期写死**：一般 7-14 天（海运到港+拆柜验货）。二手车可要求第三方 SGS/Intertek 检验。
3. **争议处理归 Escrow.com**：它有自己的仲裁流程。China Selection 可协助沟通，但不做最终裁决。
4. **费用谁出**：通常买家出 escrow 费，或双方各一半。在报价单里提前写明。

---

## 四、对 China Selection 的价值

| 不做信任流程 | 做 Escrow 引导后 |
|---|---|
| "先发钱，我再发货"——买家怕被骗 | "钱打给第三方，货到了没问题再给你" |
| "你先发货，到货我再付"——供应商怕被骗 | "买家钱已托管，你放心发货" |
| China Selection 只是信息中介 | China Selection 是"安全交易撮合方" |
| 成交转化率低 | 成交转化率显著提高 |

---

## 五、MVP 页面怎么加

### 方案 A：加一行 Trust Bar（最小改动）

在首页 Hero 区或 CTA 区加一条：

> "Prefer a secure deal? We guide buyers and suppliers through **Escrow.com** — payment held by a licensed third party until goods are verified."

### 方案 B：加一个 "How we de-risk trade" 板块

三句话：

1. **Verified suppliers only** — every brand on our list is vetted.
2. **Secure payment option** — optional Escrow.com transaction support for qualifying orders.
3. **Clear inspection window** — buyers confirm goods before funds are released.

### 方案 C：For buyers 表单增加"交易保障"选项

在联系表单里加一个字段：

```
Would you like a secure-escrow transaction? [Yes / No]
```

收到意向后，China Selection 主动联系双方推荐 Escrow.com。

---

## 六、话术红线

| 可以说 ✅ | 不能说 ❌ |
|---|---|
| "We can arrange an escrow-backed transaction via Escrow.com" | "China Selection guarantees your payment" |
| "Payment is held by a licensed third-party escrow service" | "Your money is safe with us" |
| "We guide both sides through a secure trade process" | "We are a payment platform / escrow provider" |
| "Inspection period and release terms are handled by Escrow.com" | "We hold the funds" |

> 一旦说"我们担保/我们托管"，China Selection 就从策展平台变成了金融机构，风险结构完全不同。

---

## 七、二手车出口的特殊处理

0公里二手车出口客单高、信任风险大，必须比普通小家电更重的流程：

1. ** Escrow.com 是必选项**，不接受先款后货。
2. **第三方检验**：提车前由 SGS / INTERTEK / CIC 出车辆状态报告（VIN、里程、外观、配置）。
3. **物权文件先押 escrow**：供应商把车辆登记证、出口许可证、提单副本先提交 escrow 作为放款条件。
4. **到港后再放款**：车到目的港，买家验车确认后再由 escrow 放款。
5. **保险覆盖**：海运险 + 可选择性的"到港不符赔付险"。

---

## 八、实施 Checklist

- [ ] 注册 **Escrow.com Business Account**（企业账户）。
- [ ] 在网站加 "Secure trade via Escrow.com" 说明页。
- [ ] 在 For buyers / For suppliers 表单增加"是否需要 escrow 交易"选项。
- [ ] 准备一份交易引导邮件模板（买家版 + 供应商版）。
- [ ] 明确 China Selection 服务费收取方式：按成交额 %、或固定撮合费，不走 escrow 资金流。
- [ ] 准备 L/C 方案模板（大额订单备用）。
- [ ] 找一家合作检验机构（二手车/高客单必用）。

---

## 九、一句话总结

**China Selection 不要碰钱，要碰"让双方敢交易的方法"——用 Escrow.com 这类持牌第三方做资金托管，自己只做流程设计和撮合引导。这样既解决信任问题，又不把公司拖进金融监管的重灾区。**

---

## 十、案例对照：阿里巴巴国际站 Trade Assurance（巨头自建 vs 你借第三方）

阿里巴巴国际站的「信用保障（Trade Assurance）」就是一套 escrow 式担保交易：买家在 alibaba.com 下单 → 付款冻结进阿里一达通在花旗银行的专属托管账号 → 收货确认 → 放款给卖家；买家免费、卖家约 3% 交易费（韩国站 4% 封顶 $100）。

**关键认知：**
- **它是阿里自建的，不是借第三方 escrow 公司。** 背后是阿里自己的金融基础设施（蚂蚁、一达通、合作银行），阿里自己就是平台托管方 + 仲裁方。它"借"的只是合作银行的账户通道（受监管所限资金不进阿里自有资金池），但整套担保体系是阿里设计、运营、对买家兜底的。
- **只在 alibaba.com 站内有效**，买家必须走阿里体系。China Selection 作为独立站无法复用其系统。

**对照结论：**

| | 阿里巴巴 Trade Assurance | China Selection |
|---|---|---|
| 托管体系 | 自建（持牌金融基础设施） | 接入第三方 Escrow.com |
| 适用前提 | 巨头、有支付/银行牌照、有资本 | 独立策展站、无牌照 |
| 机制 | 付款托管 → 验货 → 放款 → 仲裁 | 同机制，托管方换成 Escrow.com |

一句话：阿里能自建是因为它是阿里；你该借 Escrow.com 是因为你不是。**复制它的"信任机制"，不复制它的"自建系统"。**
