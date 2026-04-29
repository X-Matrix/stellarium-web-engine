#!/usr/bin/env bash
# Build Stellarium Web Engine and assemble a static site for Cloudflare Pages.
#
# Usage:   ./deploy/cloudflare/build.sh
# Output:  deploy/cloudflare/public/   (ready to deploy)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/deploy/cloudflare/public"

cd "$ROOT"

# 1. Build engine (requires Docker + the swe-dev image, see README)
if [ ! -f "$ROOT/build/stellarium-web-engine.js" ] || \
   [ ! -f "$ROOT/build/stellarium-web-engine.wasm" ]; then
  echo "==> Building engine (emscripten in Docker)..."
  docker image inspect swe-dev >/dev/null 2>&1 || \
    docker build -f deploy/cloudflare/Dockerfile.jsbuild -t swe-dev .
  docker run --rm -v "$ROOT:/app" swe-dev \
    /bin/bash -c "source /emsdk/emsdk_env.sh && cd /app && scons -j8 mode=release"
fi

# 2. Assemble public/
echo "==> Assembling $OUT"
rm -rf "$OUT"
mkdir -p "$OUT/js" "$OUT/skydata"

cp build/stellarium-web-engine.js   "$OUT/js/"
cp build/stellarium-web-engine.wasm "$OUT/js/"

cp -R apps/simple-html/static       "$OUT/static"
cp -R apps/test-skydata/.           "$OUT/skydata/"

cp deploy/cloudflare/index.html     "$OUT/index.html"
cp deploy/cloudflare/_headers       "$OUT/_headers"

# Advanced-mode worker (Wikipedia proxy at /api/wiki).
if [ -f "$ROOT/deploy/cloudflare/_worker.js" ]; then
  cp "$ROOT/deploy/cloudflare/_worker.js" "$OUT/_worker.js"
fi

echo "==> Done. Deploy with:"
echo "    npx wrangler pages deploy $OUT --project-name stellarium-web"
