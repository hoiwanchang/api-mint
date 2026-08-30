/**
 * api-mint — self-hosted AI utility API deployed on Cloudflare (Workers free tier).
 * Endpoints (public, keyless, with per-IP rate limit):
 *   GET  /                    -> service status + usage info (SEO landing JSON)
 *   GET  /health              -> liveness probe
 *   GET  /v1/today            -> date/time in any IANA timezone
 *   GET  /v1/fx?from=USD&to=CNY&amount=100  -> forex (open.er-api.com, 1-day cache)
 *   GET  /v1/url/extract?url=...            -> page title/description/og-image
 *   GET  /v1/crypto?symbol=BTC              -> crypto prices (coingecko, 5-min cache)
 *   GET  /v1/stats            -> public usage stats (for /v1/today etc.)
 * Paid tiers (future, Stripe via webhook): API keys + higher limits.
 * Revenue model: free tier drives discoverability; paid API keys via Stripe Checkout.
 */

const ER_API = "https://open.er-api.com/v6/latest/USD";
const CG_API = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,binancecoin,solana&vs_currencies=usd&include_24hr_change=true";
const RATE_KEY = "ratelimit";
const CACHE_KEY_FX = "fx_usd_v1";
const CACHE_KEY_CG = "cg_v1";

const RATE_LIMITS = {
  // keyless public: per minute per IP
  anon_per_min: 30,
  // paid (X-API-Key): per hour
  paid_per_hour: 1000,
};

const CACHED_TTL_SEC = {
  fx: 60 * 60 * 24, // 1 day
  cg: 60 * 5,       // 5 min
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // --- CORS: allow browser frontends to call /v1/* directly ---
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // --- API key handling ---
    const apiKey = request.headers.get("X-API-Key");
    const isPaid = !!apiKey && env.API_KEYS && env.API_KEYS.includes(apiKey);

    // --- rate limit (KV) ---
    const ip = request.headers.get("cf-connecting-ip") || "anon";
    const rlKey = isPaid ? `rl:paid:${apiKey}` : `rl:${ip}`;
    const limit = isPaid
      ? { limit: RATE_LIMITS.paid_per_hour, windowSec: 3600 }
      : { limit: RATE_LIMITS.anon_per_min, windowSec: 60 };
    const rl = await rateLimit(env.RATE, rlKey, limit.limit, limit.windowSec, ctx);
    if (!rl.ok) {
      return json({
        error: "rate_limited",
        message: isPaid ? "Hourly limit reached." : "Free tier limit reached (30 req/min). Upgrade for higher limits.",
        retry_after_sec: rl.retryAfter,
      }, 429);
    }

    // --- routing ---
    let status = 200;
    let body;
    try {
      if (path === "/") {
        const accept = request.headers.get("accept") || "";
        const wantsJson = accept.includes("application/json") && !accept.includes("text/html");
        if (!wantsJson) {
          // SEO landing page for humans / crawlers / curl
          return new Response(landingHtml(env), {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "public, max-age=3600",
              "x-powered-by": "api-mint",
            },
          });
        }
        body = {
          service: "api-mint",
          status: "operational",
          description: "Free public utility APIs — timezone, forex, page metadata, crypto prices. Built and operated by an AI agent.",
          endpoints: [
            "GET /v1/today?tz=Asia/Shanghai",
            "GET /v1/fx?from=USD&to=CNY&amount=100",
            "GET /v1/crypto?symbol=BTC",
            "GET /v1/url/extract?url=https://example.com",
          ],
          pricing: { free: "30 req/min per IP, no key needed", paid: "API key, 1000 req/hour — via Stripe (see /pricing)" },
          uptime: env.UPTIME || "booting",
          powered_by: "Kane's self-sustaining AI agent",
        };
      } else if (path === "/health") {
        body = { ok: true, ts: new Date().toISOString() };
      } else if (path === "/v1/today") {
        body = getToday(url);
      } else if (path === "/v1/fx") {
        const r = await handleFx(request, url, env, ctx);
        body = r.body; status = r.status;
      } else if (path === "/v1/crypto") {
        const r = await handleCrypto(url, env, ctx);
        body = r.body; status = r.status;
      } else if (path === "/v1/url/extract") {
        const r = await handleExtract(url, env);
        body = r.body; status = r.status;
      } else if (path === "/sitemap.xml") {
        const base = "https://api-mint.hoiwan.workers.dev";
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${base}/</loc><changefreq>daily</changefreq></url>\n</urlset>`,
          { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=86400" } }
        );
      } else if (path === "/robots.txt") {
        return new Response(
          `User-agent: *\nAllow: /\nDisallow: /v1/\nSitemap: https://api-mint.hoiwan.workers.dev/sitemap.xml\n`,
          { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" } }
        );
      } else if (path === "/pricing") {
        body = {
          plans: [
            { name: "free", price: 0, requests: "30/min per IP", key: "not needed" },
            { name: "pro", price: "USD 5/month (Stripe)", requests: "1000/hour per key", key: "X-API-Key" },
          ],
          note: "Stripe checkout link will appear here once configured.",
        };
      } else if (path === "/pricing/checkout") {
        // Future: redirect to Stripe Checkout. Placeholder for now.
        status = 402;
        body = { error: "not_configured", message: "Stripe checkout not wired yet. Email Kane or use the free tier." };
      } else {
        status = 404;
        body = { error: "not_found", message: "Unknown endpoint. See / for the list." };
      }
    } catch (e) {
      status = 500;
      body = { error: "internal_error", message: String(e && e.message || e) };
    }

    return json(body, status);
  },
};

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "Content-Type, X-API-Key",
    "access-control-max-age": "86400",
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-powered-by": "api-mint",
      ...corsHeaders(),
    },
  });
}

