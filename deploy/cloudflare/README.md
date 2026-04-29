# Cloudflare Pages deployment

This directory contains everything needed to deploy the
Stellarium Web Engine demo to **Cloudflare Pages** as a static site.

## What gets deployed

The simple-html demo (`apps/simple-html/`) bundled with:

- `js/stellarium-web-engine.{js,wasm}` — the WebGL engine (built from the C/C++ sources via Emscripten).
- `static/` — fonts, icons, etc. used by the demo UI.
- `skydata/` — copy of `apps/test-skydata/` (stars, DSO, landscapes, surveys, comets, satellites…).
- `_headers` — sets `Content-Type: application/wasm`, COOP/COEP, and cache rules for Cloudflare Pages.

## Prerequisites

- Docker Desktop running (used to compile the engine with Emscripten).
- Node.js (for `npx wrangler`).
- A Cloudflare account.

## Build

```bash
./deploy/cloudflare/build.sh
```

This:

1. Builds the `swe-dev` Docker image (Emscripten 1.39.17 + scons) if missing.
2. Compiles the engine in release mode → `build/stellarium-web-engine.{js,wasm}`.
3. Assembles `deploy/cloudflare/public/` ready for Cloudflare Pages.

Total `public/` size: ~6 MB.

## Deploy

Direct upload via Wrangler:

```bash
npx wrangler login                 # one-time, opens browser
npx wrangler pages deploy deploy/cloudflare/public --project-name stellarium-web
```

The first deploy creates the project and prints a `*.pages.dev` URL.

### Or: connect a Git repo

In the Cloudflare dashboard → **Pages → Create project → Connect to Git**, then:

| Setting | Value |
| --- | --- |
| Build command | `./deploy/cloudflare/build.sh` |
| Build output directory | `deploy/cloudflare/public` |
| Root directory | `/` |

Note: the Cloudflare Pages build environment does **not** support running Docker, so the Git-driven build path requires switching the build script to install `emsdk` directly. The Wrangler direct-upload path (above) is the recommended workflow.

## Local preview

```bash
npx wrangler pages dev deploy/cloudflare/public
```
