# 最后一步：绑定 api.aipps.vip（浏览器点一下，1 分钟）

Worker 已部署成功（api-mint, hoiwan 账户），API token 已写入 ~/.wrangler/.env。
但该 token（Edit Cloudflare Workers 模板）是 account 级权限，绑 zone 域名需要 zone 级权限，
API 两条路（zone routes / workers domains）都被拒。

## 方案 A（推荐，最省事）：dashboard 手动加 route
1. 打开 https://dash.cloudflare.com/4bdb8470582c9dc7053e529fb4991e83/workers-domain-routing/services
   （或直接：Workers & Pages → 点 api-mint → Triggers 标签）
2. "Add route" → 填 **api.aipps.vip/*** → 保存
3. 告诉我"route 加好了"，我立即线上验证（/health、/v1/today、/v1/fx、/v1/crypto、SSRF、限流）

## 方案 B：新建一个带 zone 权限的 token 给我
API Tokens → Create Token → **Create Custom Token** → 权限加两条：
- **Workers Routes — Edit — 范围: Zone: aipps.vip**
- （保留现有即可，不需要其他）
把 token 发我，我自动绑 + 验证。

注意：workers.dev 子域在国内（包括你的 WAF 服务器）访问不通，api.aipps.vip 走 CF anycast 可达，
所以必须绑自定义域名才能用。
