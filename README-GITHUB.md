# api-mint

**Free public utility APIs — no API key, no signup.**

api-mint is a set of small, useful JSON endpoints running on Cloudflare Workers
(free tier). Built and operated end-to-end by an AI agent (deploy, monitoring,
daily ops all unattended).

## Endpoints

Base URL: `https://api.aipps.vip`

| Endpoint | Description | Params |
|---|---|---|
| `GET /v1/today` | Current date, time, weekday in any IANA timezone | `tz` (default `UTC`) |
| `GET /v1/fx` | Live USD forex rates + conversion (open.er-api.com, 1-day cache) | `from`, `to`, `amount` |
| `GET /v1/crypto` | BTC / ETH / BNB / SOL prices in USD + 24h change (CoinGecko, 5-min cache) | `symbol` |
| `GET /v1/url/extract` | Page title, meta description, og-image, final URL after redirects | `url` |
| `GET /health` | Liveness probe | — |
| `GET /` | This landing page (HTML) or service info (`Accept: application/json`) | — |

## Quick start

```bash
curl "https://api.aipps.vip/v1/today?tz=Asia/Shanghai"
curl "https://api.aipps.vip/v1/fx?from=USD&to=CNY&amount=100"
curl "https://api.aipps.vip/v1/crypto?symbol=BTC"
curl "https://api.aipps.vip/v1/url/extract?url=https://example.com"
```

### Responses

`/v1/today?tz=Asia/Shanghai`:
```json
{
  "timezone": "Asia/Shanghai",
  "iso": "2026-08-30T16:00:00.000Z",
  "date": "2026-08-30",
  "time": "00:00:00",
  "weekday": "Monday",
  "utc_offset": "GMT+8"
}
```

`/v1/fx?from=USD&to=CNY&amount=100`:
```json
{
  "from": "USD", "to": "CNY", "amount": 100,
  "rate": 7.15, "result": 715.0, "base": "USD"
}
```

## Limits

- **Free tier:** 30 requests/min per IP. No key needed.
- **Pro tier:** 1,000 req/hour per API key via `X-API-Key` header (coming soon).

429 responses include a `retry_after_sec` field.

## Error shape

```json
{ "error": "rate_limited", "message": "Free tier limit reached (30 req/min).", "retry_after_sec": 23 }
```

## Notes

- All responses are JSON, UTF-8, with `x-powered-by: api-mint` header.
- `fx` data cached 24h (daily reference rates), `crypto` cached 5 min.
- `/v1/url/extract` blocks private/internal IPs (SSRF guard) and caps responses at 2 MB.
- Source of this worker is in this repo — fork it, self-host it anywhere Workers runs.

---

## 中文说明

一组**免 API key、免注册**的公共实用 JSON API，部署在 Cloudflare Workers 免费层，
由 AI agent 全自动构建与运营（部署、监控、每日巡检均无人值守）。

| 端点 | 说明 | 参数 |
|---|---|---|
| `GET /v1/today` | 任意 IANA 时区的当前日期/时间/星期 | `tz`（默认 UTC） |
| `GET /v1/fx` | 实时美元汇率 + 换算（缓存 24h） | `from`、`to`、`amount` |
| `GET /v1/crypto` | BTC/ETH/BNB/SOL 美元价 + 24h 涨跌（缓存 5 分钟） | `symbol` |
| `GET /v1/url/extract` | 网页标题、meta 描述、og-image、重定向后的最终 URL | `url` |

免费额度：每 IP 30 次/分钟；被限流返回 429 并带 `retry_after_sec`。

Worker 源码即本仓库，fork 后可自行部署。

## Self-host

```bash
npx wrangler login
npx wrangler kv namespace create RATE
# set the kv id in wrangler.toml
npx wrangler deploy
```
