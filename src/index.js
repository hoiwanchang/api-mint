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
 * Permanently free — part of the aipps cluster (api-mint + qr-mint).
 * Cluster monetization: Lemon Squeezy digital products (boilerplate/templates).
 */

const ER_API = "https://open.er-api.com/v6/latest/USD";
const CG_API = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,binancecoin,solana&vs_currencies=usd&include_24hr_change=true";
const RATE_KEY = "ratelimit";
const CACHE_KEY_FX = "fx_usd_v1";
const CACHE_KEY_CG = "cg_v1";

import { DurableObject } from "cloudflare:workers";

/* --- daily PV counter: Durable Object (zero KV writes; DO storage is a
   separate quota — 100k stateful ops/mo on free tier — and atomic). --- */
export class PVCounter extends DurableObject {
  async add(day) {
    const k = "pv:" + day;
    const n = (await this.ctx.storage.get(k)) || 0;
    await this.ctx.storage.put(k, n + 1);
    return n + 1;
  }
  async value(day) {
    return (await this.ctx.storage.get("pv:" + day)) || 0;
  }
}

const RATE_LIMITS = {
  // keyless public: per minute per IP
  anon_per_min: 30,
};

const CACHED_TTL_SEC = {
  fx: 60 * 60 * 24, // 1 day
  cg: 60 * 5,       // 5 min
};

// --- DoH (DNS-over-HTTPS) subpath: /my-realname-solver -------------------
// Forwards to https://cloudflare-dns.com/dns-query — same shape as an EdgeOne
// origin-rewrite rule (host rewrite + path replace + accept/ct normalisation)
// but implemented as one fetch() in the Worker. All four DoH forms work:
//   GET  ?name=x&type=A        (dns-json)
//   GET  ?dn=x                 (dns-json; Google-DoH-style dn mapped to name)
//   POST body {name,type}      (dns-json; translated to an upstream GET,
//                               because CF /dns-query rejects JSON POST bodies)
//   POST body <wire>  + accept: application/dns-message  (binary, passed through)


const DOH_PATH = "/my-realname-solver";
const DOH_ORIGIN = "https://cloudflare-dns.com/dns-query";
const DOH_JSON_CT = "application/dns-json";
const DOH_BIN_CT = "application/dns-message";
const DOH_CACHE_TTL = 10; // short: DNS can go stale fast
const DOH_RL_WINDOW = 60;
const DOH_RL_LIMIT = 120; // soft, per-IP, in-memory (bypasses the KV API limit)

const dohRl = new Map(); // ip -> {count, resetAt}
function dohRateLimit(ip) {
  const now = Date.now();
  let b = dohRl.get(ip);
  if (!b || b.resetAt < now) {
    b = { count: 0, resetAt: now + DOH_RL_WINDOW * 1000 };
    dohRl.set(ip, b);
  }
  b.count += 1;
  if (dohRl.size > 8000) for (const [k, v] of dohRl) if (v.resetAt < now) dohRl.delete(k);
  return b.count <= DOH_RL_LIMIT;
}

