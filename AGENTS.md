# static-upload-server — Agent Guide

## Quick Reference

- **Stack**: Node (>= 24.12, `.node-version` 26), TypeScript run as is (erasable syntax only), pnpm, Biome. Runtime deps: `@marianmeres/demino` >= 2.2.0 (`serve` from `/node`, `serveStatic`), `mime-types`
- **Gate**: `pnpm run ci` (typecheck + lint + test + smoke)
- **Test**: `pnpm test` (`node:test`, `node:assert/strict`)
- **Typecheck**: `pnpm run typecheck` (Node never checks types; this is the type gate)
- **Lint / format**: `pnpm run lint` / `pnpm run format` (Biome: tabs, 90-char lines, indent 4)
- **Build**: `pnpm run build` (`tsc` to `dist/` + copies `src/upload.html`); **Smoke**: `pnpm run smoke` (packs, npm-installs, runs the bin from `dist/`)
- **Dev**: `pnpm run dev` | **Example**: `pnpm run example` (loads `.env.example`)

## Project Structure

```
src/server.ts          — createServer(), handler, StaticServerOptions
src/cli.ts             — CLI entry and npm `bin` (reads env vars, calls createServer, stops on SIGTERM/SIGINT)
src/config.ts          — ProjectConfig, loadProjectConfig(), cache (keyed by configDir+projectId)
src/auth.ts            — isAuthorized(), extractBearerToken(), timingSafeEqualStr()
src/jwt.ts             — HS256 JWT verification (Web Crypto); `typ` is optional per RFC 7519
src/paths.ts           — sanitizePath(), resolveUnderStaticDir() (uses node:path `relative()`)
src/content-type.ts    — contentTypeOf() (the one MIME lookup, `mime-types`), extOf(), mimeMatches(), checkUploadPolicy() (size/ext/mime gates)
src/storage.ts         — saveStreamAtomic(), writeWithLimit(), typed errors (SizeLimit/IncompleteBody/IdleTimeout)
src/logger.ts          — Logger interface, defaultLogger(), silentLogger
src/plugin.ts          — PluginHandler, PluginContext, loadPlugin() (sandboxed to configDir)
src/cdn.ts             — CdnAdapter, CdnOptions, createCdnAdapter(), noStoreHeaders()
src/cdn/cloudflare.ts  — CloudflareCdnAdapter
src/cache-strategy.ts  — resolveCacheStrategy(cfg, filePath) (longest-prefix lookup)
src/handlers/form.ts   — GET /:projectId (upload form, lazy-loads HTML)
src/handlers/upload.ts — POST /:projectId (multipart; buffers via req.formData(), then streaming write with byte cap, partial-failure reporting)
src/handlers/put.ts    — PUT /:projectId/* (raw body streamed socket→disk, O(1) memory; for large/machine uploads)
src/handlers/serve.ts  — GET/HEAD /:projectId/* (demino `serveStatic`; nosniff, forceDownload, CORS off for protected)
src/handlers/delete.ts — DELETE /:projectId/*
src/upload.html        — Upload form template
tests/_helpers.ts      — Shared test utilities
tests/*.test.ts        — auth, auth_timing, cache, cache-strategy, cdn, config, delete, hardening, jwt, plugin, policy, put, serve, sweep, upload: all call `handler(req)` directly
tests/wire.test.ts     — the same server through `start()` on a free port and real sockets (streamed bodies, refused / stalled / abandoned uploads)
tests/cli.test.ts      — `node src/cli.ts` as a subprocess (`PORT=0`, SIGTERM)
example/main.ts        — Example usage
scripts/memcheck.ts    — Measure server RSS for a large upload (post vs put mode)
scripts/smoke-npm.ts   — Pack, npm-install into a temp project, run the bin and the library from `dist/`
.github/workflows/build-image.yml — on a vX.Y.Z tag: tag == package.json version, `pnpm run ci`, build, start + version check, push to ghcr.io/<owner>/<repo>:<tag>
deploy.sh              — host deploy: check out a tag, pull its image, record APP_IMAGE_TAG in `.env`, `up --wait`, check the version. Never builds
docker-compose.yml     — the deployed service, `image:` only (no `build:`)
docker-compose.build.yml — local build override (`docker compose -f docker-compose.yml -f docker-compose.build.yml build`), tag `dev`
.env.example           — Example env config
```

## Exports (package.json)

| Entry        | File (source → published)          | Purpose                         |
| ------------ | ---------------------------------- | ------------------------------- |
| `"."`        | `src/server.ts` → `dist/server.js` | Programmatic API                |
| `"./server"` | `src/server.ts` → `dist/server.js` | Same module (the 1.x specifier) |
| `bin`        | `src/cli.ts` → `dist/cli.js`       | CLI (`npx <package>`)           |

