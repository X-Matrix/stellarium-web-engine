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
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === '/api/wiki') {
            return handleWiki(url);
        }

        // Anything else: serve the static asset.
        return env.ASSETS.fetch(request);
    }
};

async function handleWiki(url) {
    const title = (url.searchParams.get('title') || '').trim();
    const lang = (url.searchParams.get('lang') || 'en').toLowerCase();

    if (!title) return jsonError('missing "title"', 400);
    if (!ALLOWED_LANGS.has(lang)) return jsonError('unsupported "lang"', 400);

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
        return new Response(body, {
            status: r.status,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=3600'
            }
        });
    } catch (err) {
        return jsonError('upstream fetch failed: ' + String(err), 502);
    }
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
