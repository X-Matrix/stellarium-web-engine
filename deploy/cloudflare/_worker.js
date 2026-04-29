// Cloudflare Pages advanced-mode worker.
// Routes /api/wiki to a Wikipedia summary proxy and falls through to static
// assets for everything else.
//
// Endpoint: GET /api/wiki?title=<page>&lang=<en|zh|...>
//   -> https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}?redirect=true

const ALLOWED_LANGS = new Set([
    'en', 'zh', 'fr', 'de', 'es', 'ja', 'ru', 'it', 'pt', 'ko'
]);

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname === '/api/wiki') {
            return handleWiki(url, env, ctx);
        }

        // Same-origin proxy for upstream Stellarium-Web data hosted on
        // DigitalOcean Spaces. The bucket only sends the CORS allow header
        // for stellarium-web.org, so direct browser fetches from our
        // deploy get a 200 with no body. Proxying here turns it into a
        // same-origin resource — no CORS problems, plus Cloudflare edge
        // caching for free.
        //
        // Path: /cdn/<upstream path>  ->  https://stellarium.sfo2.cdn.digitaloceanspaces.com/<upstream path>
        if (url.pathname.startsWith('/cdn/')) {
            return handleCdnProxy(url, request, ctx);
        }

        // Anything else: serve the static asset.
        return env.ASSETS.fetch(request);
    }
};

const CDN_UPSTREAM = 'https://stellarium.sfo2.cdn.digitaloceanspaces.com';
const CDN_CACHE_TTL = 30 * 24 * 3600;

async function handleCdnProxy(url, request, ctx) {
    const tail = url.pathname.slice('/cdn/'.length);
    if (!tail || tail.indexOf('..') !== -1) {
        return new Response('bad path', { status: 400 });
    }
    const upstream = `${CDN_UPSTREAM}/${tail}${url.search}`;

    try {
        const upstreamReq = new Request(upstream, {
            method: 'GET',
            // Strip the browser Origin so the upstream serves the public
            // asset unconditionally (it's a public CDN; the conditional
            // CORS allow-list only matters for browser CORS preflights).
            headers: { 'User-Agent': 'StelWebProxy/1.0' },
            cf: { cacheTtl: CDN_CACHE_TTL, cacheEverything: true }
        });
        const r = await fetch(upstreamReq);
        // Build a fresh response so we control the headers (the upstream
        // sends a Set-Cookie that we don't want to forward).
        const headers = new Headers();
        const ct = r.headers.get('content-type');
        if (ct) headers.set('Content-Type', ct);
        const cl = r.headers.get('content-length');
        if (cl) headers.set('Content-Length', cl);
        headers.set('Cache-Control', `public, max-age=${CDN_CACHE_TTL}, immutable`);
        // Same-origin, so no need for Access-Control-* headers; future-proof
        // against a COEP=require-corp document.
        headers.set('Cross-Origin-Resource-Policy', 'same-origin');
        return new Response(r.body, { status: r.status, headers });
    } catch (err) {
        return new Response('upstream fetch failed: ' + String(err), { status: 502 });
    }
}

// Cache wiki responses in Workers KV for 30 days; the upstream summary rarely
// changes and KV reads are far cheaper than a fresh fetch to wikipedia.org.
const KV_TTL_SECONDS = 30 * 24 * 3600;

async function handleWiki(url, env, ctx) {
    const title = (url.searchParams.get('title') || '').trim();
    const lang = (url.searchParams.get('lang') || 'en').toLowerCase();

    if (!title) return jsonError('missing "title"', 400);
    if (!ALLOWED_LANGS.has(lang)) return jsonError('unsupported "lang"', 400);

    const kv = env.WIKI_CACHE;
    const cacheKey = `wiki:v1:${lang}:${title}`;

    if (kv) {
        try {
            const hit = await kv.get(cacheKey, 'json');
            if (hit && hit.body) {
                return makeJsonResponse(hit.body, hit.status || 200, hit.lang || lang, 'HIT');
            }
        } catch (e) { /* ignore KV errors and fall through to upstream */ }
    }

    // Try the requested language first; if there's no article (404 or empty
    // extract), fall back to English so the user still gets a description.
    let result = await fetchSummary(lang, title);
    if (!result.ok && lang !== 'en') {
        const fb = await fetchSummary('en', title);
        // Prefer the fallback only if it actually succeeded.
        if (fb.ok) result = fb;
        else result = fb.status !== 502 ? fb : result;
    }

    // Persist successful responses in KV. Don't block the client on the write.
    if (kv && result.ok) {
        const payload = JSON.stringify({
            body: result.body,
            status: result.status,
            lang: result.lang,
            cachedAt: Date.now()
        });
        const put = kv.put(cacheKey, payload, { expirationTtl: KV_TTL_SECONDS });
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put.catch(() => {}));
    }

    return makeJsonResponse(result.body, result.status, result.lang, 'MISS');
}

async function fetchSummary(lang, title) {
    const upstream = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/` +
        encodeURIComponent(title) + '?redirect=true';
    try {
        const r = await fetch(upstream, {
            headers: {
                'User-Agent': 'StelWebDemo/1.0 (https://stellarium-web.pages.dev)',
                'Accept': 'application/json'
            },
            cf: { cacheTtl: 86400, cacheEverything: true }
        });
        const body = await r.text();
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) { /* not json */ }
        const hasExtract = parsed && typeof parsed.extract === 'string' && parsed.extract.trim().length > 0;
        return {
            ok: r.ok && hasExtract,
            status: r.status,
            body,
            lang
        };
    } catch (err) {
        return { ok: false, status: 502, body: JSON.stringify({ error: String(err) }), lang };
    }
}

function makeJsonResponse(body, status, lang, kvStatus) {
    return new Response(body, {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600',
            'X-Wiki-Lang': lang,
            'X-KV-Cache': kvStatus || 'BYPASS'
        }
    });
}

function jsonError(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
        }
    });
}