npm publishes `dist/` only. A checkout and the Docker image run `src/*.ts` directly (`node src/cli.ts`), with no build.

## Programmatic API

- `createServer(opts)` → `Promise<{ handler, start, version }>`. **async** (CDN adapter init, version read).
- `start()` → `Promise<ServeHandle>` (demino's: `port`, `hostname`, `url`, `shutdown()`, `finished`, `ref()`, `unref()`). Resolves once bound; `port: 0` binds a free port.
- `clearConfigCache(configDir?)` — clear all, or only entries for a given configDir.
- Types re-exported from `server`: `CdnAdapter`, `CdnOptions`, `Logger`, `PluginContext`, `ProjectConfig`, `ServeHandle`, `StaticServerOptions`.

## Configuration

### `StaticServerOptions`

| Field                 | Type                  | Default                 | Notes                                                                                  |
| --------------------- | --------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `port`                | `number`              | `8000`                  | `0` = a free port (the banner and the `start()` handle report the real one)            |
| `staticDir`           | `string`              | `"./static"`            |                                                                                        |
| `configDir`           | `string`              | `"./config"`            |                                                                                        |
| `enableUploadForm`    | `boolean`             | `true`                  | Server-level default; per-project `enableUploadForm` overrides                         |
| `jwtSecret`           | `string`              | —                       | Fallback for projects without `jwt.secret`                                             |
| `globalToken`         | `string`              | —                       | Superuser upload/delete/download                                                       |
| `cdn`                 | `Partial<CdnOptions>` | —                       | Omit to disable                                                                        |
| `rootFiles`           | `string[]`            | `[]`                    | Exact filenames to serve from staticDir root (e.g. `["favicon.ico"]`). No config load. |
| `logger`              | `boolean \| Logger`   | `false`                 | `true` = JSON-line to stderr; object = custom                                          |
| `tmpSweepMaxAgeMs`    | `number`              | `3_600_000`             | On startup, remove `.tmp_*` files older than this. `0` disables.                       |
| `maxUploadSize`       | `number`              | `2_147_483_648` (2 GiB) | Fallback per-file byte cap when project sets no `maxFileSize`. `0` = unlimited.        |
| `uploadIdleTimeoutMs` | `number`              | `60_000`                | Abort upload when no body chunk arrives within this window (408). `0` disables.        |

### `ProjectConfig` (JSON at `{configDir}/{projectId}.json`)

| Field               | Type                           | Default     | Notes                                                                                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `uploadTokens`      | `string[]`                     | required    | `[]` disables upload auth                                                                                                                                                                                                                                                                                          |
| `downloadTokens`    | `string[]`                     | —           | Non-empty → GET requires bearer token                                                                                                                                                                                                                                                                              |
| `enableUploadForm`  | `boolean`                      | server-side | Per-project override of server default                                                                                                                                                                                                                                                                             |
| `enableDelete`      | `boolean`                      | `true`      | Also requires non-empty `uploadTokens`                                                                                                                                                                                                                                                                             |
| `plugin`            | `string`                       | —           | Path relative to configDir; **must resolve inside configDir**                                                                                                                                                                                                                                                      |
| `jwt.secret`        | `string`                       | —           | Per-project JWT secret                                                                                                                                                                                                                                                                                             |
| `getAccessControl`  | `"public" \| "token" \| "jwt"` | `"public"`  | GET access control                                                                                                                                                                                                                                                                                                 |
| `cacheStrategy`     | `CacheStrategyConfig`          | `"mutable"` | Scalar (`"mutable"`/`"immutable"`) **or** `Record<prefix, strategy>` for per-subpath control. Longest matching prefix wins; `*`/`/` is the fallback bucket. Resolved per request by `resolveCacheStrategy` ([src/cache-strategy.ts](src/cache-strategy.ts)) before being passed to `CdnAdapter.applyCacheHeaders`. |
| `maxFileSize`       | `number`                       | —           | Bytes; per-file cap. Oversize → `413` with `rejected`. When unset, server-level `maxUploadSize` applies.                                                                                                                                                                                                           |
| `allowedExtensions` | `string[]`                     | —           | Lowercase, no dot. Non-match → `400` with `rejected`.                                                                                                                                                                                                                                                              |
| `allowedMimeTypes`  | `string[]`                     | —           | Exact or `type/*` wildcard. Non-match → `400` with `rejected`. POST checks the client-declared per-part type; PUT derives the MIME from the file extension (`contentTypeOf`, the lookup GET serves with) so headers can't spoof it.                                                                                |
| `forceDownload`     | `boolean`                      | `false`     | Adds `Content-Disposition: attachment` on served files                                                                                                                                                                                                                                                             |

## Key Patterns

- **Atomic streaming writes**: both upload routes go through `saveStreamAtomic` ([src/storage.ts](src/storage.ts)) — mkdir, write to `.tmp_<uuid>` with the byte cap enforced mid-stream, rename on success, remove tmp + typed error on failure. NOTE the asymmetry: PUT streams the socket straight to disk (O(1) memory), while POST's `req.formData()` buffers the parsed multipart body in RAM (about 4× file size peak, measured with `scripts/memcheck.ts`) before the disk write — large/machine uploads should use PUT.
- **Effective size cap**: `config.maxFileSize ?? maxUploadSize` (server option, default 2 GiB, `0` = unlimited). PUT also pre-checks a declared `Content-Length` (413 before reading) and rejects a body that ends short of it (400, nothing published); a `fetch` with a streamed body sends it chunked (no `Content-Length`), so the `size` field in the PUT response is such a client's integrity check.
- **Partial success reporting**: upload response is `{ uploaded, rejected? }` (PUT adds `size` = bytes written). `rejected` is `[{ name, reason }]` if any files were skipped. All-rejected → `413` (size-only), `500` (write-failure-only), or `400`.
- **Unhandled request errors**: the exported `handler` wraps routing in try/catch — logs `request.unhandled` (method, path, stack) and returns a generic 500; `start()` additionally passes `onError` to the adapter's `serve()` for errors outside the handler. Response body is the plain-text `"Internal Server Error"`.
- **CDN purge is fire-and-forget** (`queueMicrotask`): response is not blocked on CDN round-trip. `CdnAdapter.purgeCache` contract: must never throw.
- **Per-prefix cache strategy**: `cacheStrategy` accepts a `{ prefix: "mutable" | "immutable" }` map alongside the scalar form. `normalizeCacheStrategy` ([src/config.ts](src/config.ts)) strips trailing `*` and stores the fallback (`*` / `/` / `""` / `/*`) as `""`. The serve handler resolves once per request with the project-relative path (`"/" + filePath`).
- **Hardening headers** on all served files: `X-Content-Type-Options: nosniff` (always), `Content-Disposition: attachment` (if `forceDownload`).
- **CORS**: enabled only for fully public GETs. Disabled when `downloadTokens` set OR `getAccessControl` is `"token"` / `"jwt"`.
- **Timing-safe token comparison** (`timingSafeEqualStr`): walks full `expected.length`, XOR-accumulates diff, compares once at end.
- **Path boundary**: `resolveUnderStaticDir()` uses `node:path`'s `relative()` instead of string `startsWith`.
- **Plugin sandbox**: `loadPlugin` rejects paths that resolve outside configDir; imports via `pathToFileURL` for cross-platform safety. Node imports the plugin as is: erasable TypeScript only, relative and `node:` imports, no `Deno` global.
- **Lazy file loads**: `package.json` (for version) and `upload.html` are read on first use, not at import time, both relative to the module (`../package.json`, `../upload.html`). That resolves the same from `src/` and from `dist/`, which is why the build copies `upload.html` into `dist/`.
- **HTTP layer**: `start()` runs `handler` on demino's Node adapter (`serve`, `webSockets: false`). A request body is the socket as a web stream, so PUT reads it with backpressure. An upload refused before its body was read (401, 413 by `Content-Length`, policy reject) is answered at once and the rest of the body is never read; the server closes that connection when its keep-alive timeout runs out. `tests/wire.test.ts` pins this. `requestTimeout: 0` (demino >= 2.2.0) switches off Node's 5-minute limit on a whole request, which would 408 a long upload however steadily it arrives: a PUT is bounded by the byte cap and the idle timeout, the multipart POST only by the reverse proxy. Node's 60 s limit on the headers stays; the wire tests pin both values through the `http.server.request.start` diagnostics channel.
- **Serving**: `serveStatic` does the file work (Range, `If-Range`, `ETag` / `Last-Modified`, HEAD, `index.html` for a directory, dot-segments 404). `handleServe` overrides its `Content-Type` with `contentTypeOf` (demino's own table lacks vendor types such as `.ico`, `.xlsx`) and adds nosniff, `Content-Disposition` and the CORS headers.
- **Shutdown**: the CLI handles SIGTERM / SIGINT with `ServeHandle.shutdown()` and exits 0. In the Docker image `node` is PID 1 and gets no default signal action, so without the handler `docker stop` would time out.
- **Image and deploy**: the image is built only by `.github/workflows/build-image.yml` and pulled by `deploy.sh`. Keep `build:` out of `docker-compose.yml`: with both `image:` and `build:`, Compose builds on the host when the pull fails and tags the result with the release's name. The image's `HEALTHCHECK` (`GET /`) is what `up --wait` and the workflow's smoke step wait for. `deploy.sh` ships in each release: when the tag being deployed carries a different version of it, that version takes over after the checkout (`exec`), so its interface stays `deploy.sh [tag]`, and it must deploy a tag that is already checked out but not running.
- **Logger**: all handlers receive a `Logger`. `silentLogger` by default. Events: `upload.unauthorized`, `upload.done`, `upload.write_failed`, `upload.idle_timeout`, `delete.unauthorized`, `delete.done`, `serve.unauthorized`, `serve.jwt_not_configured`, `config.load_failed`, `plugin.error`, `cdn.purge_failed`, `tmp.swept`, `request.unhandled`. PUT-originated upload events carry `via: "put"`.
- **Tmp sweep**: on startup, walks `staticDir`, removes `*.tmp_<uuid>` files older than `tmpSweepMaxAgeMs`. Non-blocking, never throws. The pattern matches the exact `crypto.randomUUID()` shape so stored user files (e.g. `backup.tmp_2026-07-14`) are never swept.
- **Root files**: `GET /<name>` serves `staticDir/<name>` ONLY for names listed in `opts.rootFiles`. No implicit allow.
- **Config cache**: keyed by `configDir\0projectId`. Multiple `createServer` instances with different configDirs are isolated.

## Env Vars

Server: `PORT`, `STATIC_DIR`, `CONFIG_DIR`, `ENABLE_UPLOAD_FORM`, `JWT_SECRET`, `GLOBAL_TOKEN`, `ROOT_FILES` (comma-separated), `LOG` (`true`/`1` for JSON-line stderr), `TMP_SWEEP_MAX_AGE_MS`, `MAX_UPLOAD_SIZE` (bytes, `0` = unlimited), `UPLOAD_IDLE_TIMEOUT_MS` (`0` = disabled).
CDN: `CDN_PROVIDER`, `CDN_CACHE_PURGE_URL_PREFIX`, `CDN_CACHE_MAX_AGE`, `CDN_CACHE_S_MAXAGE`, `CDN_STALE_WHILE_REVALIDATE`.
Cloudflare: `CF_ZONE_ID`, `CF_API_TOKEN`.
Docker: `PUID`, `PGID`, `APP_IMAGE` (registry path, default `ghcr.io/marianmeres/static-upload-server`), `APP_IMAGE_TAG` (written by `deploy.sh`; `dev` when unset).

## Routes

| Method | Path            | Handler                                                                         |
| ------ | --------------- | ------------------------------------------------------------------------------- |
| GET    | `/`             | Version signature `{ version }`                                                 |
| GET    | `/<rootFile>`   | Whitelisted root file                                                           |
| GET    | `/:projectId`   | Upload form (if enabled)                                                        |
| POST   | `/:projectId`   | Upload file(s)                                                                  |
| GET    | `/:projectId/*` | Serve static file                                                               |
| HEAD   | `/:projectId/*` | File info (headers only)                                                        |
| PUT    | `/:projectId/*` | Upload file (raw body, streamed; path from URL, percent-decoded then sanitized) |
| DELETE | `/:projectId/*` | Delete file                                                                     |

## Critical Conventions

1. Tabs for indentation (Biome enforces)
2. Runtime dependencies are `@marianmeres/demino` and `mime-types`, nothing else without a reason. Web standards first, `node:*` where they don't reach; no `Deno.*` / `Bun.*`, no `jsr:` / `npm:` / `https:` specifiers
3. Erasable-only TypeScript (no `enum`, `namespace`, parameter properties), `import type` for types, `.ts` extensions in relative imports: Node runs `src/` unbuilt
4. Project IDs match `/^[a-zA-Z0-9\-_]+$/`
5. `uploadTokens` required (empty array = auth disabled)
6. Plugin paths must resolve inside `configDir`
7. A server a test or script starts itself listens on port `0` (OS-assigned), never a fixed port

## Breaking Changes (from 1.4.3)

| Change                                                                   | Mitigation                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Root files: `/favicon.ico` etc. now require `rootFiles: ["favicon.ico"]` | Add filenames to `rootFiles` (or env `ROOT_FILES=favicon.ico,robots.txt`)             |
| `enableUploadForm: false` server-level **actually disables** the form    | Previously silently ignored. Remove the option if the old no-op was relied on.        |
| CORS disabled for auth-protected GETs (`downloadTokens`, `token`, `jwt`) | Serve protected files from same-origin, or write a plugin that sets CORS manually     |
| CDN purge no longer awaited before upload/delete response                | Response returns faster. Clients must not assume cache was purged before 200.         |
| Config cache keyed by `configDir\0projectId` (was projectId only)        | Same-project-id across different configDirs is now isolated (bug fix).                |
| JWT `typ` now OPTIONAL (was required to be `"JWT"`)                      | Spec-compliant. Tokens without `typ` now verify; explicit wrong `typ` still rejected. |
| Upload response may include `rejected: [{name, reason}]`                 | Additive; existing `uploaded` field unchanged                                         |
| `handleForm` is now async (internal)                                     | Internal. If you import it directly, `await` the call.                                |
| `X-Content-Type-Options: nosniff` added to served files                  | Security hardening. Should be non-breaking for browsers.                              |

## Breaking Changes (from 1.6.0)

| Change                                                                                                                                                  | Mitigation                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| New `PUT /:projectId/*` upload route; plugins that return `null` for PUT-with-path no longer fall through to a guaranteed 404 but to the upload handler | Auth still applies (`uploadTokens`). Gate PUT in the plugin, or set `uploadTokens`, if the plugin was the de-facto gate on an open project. |
| Uploads capped at 2 GiB by default when project sets no `maxFileSize` (`maxUploadSize` option / `MAX_UPLOAD_SIZE` env)                                  | Set `MAX_UPLOAD_SIZE=0` to restore unlimited, or set a per-project `maxFileSize`.                                                           |
| All-files-write-failed POST now returns `500` (was `400`)                                                                                               | Server faults now surface as 5xx; adjust clients that special-cased the old 400.                                                            |
| Uploads stalled >60s between body chunks are aborted with `408` (`uploadIdleTimeoutMs` / `UPLOAD_IDLE_TIMEOUT_MS`)                                      | Set `UPLOAD_IDLE_TIMEOUT_MS=0` to disable.                                                                                                  |
| docker-compose now enables structured logs by default (`LOG=true`)                                                                                      | Set `LOG=false` in `.env` to silence.                                                                                                       |
| Tmp-sweep pattern tightened to the exact `.tmp_<uuid>` shape                                                                                            | None needed — strictly fewer files match (stored user files are never swept).                                                               |

## Breaking Changes (from 1.7.0)

The move from Deno to Node. The HTTP API (routes, statuses, response bodies) is unchanged.

| Change                                                                                                                                | Mitigation                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Package renamed to `@marianmeres/static-upload-server`, command `static-upload-server` (was `@marianmeres/deno-static-upload-server`) | Update the dependency name and the command; the old name stays on JSR at 1.7.0, with no further releases |
| Runtime is Node >= 24.12; published to npm (JSR stays at 1.7.0)                                                                       | `npx <package>` replaces `deno run -A jsr:…` / `deno install`; Docker image is `node:26-slim`            |
| Import specifier is the bare package name (`"."`, also `"./server"`)                                                                  | Replace `jsr:@marianmeres/deno-static-upload-server/server`                                              |
| `start()` is async and resolves with a `ServeHandle`, not a `Deno.HttpServer`                                                         | `await start()`; use `handle.port`, `handle.shutdown()`                                                  |
| Plugins are loaded by Node                                                                                                            | Erasable TypeScript only; no `npm:` / `jsr:` / `https:` imports; no `Deno` global                        |
| Served files: new `ETag` format, unknown extension → `application/octet-stream`, relative 301 `Location`                              | None needed; clients revalidate once                                                                     |
| GET of a path with malformed percent-encoding is `400` (was `500`)                                                                    | None needed                                                                                              |
| The per-request access line GETs printed to stdout is gone                                                                            | Use the reverse proxy's access log; structured events (`LOG=true`) are unchanged                         |
| `PORT=0` binds a free port (used to fall back to `8000`)                                                                              | Unset `PORT` for the default                                                                             |

## Before Making Changes

- [ ] Read `src/server.ts` — main routing and handler orchestration
- [ ] Run `pnpm run ci` — typecheck, lint, tests and the npm smoke must pass
- [ ] Run `pnpm run format` before committing
- [ ] For security-adjacent changes, add a test in `tests/hardening.test.ts` or `tests/policy.test.ts`
- [ ] For anything touching request bodies, connections or `start()`, add a test in `tests/wire.test.ts`: the handler-level tests never reach the HTTP layer
