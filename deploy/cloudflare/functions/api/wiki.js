// Cloudflare Pages Function: Wikipedia summary proxy.
//
// Usage:  GET /api/wiki?title=Sirius&lang=en
//
// Proxies https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}?redirect=true
// so the browser can call it from regions where direct access is blocked or
// when a CORS / network policy prevents the upstream request.

const ALLOWED_LANGS = new Set([
    'en', 'zh', 'fr', 'de', 'es', 'ja', 'ru', 'it', 'pt', 'ko'
]);

export async function onRequestGet({ request }) {
    const url = new URL(request.url);
    const title = (url.searchParams.get('title') || '').trim();
    const lang = (url.searchParams.get('lang') || 'en').toLowerCase();

    if (!title) {
        return json({ error: 'missing "title"' }, 400);
    }
    if (!ALLOWED_LANGS.has(lang)) {
        return json({ error: 'unsupported "lang"' }, 400);
    }

    const upstream = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/` +
        encodeURIComponent(title) + '?redirect=true';

    try {
        const r = await fetch(upstream, {
            headers: {
                'User-Agent': 'StelWebDemo/1.0 (https://stellarium-web.pages.dev)',
                'Accept': 'application/json'
            },
            // Cache successful responses for 24h on Cloudflare's edge.
            cf: { cacheTtl: 86400, cacheEverything: true }
        });
        const body = await r.text();
        return new Response(body, {
            status: r.status,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=3600'
            }
        });
    } catch (err) {
        return json({ error: 'upstream fetch failed', detail: String(err) }, 502);
    }
}

function json(obj, status) {
    return new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
        }
    });
}
