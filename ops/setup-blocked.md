# 等待 Kane 提供的凭证（提供后删掉此文件，cron 会恢复正常通知）

## 1. Cloudflare —— 跳过 OAuth，用 API Token（wrangler login 在 WSL 下回调不可靠）
在浏览器里操作（dash 能正常访问）：
a) 打开 https://dash.cloudflare.com/ ，点右上角头像 → **API Tokens**
b) **Create Token** → 选模板 **"Edit Cloudflare Workers"**（含 Workers Scripts:Edit + KV:Edit）
   → 选择目标 Account → 权限保留默认 → 无过期 → 创建
c) 把 **Token** 和 **Account ID**（dashboard 顶部可见）发给我
   → 我写入 ~/.wrangler/.env 后直接 wrangler deploy，不再走浏览器 OAuth

## 2. 收款平台 —— Lemon Squeezy（BMC 不可用的替代，个人可注册）
- https://www.lemonsqueezy.com/ 注册（个人，中国护照/身份证 + 国内手机号 + 银行对账单，有人当天过审）
- 平台代收海外信用卡/PayPal/Apple Pay，自动处理 VAT（MoR 模式），我们只需卖"数字产品"
- 结款方式：Wise 或 Payoneer（都能落到国内）
- 备选：Creem（门槛最低）、Paddle、Gumroad（费率高）
- 注册后给我：商家 ID（merchant ID）+ API token（Dashboard → API keys），
  我用 /v1/stats 对账 + 每周收入报告
- 支付宝：没有对标的"创作者打赏"平台，且我们的买家是海外开发者，用支付宝收款行不通；
  国内买家可用 Lemon Squeezy 收银台的 Apple Pay（绑国内卡不行，绑 Visa/MC 行）

## 3. （可选后期）Stripe —— 付费 API key 月订阅，先不做