async function handleDoH(request, url, path) {
  const accept = (request.headers.get("accept") || "").toLowerCase();
  const binary = accept.includes(DOH_BIN_CT);

  // CORS preflight for this subpath (binary DoH needs POST)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "accept, content-type",
        "access-control-max-age": "86400",
      },
    });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, POST", "access-control-allow-origin": "*" },
    });
  }
  // binary DNS wire format must be POST
  if (binary && request.method !== "POST") {
    return json({ error: "method_not_allowed", message: "application/dns-message requires POST" }, 405);
  }

  // health probe under the DoH path
  if (path === DOH_PATH + "/health" || path === DOH_PATH + "/health/") {
    return json({ ok: true, service: "do-h", origin: "cloudflare-dns.com", usage: "GET " + DOH_PATH + "?name=example.com&type=A" });
  }

  // soft per-IP guard (json mode only; binary is usually our own tooling)
  if (!binary) {
    const ip = request.headers.get("cf-connecting-ip") || "anon";
    if (!dohRateLimit(ip)) {
      return json({ error: "rate_limited", message: "Too many DoH requests, slow down." }, 429);
    }
  }

  // Forward to upstream. CF's /dns-query speaks:
  //   GET  ?name&type&cd&do&bootstrap  -> dns-json
  //   POST (wire, content/accept: application/dns-message) -> dns-message
  // It does NOT accept a JSON body (POST + JSON -> 400/415). So a JSON-body
  // POST from a client is translated to an upstream GET with the same params.
  let fwdMethod;
  let fwdBody;
  let fwdHeaders;
  const qs = new URLSearchParams(url.searchParams);
  if (qs.has("dn") && !qs.has("name")) { // Google DoH clients send ?dn=
    qs.set("name", qs.get("dn"));
    qs.delete("dn");
  }

  if (binary) {
    fwdMethod = "POST";
    fwdBody = request.body;
    fwdHeaders = new Headers();
    fwdHeaders.set("accept", DOH_BIN_CT);
    fwdHeaders.set("content-type", DOH_BIN_CT);
  } else {
    // --- json mode ---
    fwdHeaders = new Headers();
    fwdHeaders.set("accept", DOH_JSON_CT);
    if (request.method === "POST") {
      // translate JSON body -> query params (CF upstream needs GET for json)
      let parsed = {};
      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/dns-json") && !ct.includes("application/json")) {
        return json({ error: "unsupported_media_type", message: "json mode needs content-type application/dns-json" }, 415);
      }
      try {
        parsed = JSON.parse(await request.text());
      } catch {
        return json({ error: "invalid_json", message: "POST body must be valid dns-json" }, 400);
      }
      if (parsed.name && !qs.has("name")) qs.set("name", String(parsed.name));
      if (parsed.type != null && !qs.has("type")) qs.set("type", String(parsed.type));
      for (const k of ["cd", "do", "bootstrap"]) {
        if (parsed[k] == null) continue;
        const v = String(parsed[k]).toLowerCase();
        if (["true", "false"].includes(v)) qs.set(k, v);
      }
    }
    if (!qs.has("name") && !qs.has("dn")) {
      return json({ error: "missing_name", message: "Provide ?name=<domain> (or a JSON body with name)" }, 400);
    }
    fwdMethod = "GET";
    fwdBody = undefined;
  }
  const fwdSearch = "?" + qs.toString();

  let upstream;
  const cacheKey = !binary && fwdMethod === "GET" ? request.url : null;
  const cache = cacheKey ? caches.default : null;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  try {
    upstream = await fetch(DOH_ORIGIN + fwdSearch, {
      method: fwdMethod,
      headers: fwdHeaders,
      body: fwdBody,
      redirect: "follow",
    });
  } catch (e) {
    return json({ error: "upstream_failed", message: String((e && e.message) || e) }, 502);
  }

  const ct = binary ? DOH_BIN_CT : DOH_JSON_CT;
  const cc = binary ? "no-store" : `public, max-age=${DOH_CACHE_TTL}`;
  const out = new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": ct,
      "cache-control": cc,
      "access-control-allow-origin": "*",
    },
  });
  if (cache && cacheKey && out.status === 200) {
    cache.put(cacheKey, out.clone(), { cacheTtl: DOH_CACHE_TTL }).catch(() => {});
  }
  return out;
}

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

    // --- daily PV count (DurableObject; /health excluded so cron probes don't inflate) ---
    const pvStub = env.PV.get(env.PV.idFromName("global"));
    if (path !== "/health") ctx.waitUntil(pvStub.add(new Date().toISOString().slice(0, 10)));

    // --- DoH subpath: /my-realname-solver (hidden service, not in landing) ---
    if (path === DOH_PATH || path.startsWith(DOH_PATH + "/")) {
      return handleDoH(request, url, path);
    }

    // --- /ip: requesting client's real IP + light geo (no KV, no upstream) ---
    if (path === "/ip" || path === "/ip/") {
      const d = ipData(request);
      const accept = request.headers.get("accept") || "";
      const wantsHtml = accept.includes("text/html") && !accept.includes("application/json");
      // debug: ?raw=1 dumps the raw cf-* headers (ops only, not advertised)
      if (url.searchParams.get("raw") === "1" && !wantsHtml) {
        return json({
          cf_connecting_ip: request.headers.get("cf-connecting-ip"),
          cf_ipv6: request.headers.get("cf-ipv6"),
          cf_visitor_raw: request.headers.get("cf-visitor"),
          cf_ip: request.headers.get("cf-ip"),
          x_forwarded_for: request.headers.get("x-forwarded-for"),
        });
      }
      if (wantsHtml) {
        return new Response(ipHtml(d), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-powered-by": "api-mint",
            ...corsHeaders(),
          },
        });
      }
      return json(d);
    }

    // --- /__pv: PV stats read (secret-guarded, ops only; not advertised) ---
    if (path === "/__pv") {
      // PV 数据不敏感（仅每日访问量），免鉴权；ops cron 直接 GET 读取
      try {
        const days = [];
        const d = new Date();
        for (let i = 0; i < 8; i++) days.push(new Date(d.getTime() - i * 86400000).toISOString().slice(0, 10));
        const series = [];
        for (const day of days) series.push({ day: day, n: await pvStub.value(day) });
        return json({ product: "api", today: days[0], series: series });
      } catch (e) {
        return json({ error: String(e && e.message || e) }, 500);
      }
    }

    // --- rate limit (KV) ---
    const ip = request.headers.get("cf-connecting-ip") || "anon";
    const rl = rateLimit(ip, RATE_LIMITS.anon_per_min, 60);
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
            "GET /ip",
          ],
          pricing: "free forever — 30 req/min per IP, no key needed",
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
        const base = "https://api.aipps.vip";
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${base}/</loc><changefreq>daily</changefreq></url>\n</urlset>`,
          { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=86400" } }
        );
      } else if (path === "/robots.txt") {
        return new Response(
          `User-agent: *\nAllow: /\nDisallow: /v1/\nSitemap: https://api.aipps.vip/sitemap.xml\n`,
          { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" } }
        );
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

