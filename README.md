# api-mint

Self-hosted free utility API on Cloudflare Workers (free tier).
Built + operated by Kane's Hermes agent. Goal: earn revenue (Stripe / future),
revenue goes to Kane's Buy Me a Coffee.

## Endpoints (GET, JSON)

| Endpoint | Description | Upstream |
|---|---|---|
| `/` | Service status + endpoint list (SEO landing) | — |
| `/health` | Liveness probe | — |
| `/v1/today?tz=Asia/Shanghai` | Date/time/weekday in IANA timezone | none (Intl) |
| `/v1/fx?from=USD&to=CNY&amount=100` | Forex conversion, 1-day cache | open.er-api.com |
| `/v1/crypto?symbol=BTC` | Crypto price + 24h change, 5-min cache | coingecko |
| `/v1/url/extract?url=...` | Title/description/og-image of any public URL, SSRF-guarded | direct fetch, 8s timeout |
| `/pricing` | Plan info | — |

## Architecture

- Single Worker (ES module), no framework
- `env.RATE` (KV): per-IP / per-key rate limiting (30/min anon, 1000/hour with `X-API-Key` in `API_KEYS` secret)
- `caches.default` (Cache API): upstream response caching — keys must be valid URL strings
- Cron trigger 09:00 UTC daily: self-check (placeholder; expand to health check + stats ping)
- Upstream fetches wrapped with AbortController timeout (10s default)

## Local dev

```bash
npx wrangler dev --port 8787 --local
curl localhost:8787/v1/today?tz=Asia/Shanghai
```

Pitfalls found (2026-08-30):
- workerd local (alpha builds): `kv.get(key, "number")` throws "Unknown response type"
  when the key exists — always `get(key)` + parseInt instead.
- Cache API keys must be valid URL strings, bare strings throw "Invalid URL".
- open.er-api.com / api.coingecko.com are blocked from SUSTech campus network
  (local 502 is expected; production CF edges can reach them).

## Deploy (needs Cloudflare account)

```bash
npx wrangler login
npx wrangler kv namespace create RATE   # -> put id in wrangler.toml
npx wrangler deploy
npx wrangler secret put API_KEYS   # optional, comma-separated paid keys
```

## Revenue

Free tier (no key) for discoverability. Paid `X-API-Key` tier via Stripe Checkout
(wire `/pricing/checkout` once Stripe account exists).
Target: Buy Me a Coffee (Kane's page), webhook-driven reconciliation via
studio.buymeacoffee.com webhook + developer token (read-only API).

## Ops (cron-driven)

- Daily: verify /health on live URL, check CF usage (dashboard or API), log to ops/state.json
- Weekly: check upstreams, consider adding endpoints based on what's free on CF
- All state in ops/state.json (request counts, revenue events, incidents)
