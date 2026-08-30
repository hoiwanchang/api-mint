#!/usr/bin/env bash
# api-mint 一键部署：需要 ~/.wrangler/.env 里有 CF_API_TOKEN（和可选 CF_ACCOUNT_ID）
# 用法：bash deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

[ -f ~/.wrangler/.env ] || { echo "缺少 ~/.wrangler/.env（需包含 CF_API_TOKEN=...）"; exit 1; }
set -a; source ~/.wrangler/.env; set +a

echo "==> 1/3 创建/复用 KV namespace RATE"
if ! grep -q 'id = "' wrangler.toml || grep -q 'REPLACE_WITH' wrangler.toml; then
  OUT=$(npx wrangler kv namespace create RATE --json 2>/dev/null || npx wrangler kv namespace create RATE)
  # 输出形如: Namespace created... ID: xxx  或 JSON
  KV_ID=$(echo "$OUT" | grep -oE '[a-f0-9]{32}' | head -1)
  if [ -z "$KV_ID" ]; then
    # 可能已存在：列出 namespace 找 RATE
    KV_ID=$(npx wrangler kv namespace list --json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(next((r['id'] for r in (d.get('result') or d) if r.get('name')=='RATE'),''))" 2>/dev/null || true)
  fi
  [ -n "$KV_ID" ] || { echo "无法确定 KV namespace ID，输出：$OUT"; exit 1; }
  python3 - "$KV_ID" <<'PY'
import re, sys
id = sys.argv[1]
s = open('wrangler.toml').read()
s = re.sub(r'id = "[^"]*"', f'id = "{id}"', s)
open('wrangler.toml','w').write(s)
print("wrangler.toml 已写入 KV ID")
PY
else
  echo "KV ID 已在 wrangler.toml，跳过"
fi

echo "==> 2/3 部署 worker + route (api.aipps.vip/*)"
npx wrangler deploy

echo "==> 3/3 验证"
sleep 5
curl -s -m 15 https://api.aipps.vip/health || true
curl -s -m 15 "https://api.aipps.vip/v1/today?tz=Asia/Shanghai" || true
echo "部署完成 ✅"
