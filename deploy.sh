#!/usr/bin/env bash
# api-mint 一键部署：需要 ~/.wrangler/.env 里有 CF_API_TOKEN（和可选 CF_ACCOUNT_ID）
# 用法：bash deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

[ -f ~/.wrangler/.env ] || { echo "缺少 ~/.wrangler/.env（需包含 CF_API_TOKEN=...）"; exit 1; }
set -a; source ~/.wrangler/.env; set +a

echo "==> 1/2 部署 worker + route (api.aipps.vip/*)"
npx wrangler deploy

echo "==> 2/2 验证"
sleep 5
curl -s -m 15 https://api.aipps.vip/health || true
curl -s -m 15 "https://api.aipps.vip/v1/today?tz=Asia/Shanghai" || true
echo "部署完成 ✅"
