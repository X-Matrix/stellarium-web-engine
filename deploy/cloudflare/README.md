# Cloudflare Pages 部署

把 [Stellarium Web Engine](https://github.com/Stellarium/stellarium-web-engine) 的演示页面打包成静态站点，部署到 **Cloudflare Pages**。线上：<https://stellarium.hatmatrix.me/>

> 这不是上游 simple-html 的简单复制。我们在原引擎之上重写了 UI、加入了多语言、AI 聊天、时间控制、维基百科信息卡，并通过 Cloudflare Worker 解决了上游 CDN 的 CORS / 缺数据问题。

## 功能

- **完整星表** — 三组 magnitude-banded 数据包（minimal / base / extended）+ 全套 DSO + 14 颗 SSO 行星 HiPS 贴图。
- **多语言 UI** — 内置中英日西等界面文案与 locales 切换（[js/locales.js](js/locales.js)）。
- **AI 助手** — 基于浏览器内置 LanguageModel API 的星空助手（[js/ai-chat.js](js/ai-chat.js)）。
- **维基信息卡** — 选中天体后，由 Worker 代理调用 Wikipedia REST API 获取摘要并 KV 缓存 30 天。
- **时间控制** — 倍速 / 暂停 / 快进 / 跳到现在 / 任意时间输入。
- **地理定位** — 启动时自动请求位置，按观测者纬经度计算地平坐标。

## 目录结构

```
deploy/cloudflare/
├── build.sh           # 构建脚本，输出 public/
├── index.html         # 单文件 SPA 骨架
├── css/app.css        # 全部样式
├── js/
│   ├── app.js         # Vue 主应用
│   ├── ai-chat.js     # AI 聊天 mixin
│   └── locales.js     # 多语言字典
├── _worker.js         # Cloudflare Pages advanced-mode Worker
├── _headers           # 缓存 / COEP / 内容类型规则
├── functions/         # Pages Functions（KV 绑定等）
└── public/            # 构建产物（gitignored）
```

## 数据流（重要）

上游 Stellarium-Web 把数据托管在 DigitalOcean Spaces：
`https://stellarium.sfo2.cdn.digitaloceanspaces.com/`。该桶**只允许 `stellarium-web.org` 这一个 Origin 命中 CORS**，其它域名 fetch 会得到 200 但响应头缺 `Access-Control-Allow-Origin`，浏览器静默丢弃 body，引擎日志里只看到「No data found for resource」。

解决方案：通过 [_worker.js](_worker.js) 提供同源代理，所有 `/cdn/<path>` 都映射到 `digitaloceanspaces.com/<path>`，请求时剥离 `Origin` 头，缓存 30 天。

[js/app.js](js/app.js) 里注册的数据源对应关系：

| 数据集 | URL | 说明 |
| --- | --- | --- |
| stars (minimal) | `/cdn/swe-data-packs/minimal/.../stars` | vmag −1..7 |
| stars (base) | `/cdn/swe-data-packs/base/.../stars` | vmag 7..8 |
| stars (extended) | `/cdn/swe-data-packs/extended/.../stars` | vmag 8..11.5 |
| dso (base + extended) | `/cdn/swe-data-packs/.../dso` | DSO 全集 |
| milkyway | `/cdn/surveys/milkyway/v1` | |
| 14 颗行星 + default | `/cdn/surveys/sso/<body>/v1` | moon/sun/mercury/venus/mars/jupiter/saturn/uranus/neptune/io/europa/ganymede/callisto |
| skycultures (western) | `skydata/skycultures/western` | 本地静态 |
| landscapes (guereins) | `skydata/landscapes/guereins` | 本地静态（上游 403） |
| MPC asteroids/comets | `skydata/mpcorb.dat`, `CometEls.txt` | 本地静态 |
| TLE 卫星 | `skydata/tle_satellite.jsonl.gz` | 本地静态 |

> ⚠️ 上游 `landscapes/` 目录返回 403，必须保留 `apps/test-skydata/landscapes/` 中的本地副本。

## Worker 路由

[_worker.js](_worker.js) 拦截以下请求，其它请求落到 Pages 静态资源：

| 路径 | 行为 |
| --- | --- |
| `/api/wiki?title=…&lang=…` | Wikipedia REST 摘要代理，命中 KV 缓存（30 天） |
| `/cdn/<path>` | DigitalOcean Spaces 同源代理（30 天 immutable） |

Pages Functions/KV 绑定：在 Cloudflare 控制台为项目绑定一个 KV namespace，名为 `WIKI_CACHE`。

## 缓存策略

[_headers](_headers) 关键规则：

- `*.wasm` — `application/wasm` + COEP `require-corp` + `max-age=31536000, immutable`
- `js/stellarium-web-engine.{js,wasm}` — 一年 immutable（内容版本化）
- 其它 `js/*`、`css/*` — `max-age=0, must-revalidate`（无内容指纹，避免旧版本被永久钉住）
- `index.html` 中所有非引擎脚本/样式都附带 `?v=<timestamp>`，构建时由 [build.sh](build.sh) 注入

> 历史踩坑：早期把 `/js/*` 全设成 immutable，部署新版后用户自定义域上的 Vue 报 `applyTimeInput is not a function`、wasm 报 `memory access out of bounds`，全是缓存撞旧 JS 配新 wasm 导致。

## 构建

```bash
./deploy/cloudflare/build.sh
```

依次：

1. 若无 `swe-dev` 镜像则构建（`Dockerfile.jsbuild`，含 emsdk + scons）。
2. 用 Docker 跑 emscripten 编译 → `build/stellarium-web-engine.{js,wasm}`。
3. 拼装 `deploy/cloudflare/public/`：引擎、test-skydata、本目录 css/js/index.html、_headers、_worker.js。
4. 在 `index.html` 里把 `__BUILD_VERSION__` 替换成时间戳，做缓存破坏。

需要重新跑引擎编译时，删除 `build/stellarium-web-engine.js`。

## 部署

```bash
npx wrangler login   # 首次
./deploy/cloudflare/build.sh
npx wrangler pages deploy deploy/cloudflare/public \
  --project-name stellarium-web --branch main
```

部署完输出形如 `https://<hash>.stellarium-web.pages.dev` 的预览 URL；自定义域名（`stellarium.hatmatrix.me`）由 Cloudflare 控制台的 Pages → Custom domains 配置。

### 本地预览

```bash
npx wrangler pages dev deploy/cloudflare/public
```

可同时本地 dev Worker（含 `/api/wiki` 与 `/cdn/*` 代理）。

## 排错速查

| 现象 | 排查 |
| --- | --- |
| 页面只见到极少星 | `/cdn/...stars` 返回 200？三个 magnitude pack 是否全部注册？ |
| 控制台 `No data found for resource` | 该 URL 是否走了 `/cdn/` 代理？直连 DO Spaces 会被 CORS 砍掉 body |
| Vue 报某 method 未定义 | 浏览器/CF 边缘缓存中的旧 `app.js` 未刷新；强制刷新或检查 `index.html` 是否带 `?v=` |
| `core_add_font` wasm OOB | 同上，旧 wasm 配新 JS。把构建产物全清掉重发 |
| Wikipedia 卡片为空 | KV 绑定 `WIKI_CACHE` 是否配置？维基语言代码是否被支持 |