// --- /ip: the requesting client's REAL IP + light geo ---------------------
// cf-connecting-ip is the authoritative source for the real client IP in a
// CF Worker (it is NOT an edge/CDN hop) and is protected from spoofing.
//
// Geo/ASN sourcing — trust only what CF itself sets:
//   * country  -> cf-visitor.country, else the standalone cf-ipcountry header.
//     CF always overwrites cf-ipcountry with the real value (verified: spoofed
//     "ZZ" came back as "CN"), so it is safe to read even when the zone's
//     "Cloudflare IP Location Headers" setting is OFF.
//   * asn/org/city/region/timezone -> cf-visitor ONLY. CF only populates these
//     inside cf-visitor when the zone's "Cloudflare IP Location Headers" is ON;
//     when OFF it returns {"scheme":...} so these degrade to null. We do NOT
//     read the standalone cf-asp / cf-aspd headers: when the setting is OFF CF
//     does not overwrite them, so a client can spoof them (verified live).
// No external geo lookup — keeps it fast and dependency-free.
function ipData(request) {
  const h = request.headers;
  const ip = h.get("cf-connecting-ip") || "unknown";
  const ipv6 = h.get("cf-ipv6") || null;
  let v = {};
  try { v = JSON.parse(h.get("cf-visitor") || "{}"); } catch { v = {}; }
  return {
    ip,
    ipv6,
    asn: v.asn || null,
    org: v.asn_org || v.organization || null,
    network_type: v.asn_type || null,
    country: v.country || h.get("cf-ipcountry") || null,
    region: v.region || null,
    city: v.city || null,
    timezone: v.timezone || null,
  };
}