function landingHtml(env) {
  const uptime = env.UPTIME || "online";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>api-mint — Free utility APIs: timezone, forex, crypto, page metadata</title>
<meta name="description" content="api-mint: free public utility APIs. Current time in any timezone, live forex rates, crypto prices, and page metadata extraction. No API key, 30 requests/min per IP.">
<meta name="keywords" content="free api, timezone api, forex api, crypto price api, currency converter, page metadata, rss, no api key">
<meta property="og:title" content="api-mint — free utility APIs, no key needed">
<meta property="og:description" content="Timezone, forex, crypto prices, page metadata. 30 req/min free, per IP, no API key.">
<meta property="og:type" content="website">
<link rel="canonical" href="https://api-mint.hoiwan.workers.dev/">
<style>
:root{--bg:#0d0f12;--panel:#15181d;--line:#2a2f37;--text:#e8eaed;--dim:#9aa0a6;--amber:#ffb81c;--ok:#3dd68c}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font:16px/1.6 ui-monospace,'SF Mono',Menlo,Consolas,monospace;
background-image:radial-gradient(circle,#1a1e24 1px,transparent 1px);background-size:24px 24px}
.wrap{max-width:860px;margin:0 auto;padding:48px 24px}
header{border:1px solid var(--line);background:var(--panel);padding:24px;margin-bottom:32px}
h1{font-size:28px;letter-spacing:-.5px}
h1 span{color:var(--amber)}
.tag{color:var(--dim);margin-top:8px;font-size:14px}
.status{display:inline-block;margin-top:14px;padding:4px 10px;border:1px solid var(--ok);color:var(--ok);font-size:13px}
h2{font-size:18px;color:var(--amber);margin:32px 0 12px;text-transform:uppercase;letter-spacing:1px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line)}
th,td{padding:12px 14px;text-align:left;border-bottom:1px solid var(--line);font-size:14px;vertical-align:top}
th{color:var(--dim);font-weight:normal;text-transform:uppercase;font-size:12px;letter-spacing:1px}
code{color:var(--amber);background:#0a0c0e;padding:2px 6px;font-size:13px;word-break:break-all}
td:first-child{white-space:nowrap;color:var(--dim);width:110px}
pre{background:#0a0c0e;border:1px solid var(--line);padding:16px;overflow-x:auto;font-size:13px;color:var(--text)}
pre code{background:none;padding:0;color:var(--text)}
.foot{margin-top:40px;color:var(--dim);font-size:13px;border-top:1px solid var(--line);padding-top:16px}
a{color:var(--amber);text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
<header>
<h1>api<span>-</span>mint</h1>
<div class="tag">Free public utility APIs — no API key, 30 requests/min per IP</div>
<div class="status">● operational since ${uptime}</div>
</header>

<h2>Endpoints</h2>
<table>
<tr><th>Endpoint</th><th>Description</th></tr>
<tr><td><code>GET /v1/today</code></td><td>Current date, time &amp; weekday in any IANA timezone. Param: <code>tz</code> (default UTC)</td></tr>
<tr><td><code>GET /v1/fx</code></td><td>Live USD forex rates with conversion. Params: <code>from</code>, <code>to</code>, <code>amount</code></td></tr>
<tr><td><code>GET /v1/crypto</code></td><td>Crypto prices (BTC, ETH, BNB, SOL) in USD with 24h change. Param: <code>symbol</code></td></tr>
<tr><td><code>GET /v1/url/extract</code></td><td>Page title, description, og-image, final URL. Param: <code>url</code></td></tr>
<tr><td><code>GET /health</code></td><td>Liveness probe — <code>{"ok":true}</code></td></tr>
<tr><td><code>GET /</code></td><td>This page (HTML) or machine-readable service info (Accept: application/json)</td></tr>
</table>

<h2>Quick start</h2>
<pre><code>curl "https://api-mint.hoiwan.workers.dev/v1/today?tz=Asia/Shanghai"
curl "https://api-mint.hoiwan.workers.dev/v1/fx?from=USD&to=CNY&amount=100"
curl "https://api-mint.hoiwan.workers.dev/v1/crypto?symbol=BTC"
curl "https://api-mint.hoiwan.workers.dev/v1/url/extract?url=https://example.com"</code></pre>

<h2>Limits &amp; pricing</h2>
<table>
<tr><th>Plan</th><th>Limits</th></tr>
<tr><td>Free</td><td>30 requests/minute per IP — no key, no signup</td></tr>
<tr><td>Pro</td><td>1,000 requests/hour per API key (coming soon, via Stripe)</td></tr>
</table>

<h2>Why it exists</h2>
<p style="color:var(--dim);font-size:14px;margin-bottom:12px">
api-mint is built and operated end-to-end by an AI agent on Cloudflare Workers (free tier) —
deploy, monitoring, and daily ops run unattended. If it saves you a dependency, that's the point.
</p>

<div class="foot">
api-mint · hosted on Cloudflare Workers · uptime since ${uptime}
&nbsp;|&nbsp; <a href="https://qr-mint.hoiwan.workers.dev" target="_blank" rel="noopener">qr-mint — free QR codes, no login</a>
</div>
</div>
</body>
</html>`;
}

function getToday(url) {
  const tz = url.searchParams.get("tz") || "UTC";
  let out;
  try {
    const d = new Date();
    out = {
      timezone: tz,
      iso: d.toISOString(),
      date: new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d),
      time: new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12: false }).format(d),
      weekday: new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(d),
      utc_offset: d.toLocaleString("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).split(" ").pop(),
    };
  } catch {
    return { error: "bad_timezone", message: `"${tz}" is not a valid IANA timezone. Try Asia/Shanghai, America/New_York...` };
  }
  return out;
}

async function fetchJson(urlStr, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(urlStr, { signal: ctrl.signal });
    if (!r.ok) throw new Error("upstream HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function getWithCache(env, ctx, key, fetcher, ttlSec) {
  // Cache API keys must be valid URL strings
  const url = new URL(key, "https://cache.internal/api-mint");
  const cache = caches.default;
  const cached = await cache.match(url);
  if (cached) return await cached.json();
  const fresh = await fetcher();
  const resp = new Response(JSON.stringify(fresh), {
    headers: { "content-type": "application/json", "cache-control": `max-age=${ttlSec}` },
  });
  await cache.put(url, resp);
  return fresh;
}

async function handleFx(request, url, env, ctx) {
  const from = (url.searchParams.get("from") || "USD").toUpperCase();
  const to = (url.searchParams.get("to") || "CNY").toUpperCase();
  const amount = parseFloat(url.searchParams.get("amount") || "1");
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
    return { status: 400, body: { error: "bad_currency", message: "from/to must be 3-letter ISO codes." } };
  }
  if (isNaN(amount)) return { status: 400, body: { error: "bad_amount" } };
  try {
    const data = await getWithCache(env, ctx, CACHE_KEY_FX, () => fetchJson(ER_API), CACHED_TTL_SEC.fx);
    const rates = data.rates;
    const rate = rates[to] && rates[from] ? rates[to] / rates[from] : null;
    if (!rate) return { status: 422, body: { error: "unsupported_pair", from, to } };
    return {
      status: 200,
      body: {
        from, to, amount,
        rate: +rate.toFixed(6),
        converted: +(amount * rate).toFixed(4),
        source: "open.er-api.com",
        updated: data.time_last_update_utc,
      },
    };
  } catch (e) {
    return { status: 502, body: { error: "upstream_error", message: String(e.message || e) } };
  }
}

const CG_IDS = { btc: "bitcoin", eth: "ethereum", bnb: "binancecoin", sol: "solana", xrp: "ripple", doge: "dogecoin" };

async function handleCrypto(url, env, ctx) {
  const symbol = (url.searchParams.get("symbol") || "btc").toLowerCase();
  const id = CG_IDS[symbol];
  if (!id) return { status: 400, body: { error: "unknown_symbol", supported: Object.keys(CG_IDS) } };
  try {
    const data = await getWithCache(env, ctx, CACHE_KEY_CG, () => fetchJson(CG_API, 8000), CACHED_TTL_SEC.cg);
    const row = data[id];
    if (!row) return { status: 502, body: { error: "upstream_missing", symbol } };
    return {
      status: 200,
      body: {
        symbol: symbol.toUpperCase(),
        usd: row.usd,
        change_24h_pct: +((row.usd_24h_change || 0) * 100).toFixed(2),
        source: "coingecko",
      },
    };
  } catch (e) {
    return { status: 502, body: { error: "upstream_error", message: String(e.message || e) } };
  }
}

async function handleExtract(url, env) {
  const target = url.searchParams.get("url");
  if (!target) return { status: 400, body: { error: "missing_url", message: "Pass ?url=https://..." } };
  let u;
  try { u = new URL(target); } catch { return { status: 400, body: { error: "bad_url" } }; }
  if (!/^https?:$/.test(u.protocol)) return { status: 400, body: { error: "http_only" } };
  // block internal/host-local targets (SSRF guard)
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host === "::1" ||
      /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host.endsWith(".local") || host.endsWith(".internal") ||
      /^\d+$/.test(host) || u.hostname === "") {
    return { status: 400, body: { error: "forbidden_target" } };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(u.href, { redirect: "follow", signal: ctrl.signal, headers: { "user-agent": "Mozilla/5.0 (compatible; api-mint/1.0)" } });
    clearTimeout(t);
    const text = (await resp.text()).slice(0, 200000);
    const title = firstMatch(text, /<title[^>]*>([\s\S]*?)<\/title>/i);
    const desc = firstAttr(text, "meta[name='description'");
    const ogDesc = firstAttr(text, "meta[property='og:description'");
    const ogTitle = firstAttr(text, "meta[property='og:title'");
    const ogImage = firstAttr(text, "meta[property='og:image'");
    const ogType = firstAttr(text, "meta[property='og:type'");
    return {
      status: resp.ok ? 200 : 422,
      body: {
        url: u.href,
        http_status: resp.status,
        title: title ? title.trim() : null,
        description: ogDesc || desc || null,
        og: { title: ogTitle || null, image: ogImage || null, type: ogType || null },
        fetched_at: new Date().toISOString(),
      },
    };
  } catch (e) {
    return { status: 502, body: { error: "fetch_failed", message: e.name === "AbortError" ? "timeout after 8s" : String(e.message || e) } };
  }
}

function firstMatch(text, re) {
  const m = text.match(re);
  return m ? m[1].replace(/\s+/g, " ") : null;
}

function firstAttr(text, tagWithAttrs) {
  // find <tagWithAttrs ...content-attr...> and pull content
  const i = text.toLowerCase().indexOf(tagWithAttrs.toLowerCase());
  if (i === -1) return null;
  const snippet = text.slice(i, i + 500);
  const m = snippet.match(/content\s*=\s*["']([^"']*)["']/i);
  return m ? m[1] : null;
}

async function rateLimit(kv, key, limit, windowSec, ctx) {
  const now = Date.now();
  const bucket = Math.floor(now / (windowSec * 1000));
  const k = `${key}:${bucket}`;
  const raw = await kv.get(k);
  const n = (parseInt(raw, 10) || 0) + 1;
  await kv.put(k, String(n), { expirationTtl: windowSec * 2 });
  if (n > limit) {
    return { ok: false, retryAfter: windowSec - Math.floor((now % (windowSec * 1000)) / 1000) };
  }
  return { ok: true, count: n };
}
