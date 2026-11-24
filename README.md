# @marianmeres/static-upload-server

[![NPM](https://img.shields.io/npm/v/@marianmeres/static-upload-server)](https://www.npmjs.com/package/@marianmeres/static-upload-server)
[![License](https://img.shields.io/github/license/marianmeres/static-upload-server)](LICENSE)

A lightweight, self-hosted static file server with upload endpoint and per-project configuration. Built for a reliable home for static assets without the complexity of a full cloud storage setup.

## Features

- **Per-project configuration** — each project gets its own JSON config with independent auth tokens
- **Upload endpoints** — `multipart/form-data` POST for the browser form, and a raw-body streaming PUT for machine clients and large files (constant memory, any size)
- **Static file serving** — range requests, conditional requests (`ETag` / `Last-Modified`), content types by extension
- **Delete endpoint** — remove uploaded files (requires auth)
- **Plugin architecture** — custom handlers per project, sandboxed to configDir
- **JWT support** — HS256 token verification (Web Crypto, zero-dep)
- **GET access control** — optional token/JWT requirement for static file serving
- **Download tokens** — per-project bearer tokens for download protection
- **Global token** — superuser token for cross-project upload, delete, and download access
- **Browser upload form** — built-in HTML form at `GET /:projectId`
- **CDN integration** — optional, provider-agnostic (Cloudflare adapter included). Cache headers + fire-and-forget purge on upload/delete
- **Upload policies** — per-project `maxFileSize`, `allowedExtensions`, `allowedMimeTypes`, `forceDownload`
- **Hardened serving** — `X-Content-Type-Options: nosniff` always on; CORS off for auth-protected content
- **Structured logging** — pluggable `Logger` interface with a JSON-line default
- **Runs on Node** — two runtime dependencies: [`@marianmeres/demino`](https://github.com/marianmeres/demino) (HTTP layer and file serving) and `mime-types`

## Quick start

### 1. Create a project config

```bash
mkdir -p config
echo '{"uploadTokens": ["my-secret-token"]}' > config/my-app.json
```

### 2. Run the server

Requires Node 24.12 or newer. (Coming from the Deno-based 1.x, published on JSR
as `@marianmeres/deno-static-upload-server`? See the
[breaking changes](API.md#breaking-changes-from-170).)

```bash
PORT=8000 \
STATIC_DIR=./static \
CONFIG_DIR=./config \
npx @marianmeres/static-upload-server
```

### Programmatic usage

```bash
npm install @marianmeres/static-upload-server
```

```ts
import { createServer } from "@marianmeres/static-upload-server";

const server = await createServer({
	port: 8000,
	staticDir: "./static",
	configDir: "./config",
	logger: true, // JSON-line logs to stderr
});

await server.start();
```

## Configuration

### Server options (env vars)

| Option             | Env var                | Default    | Description                                                             |
| ------------------ | ---------------------- | ---------- | ----------------------------------------------------------------------- |
| `port`             | `PORT`                 | `8000`     | Port to listen on (`0` = a free port, printed at startup)               |
| `staticDir`        | `STATIC_DIR`           | `./static` | Root directory for stored files                                         |
| `configDir`        | `CONFIG_DIR`           | `./config` | Directory for per-project JSON configs                                  |
| `enableUploadForm` | `ENABLE_UPLOAD_FORM`   | `true`     | Server default for upload form                                          |
| `jwtSecret`        | `JWT_SECRET`           | —          | Shared JWT secret                                                       |
| `globalToken`      | `GLOBAL_TOKEN`         | —          | Superuser token for all projects                                        |
| `rootFiles`        | `ROOT_FILES`           | `[]`       | Comma-separated root filenames to serve (e.g. `favicon.ico,robots.txt`) |
| `logger`           | `LOG`                  | off        | Set `LOG=true` for JSON-line logs                                       |
| `tmpSweepMaxAgeMs` | `TMP_SWEEP_MAX_AGE_MS` | `3600000`  | Remove stale `.tmp_*` files older than this on startup                  |
| CDN options        | `CDN_*`, `CF_*`        | —          | See [API.md](API.md)                                                    |

### Per-project config (`config/{projectId}.json`)

```json
{
	"uploadTokens": ["token-a", "token-b"],
	"downloadTokens": ["dl-token"],
	"enableUploadForm": true,
	"enableDelete": true,
	"plugin": "./plugins/my-project.ts",
	"jwt": { "secret": "per-project-secret" },
	"getAccessControl": "public",
	"cacheStrategy": "mutable",
	"maxFileSize": 10485760,
	"allowedExtensions": ["png", "jpg", "webp"],
	"allowedMimeTypes": ["image/*"],
	"forceDownload": false
}
```

- `uploadTokens` (required) — empty array disables auth for uploads
- `downloadTokens` — if non-empty, GET requires a matching bearer token
- `getAccessControl` — `"public"` (default), `"token"`, or `"jwt"` for GET requests
- `cacheStrategy` — `"mutable"` (default) or `"immutable"` (for content-hashed filenames). Also accepts a `prefix → strategy` map for per-subpath control within one project, e.g. `{ "/img/": "immutable", "*": "mutable" }`. Longest matching prefix wins; bare `*` or `/` is the fallback. See [API.md](./API.md#cache-headers) for details.
- `maxFileSize` — bytes; oversized uploads return `413` (streaming enforcement)
- `allowedExtensions` — lowercase, no dot. Non-matching extensions return `400`
- `allowedMimeTypes` — exact MIME type or `type/*` wildcard
- `forceDownload` — adds `Content-Disposition: attachment` to served files (mitigates inline XSS from user-uploaded HTML/SVG)

### Global token

Set `GLOBAL_TOKEN` to define a superuser token accepted for uploads, deletes, and downloads across all projects. It does not change per-project auth requirements — open projects (with empty `uploadTokens`) remain open.

### Using a `.env` file

Node loads it with `--env-file`. With the package installed locally:

```bash
node --env-file=.env node_modules/.bin/static-upload-server
```

From a checkout of this repository it is `node --env-file=.env src/cli.ts`.
Docker Compose reads `.env` on its own.

## API

See [API.md](API.md) for complete API documentation.

### Routes

| Method | Path            | Description                      |
| ------ | --------------- | -------------------------------- |
| GET    | `/`             | Version signature                |
| GET    | `/<rootFile>`   | Whitelisted root file            |
| GET    | `/:projectId`   | Upload form                      |
| POST   | `/:projectId`   | Upload files (multipart)         |
| GET    | `/:projectId/*` | Serve static file                |
| HEAD   | `/:projectId/*` | File info (headers only)         |
| PUT    | `/:projectId/*` | Upload file (raw body, streamed) |
| DELETE | `/:projectId/*` | Delete file                      |

### Upload a file (multipart POST)

```bash
curl -X POST http://localhost:8000/my-app \
  -H "Authorization: Bearer my-secret-token" \
  -F "file=@photo.webp;filename=images/thumbs/photo.webp"
```

**Response:**

```json
{ "uploaded": ["/my-app/images/thumbs/photo.webp"] }
```

If one or more files are rejected by policy (size/extension/MIME), the response also includes a `rejected` array:

```json
{
	"uploaded": ["/my-app/ok.png"],
	"rejected": [{ "name": "huge.mp4", "reason": "File exceeds maxFileSize (10485760)" }]
}
```

All-rejected responses return `413` when size was the only reason, `500` when all rejections were write failures, otherwise `400`.

> **Memory note:** parsing multipart buffers the whole request body in RAM
> (about 4× the file size at peak, per concurrent upload). POST is meant for the
> browser form and small files — for large files or machine clients, use PUT.

### Upload a file (streaming PUT)

The request body **is** the file; the destination path comes from the URL. Bytes
stream from the socket straight to disk — constant memory, any file size — and
are atomically renamed into place when complete.

```bash
curl -T backup.sql.gz \
  -H "Authorization: Bearer my-secret-token" \
  http://localhost:8000/my-app/daily/backup.sql.gz
```

**Response:**

```json
{ "uploaded": ["/my-app/daily/backup.sql.gz"], "size": 100452466 }
```

`size` is the number of bytes stored — clients streaming without a
`Content-Length` (e.g. a `fetch` with a streamed body) should verify it against the
source file size. See [API.md](API.md) for status codes and details.

### Delete a file

```
DELETE /:projectId/path/to/file.webp
Authorization: Bearer <token>
```

**Response:**

```json
{ "deleted": "/my-app/path/to/file.webp" }
```

## CDN integration

Optional, provider-agnostic CDN support. When configured, the server:

- Adds `Cache-Control` headers to served static files
- Purges CDN cache when files are uploaded or deleted (fire-and-forget — does not block the response)
- Sets `Cache-Control: no-store` on non-static responses (version endpoint, upload form)

### Cloudflare setup

```env
CDN_PROVIDER=cloudflare
CDN_CACHE_PURGE_URL_PREFIX=https://cdn.example.com
CF_ZONE_ID=your-zone-id
CF_API_TOKEN=your-api-token
```

The API token needs the **Cache Purge** permission for your zone. See [API.md](API.md) for all CDN options.

## Security hardening

- **`X-Content-Type-Options: nosniff`** is set on every served file. Mitigates MIME-sniffing attacks.
- **`forceDownload: true`** (per-project) forces `Content-Disposition: attachment` on served files — recommended when accepting untrusted uploads that include HTML/SVG.
- **CORS** is disabled automatically when GETs are protected (`downloadTokens` set, or `getAccessControl` is `"token"` / `"jwt"`). Public content still gets `Access-Control-Allow-Origin: *`.
- **Constant-time token comparison** for upload/download tokens and the global token.
- **Plugin sandbox**: plugin paths must resolve inside `configDir`.
- **`maxFileSize`** enforcement is streaming — oversized uploads are aborted mid-stream (the temp file is removed). Projects without `maxFileSize` fall back to the server-level `maxUploadSize` (default 2 GiB; `MAX_UPLOAD_SIZE=0` for unlimited) so a single streaming upload can't fill the disk.
- **Stalled uploads** are aborted after 60s without a body chunk (`UPLOAD_IDLE_TIMEOUT_MS`, `0` disables) so slow-drip connections can't pin file descriptors and temp files indefinitely.
- **No limit on a request's total duration.** Node's own 5-minute limit on a whole request is switched off: it would cut a large upload on a slow link however steadily it arrives. A `PUT` is bounded by the size cap and the stall timeout above instead. The multipart `POST` route has no time bound of its own (its body is parsed before any check), so bound it at the reverse proxy. Request headers still have to arrive within 60 s.
- **Unhandled request errors** return a generic 500 and are logged as `request.unhandled` with the stack — enable `LOG=true` in production (docker-compose does this by default).
- **Recommendation for public upload endpoints**: serve uploaded files from a dedicated cookieless domain, and combine with `forceDownload` and `allowedExtensions`/`allowedMimeTypes` to constrain accepted content.
- **Rate limiting** is out of scope — put a reverse-proxy limiter in front of the server if exposed to the public internet.
- **Reverse proxy + large uploads**: if nginx fronts this server, keep `client_max_body_size` in sync with your server-side caps, and consider `proxy_request_buffering off` for the streaming PUT route so bodies aren't spooled to the proxy's disk first — see [nginx.example.conf](nginx.example.conf).

## Plugin system

Create a TypeScript module (inside `configDir`) that default-exports a handler function:

```ts
// config/plugins/my-project.ts
export default async function (req, ctx) {
	// Custom logic here
	// Return Response to handle, or null to use default handler
	return ctx.defaultHandler(req);
}
```

Reference it in your project config: `"plugin": "./plugins/my-project.ts"`.

Plugin paths must resolve inside `configDir` (enforced at load time).

Node loads the module as is, with its types stripped. So a plugin may be
TypeScript, but only syntax that erases cleanly: no `enum`, `namespace` or
constructor parameter properties. It can import other files by relative path and
Node built-ins (`node:fs`, …); a bare package import resolves from the plugin's
own directory, so it needs a `node_modules` there or above it.

## Token rotation (zero downtime)

Put multiple tokens in the project config:

```json
{ "uploadTokens": ["old-token", "new-token"] }
```

Update your app to use the new token, then remove the old one and restart (or call `clearConfigCache(configDir)` if embedding the handler).

## Docker

Each release has an image on the GitHub Container Registry,
`ghcr.io/marianmeres/static-upload-server:<tag>` (e.g. `:v2.1.0`; there is no `latest`).
A GitHub Actions workflow builds it when a `vX.Y.Z` tag is pushed, after the test suite
passes and the image itself has started and reported its version.

### Deploying on a host

In a clone of this repository on the host, with a `.env` beside `docker-compose.yml`
(see [.env.example](.env.example)):

```bash
bash deploy.sh            # the latest release
bash deploy.sh v2.1.0     # a given one; also how to roll back
```

The script checks out the tag, pulls its image, replaces the container, waits until it
reports healthy and checks that the server answers with the tag's version. Nothing is
built on the host. If the pull fails, the running release keeps serving.

`deploy.sh` writes the deployed tag into `.env` as `APP_IMAGE_TAG`, so a plain
`docker compose up -d` (after editing `.env`, say) keeps running that release.

If the image package on GitHub is private, the host needs
`docker login ghcr.io -u <github-user>` once, with a token that has `read:packages`. A
public package needs no login.

### Volumes and file ownership

The compose file mounts `./data` for static files and `./config` for project configs.

The container runs as a non-root user. Set `PUID` and `PGID` in your `.env` file to
match your host user so that uploaded files have correct ownership:

```bash
# Find your UID/GID
id -u  # e.g. 1000
id -g  # e.g. 1000
```

```env
PUID=1000
PGID=1000
```

If not set, defaults to `1000:1000`.

### Building the image locally

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml build
docker compose up -d
```

The local image is tagged `dev`, so it is never mistaken for a release.

## License

[MIT](LICENSE)
