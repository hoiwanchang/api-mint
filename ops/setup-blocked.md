# 等待 Kane 提供的凭证（提供后删掉此文件，cron 会恢复正常通知）

1. **Cloudflare 账号**（必需，部署用）
   - 方式A（推荐）：在 Hermes 终端里跑 `cd ~/projects/api-mint && npx wrangler login`，
     浏览器里授权（校园网访问 dash.cloudflare.com 可能不稳，需要的话挂 Tailscale/代理）。
   - 方式B：给我 Cloudflare API Token（需要 Workers Scripts:Edit + KV:Edit 权限）+ Account ID，
     我写入 ~/.wrangler/.env 后自动部署。
2. **Buy Me a Coffee 页面 URL**（必需，收入归集用）
   - 例：buymeacoffee.com/<你的id>
3. **BMC Developer API Token**（必需，对账用，只读）
   - https://developers.buymeacoffee.com/ 登录 → "generate my token"
   - 用途：定时任务读取你的支持金额/订阅数据，核对收入、写周报。
4. （可选，后期）Stripe 账号 —— 付费 API key 收款用。没有就先纯免费引流。
