import { serveStatic } from "@marianmeres/demino";
import { extractBearerToken, isAuthorized, timingSafeEqualStr } from "../auth.ts";
import { resolveCacheStrategy } from "../cache-strategy.ts";
import type { CdnAdapter } from "../cdn.ts";
import type { ProjectConfig } from "../config.ts";
import { contentTypeOf } from "../content-type.ts";
import { verifyJwt } from "../jwt.ts";
import type { Logger } from "../logger.ts";

interface ServeDeps {
	jwtSecret?: string;
	globalToken?: string;
	cdn?: CdnAdapter;
	logger: Logger;
}

function isProtected(config: ProjectConfig): boolean {
	return (
		(config.downloadTokens?.length ?? 0) > 0 ||
		config.getAccessControl === "token" ||
		config.getAccessControl === "jwt"
	);
}

/** Request headers a cross-origin page may send with a GET of public content. */
const CORS_ALLOW_HEADERS = "Origin, X-Requested-With, Content-Type, Accept, Range";

function addResponseHeaders(
	res: Response,
	opts: { cors: boolean; forceDownload?: boolean },
): Response {
	const headers = new Headers(res.headers);
	// Prevent MIME sniffing — user-uploaded content must not be reinterpreted.
	headers.set("X-Content-Type-Options", "nosniff");
	if (opts.forceDownload && !headers.has("Content-Disposition")) {
		headers.set("Content-Disposition", "attachment");
	}
	// On every answer but a redirect (the redirect's target gets them).
	if (opts.cors && res.status !== 301) {
		headers.set("Access-Control-Allow-Origin", "*");
		headers.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
	}
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers,
	});
}

/**
 * Handle GET/HEAD /:projectId/path/to/file — serve static files.
 *
 * `filePath` is the project-relative path (no leading `/`, no `:projectId`
 * segment). For root-file mounts (favicon.ico, robots.txt, …) it's just the
 * filename. Used both as the cache-strategy lookup key and (implicitly via
 * `req.url`) by `serveStatic` for the filesystem lookup.
 */
export async function handleServe(
	req: Request,
	filePath: string,
	config: ProjectConfig,
	staticDir: string,
	deps: ServeDeps,
): Promise<Response> {
	const { jwtSecret, globalToken, cdn, logger } = deps;

	// Download tokens check (takes precedence over getAccessControl)
	const downloadTokens = config.downloadTokens ?? [];
	if (downloadTokens.length > 0) {
		if (!isAuthorized(req, downloadTokens, globalToken)) {
			logger.warn("serve.unauthorized", { reason: "downloadTokens" });
			return new Response("Unauthorized", { status: 401 });
		}
	} else if (config.getAccessControl === "token") {
		if (!isAuthorized(req, config.uploadTokens, globalToken)) {
			logger.warn("serve.unauthorized", { reason: "token" });
			return new Response("Unauthorized", { status: 401 });
		}
	} else if (config.getAccessControl === "jwt") {
		// Global token bypasses JWT check
		const bearer = extractBearerToken(req);
		if (globalToken && bearer && timingSafeEqualStr(bearer, globalToken)) {
			// authorized via global token
		} else {
			if (!bearer) {
				logger.warn("serve.unauthorized", { reason: "jwt_missing" });
				return new Response("Unauthorized", { status: 401 });
			}
			const secret = config.jwt?.secret ?? jwtSecret;
			if (!secret) {
				logger.error("serve.jwt_not_configured");
				return new Response("JWT not configured", { status: 500 });
			}
			const payload = await verifyJwt(bearer, secret);
			if (!payload) {
				logger.warn("serve.unauthorized", { reason: "jwt_invalid" });
				return new Response("Unauthorized", { status: 401 });
			}
		}
	}

	// CORS: only advertise on public content. Protected content should not be
	// fetchable cross-origin without an explicit server-side opt-in.
	const enableCors = !isProtected(config);

	// `serveStatic` handles HEAD itself — the same headers (Content-Length,
	// ETag, Last-Modified, …) with no body, and the file is never opened. Pass
	// the request through as-is. Range requests, conditional requests and the
	// directory/dotfile rules are its job too.
	let res = await serveStatic(req, {
		fsRoot: staticDir,
		// The full MIME table (the one the PUT policy check derives from); an
		// unknown extension keeps serveStatic's `application/octet-stream`.
		headers: (_req: Request, path: string) => {
			const type = contentTypeOf(path);
			return type ? { "content-type": type } : undefined;
		},
	});

	// Apply hardening and CORS headers before anything else copies them.
	res = addResponseHeaders(res, {
		cors: enableCors,
		forceDownload: config.forceDownload,
	});

	const strategy = resolveCacheStrategy(config.cacheStrategy, "/" + filePath);
	return cdn ? cdn.applyCacheHeaders(res, strategy === "immutable") : res;
}
