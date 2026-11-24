#!/usr/bin/env node

/**
 * CLI entry point for the static upload server (the package's `bin`).
 *
 * Reads configuration from environment variables and starts the server.
 * Run it from a checkout with `node src/cli.ts`.
 */

import process from "node:process";
import { createServer } from "./server.ts";

const env = process.env;
const options: Record<string, unknown> = {};

// `PORT=0` asks the OS for a free port; the startup banner prints the one bound.
const port = env.PORT;
if (port !== undefined && port !== "") {
	const n = Number(port);
	if (Number.isInteger(n) && n >= 0) options.port = n;
}

const staticDir = env.STATIC_DIR;
if (staticDir) options.staticDir = staticDir;

const configDir = env.CONFIG_DIR;
if (configDir) options.configDir = configDir;

if (env.ENABLE_UPLOAD_FORM === "false") {
	options.enableUploadForm = false;
}

const jwtSecret = env.JWT_SECRET;
if (jwtSecret) options.jwtSecret = jwtSecret;

const globalToken = env.GLOBAL_TOKEN;
if (globalToken) options.globalToken = globalToken;

const rootFiles = env.ROOT_FILES;
if (rootFiles) {
	options.rootFiles = rootFiles
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

if (env.LOG === "true" || env.LOG === "1") {
	options.logger = true;
}

const tmpSweep = env.TMP_SWEEP_MAX_AGE_MS;
if (tmpSweep !== undefined && tmpSweep !== "") {
	const n = Number(tmpSweep);
	if (Number.isFinite(n) && n >= 0) options.tmpSweepMaxAgeMs = n;
}

// Server-level fallback upload byte cap (0 = unlimited)
const maxUploadSize = env.MAX_UPLOAD_SIZE;
if (maxUploadSize !== undefined && maxUploadSize !== "") {
	const n = Number(maxUploadSize);
	if (Number.isFinite(n) && n >= 0) options.maxUploadSize = n;
}

// Abort uploads with no body chunk within this many ms (0 = disabled)
const uploadIdleTimeout = env.UPLOAD_IDLE_TIMEOUT_MS;
if (uploadIdleTimeout !== undefined && uploadIdleTimeout !== "") {
	const n = Number(uploadIdleTimeout);
	if (Number.isFinite(n) && n >= 0) options.uploadIdleTimeoutMs = n;
}

// CDN integration (optional)
const cdnProvider = env.CDN_PROVIDER;
if (cdnProvider) {
	const cdn: Record<string, unknown> = { provider: cdnProvider };

	const purgeUrlPrefix = env.CDN_CACHE_PURGE_URL_PREFIX;
	if (purgeUrlPrefix) cdn.purgeUrlPrefix = purgeUrlPrefix;

	const cacheMaxAge = Number(env.CDN_CACHE_MAX_AGE);
	if (cacheMaxAge > 0) cdn.cacheMaxAge = cacheMaxAge;

	const cacheSMaxAge = Number(env.CDN_CACHE_S_MAXAGE);
	if (cacheSMaxAge > 0) cdn.cacheSMaxAge = cacheSMaxAge;

	const staleWhileRevalidate = Number(env.CDN_STALE_WHILE_REVALIDATE);
	if (staleWhileRevalidate > 0) {
		cdn.staleWhileRevalidate = staleWhileRevalidate;
	}

	// Provider-specific env vars
	const cfZoneId = env.CF_ZONE_ID;
	if (cfZoneId) cdn.zoneId = cfZoneId;

	const cfApiToken = env.CF_API_TOKEN;
	if (cfApiToken) cdn.apiToken = cfApiToken;

	options.cdn = cdn;
}

const server = await createServer(options);
const listening = await server.start();

// Stop on a signal: no new connections, requests in flight get a moment to
// finish. Not optional in a container, where this process is PID 1 and the
// kernel applies no default action to its signals: without a handler a
// `docker stop` would wait out its grace period and then kill it.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, () => {
		listening.shutdown().finally(() => process.exit(0));
	});
}