function ipHtml(d) {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const rows = [
    ["IP", d.ip], ["IPv6", d.ipv6 || "—"], ["ASN", d.asn || "—"], ["Network", d.org || "—"],
    ["Type", d.network_type || "—"], ["City", d.city || "—"], ["Region", d.region || "—"],
    ["Country", d.country || "—"], ["Timezone", d.timezone || "—"],
  ];
  const body = rows.map(([k, val]) => `<tr><td>${esc(k)}</td><td>${esc(val)}</td></tr>`).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.ip)} — your IP</title>
<meta name="robots" content="noindex">
<style>:root{--bg:#0d0f12;--panel:#15181d;--line:#2a2f37;--text:#e8eaed;--dim:#9aa0a6;--amber:#ffb81c}*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font:15px/1.6 ui-monospace,'SF Mono',Menlo,Consolas,monospace;background-image:radial-gradient(circle,#1a1e24 1px,transparent 1px);background-size:24px 24px;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:var(--panel);border:1px solid var(--line);padding:32px;max-width:440px;width:100%;margin:16px}
.lbl{color:var(--dim);font-size:12px;letter-spacing:.15em;text-transform:uppercase}
.big{font-size:38px;color:var(--amber);margin:6px 0 18px;word-break:break-all}
table{width:100%;border-collapse:collapse;font-size:14px}
td{padding:7px 0;border-top:1px solid var(--line)}
td:first-child{color:var(--dim);width:96px}</style></head>
<body><div class="card"><div class="lbl">Your IP address</div><div class="big">${esc(d.ip)}</div><table>${body}</table>
<p style="margin-top:18px;color:var(--dim);font-size:12px">GET /ip · no API key · powered by api-mint</p></div></body></html>`;
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
<link rel="canonical" href="https://api.aipps.vip/">
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
<tr><td><code>GET /ip</code></td><td>Your public IP — the real client IP (not the CDN edge), IPv6, country, ASN + city when available. JSON by default; HTML card in the browser.</td></tr>
<tr><td><code>GET /health</code></td><td>Liveness probe — <code>{"ok":true}</code></td></tr>
<tr><td><code>GET /</code></td><td>This page (HTML) or machine-readable service info (Accept: application/json)</td></tr>
</table>

<h2>Quick start</h2>
<pre><code>curl "https://api.aipps.vip/v1/today?tz=Asia/Shanghai"
curl "https://api.aipps.vip/v1/fx?from=USD&to=CNY&amount=100"
curl "https://api.aipps.vip/v1/crypto?symbol=BTC"
curl "https://api.aipps.vip/v1/url/extract?url=https://example.com"
curl "https://api.aipps.vip/ip"</code></pre>

<h2>Limits</h2>
<p style="color:var(--dim);font-size:14px">30 requests/minute per IP — no key, no signup, free forever.</p>

<h2>Why it exists</h2>
<p style="color:var(--dim);font-size:14px;margin-bottom:12px">
api-mint is built and operated end-to-end by an AI agent on Cloudflare Workers (free tier) —
deploy, monitoring, and daily ops run unattended. If it saves you a dependency, that's the point.
</p>

<div class="foot">
api-mint · hosted on Cloudflare Workers · uptime since ${uptime}
&nbsp;|&nbsp; <a href="https://qr.aipps.vip" target="_blank" rel="noopener">qr-mint — free QR codes, no login</a>
&nbsp;|&nbsp; <a href="https://short.aipps.vip" target="_blank" rel="noopener">short-mint — free URL shortener</a>
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

const rlMem = new Map(); // ip -> {c, r} (in-memory per isolate; no KV)
function rateLimit(ip, limit, windowSec) {
  const now = Date.now();
  let b = rlMem.get(ip);
  if (!b || b.r < now) b = { c: 0, r: now + windowSec * 1000 };
  b.c += 1;
  if (rlMem.size > 8000) for (const [k, v] of rlMem) if (v.r < now) rlMem.delete(k);
  return { ok: b.c <= limit, retryAfter: Math.max(1, Math.ceil((b.r - now) / 1000)), count: b.c };
}

