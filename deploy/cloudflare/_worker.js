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

    // Try the requested language first; if there's no article (404 or empty
    // extract), fall back to English so the user still gets a description.
    const primary = await fetchSummary(lang, title);
    if (primary.ok) {
        return makeJsonResponse(primary.body, primary.status, primary.lang);
    }
    if (lang !== 'en') {
        const fallback = await fetchSummary('en', title);
        if (fallback.ok || fallback.status === 200) {
            return makeJsonResponse(fallback.body, fallback.status, fallback.lang);
        }
        // Return whichever response we got (likely 404) so the client knows.
        return makeJsonResponse(fallback.body, fallback.status, fallback.lang);
    }
    return makeJsonResponse(primary.body, primary.status, primary.lang);
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

function makeJsonResponse(body, status, lang) {
    return new Response(body, {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600',
            'X-Wiki-Lang': lang
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
