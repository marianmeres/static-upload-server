import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BASE, cleanup, createHandler, makeUploadRequest, setup } from "./_helpers.ts";

/**
 * Write a file directly into the project's static dir (bypassing the upload
 * handler). Used by serve-side tests with a configured CDN adapter, where
 * routing uploads through `handleUpload` would fire `cdn.purgeCache(...)` and
 * leak an unawaited HTTP fetch to the real Cloudflare API.
 */
async function placeFile(
	staticDir: string,
	projectId: string,
	relPath: string,
	content: string,
): Promise<void> {
	const full = join(staticDir, projectId, relPath);
	await mkdir(join(full, ".."), { recursive: true });
	await writeFile(full, content);
}

// ─── CDN adapter integration ────────────────────────────────────────

test("cdn: no cache headers when CDN not configured", async () => {
	const { staticDir, configDir } = await setup("proj");
	try {
		const handler = await createHandler({ staticDir, configDir });
		const uploadReq = makeUploadRequest("proj", [
			{ name: "file.txt", content: "data" },
		]);
		await (await handler(uploadReq)).body?.cancel();

		const res = await handler(new Request(`${BASE}/proj/file.txt`));
		assert.deepStrictEqual(res.status, 200);
		const cc = res.headers.get("Cache-Control");
		assert.deepStrictEqual(cc, null);
		await res.body?.cancel();
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("cdn: createCdnAdapter returns undefined when not configured", async () => {
	const { createCdnAdapter } = await import("../src/cdn.ts");

	assert.deepStrictEqual(await createCdnAdapter(), undefined);
	assert.deepStrictEqual(await createCdnAdapter({}), undefined);
	assert.deepStrictEqual(await createCdnAdapter({ provider: "cloudflare" }), undefined);
	assert.deepStrictEqual(
		await createCdnAdapter({ purgeUrlPrefix: "https://x.com" }),
		undefined,
	);
});

test("cdn: createCdnAdapter throws on unknown provider", async () => {
	const { createCdnAdapter } = await import("../src/cdn.ts");

	let threw = false;
	try {
		await createCdnAdapter({
			provider: "unknown",
			purgeUrlPrefix: "https://x.com",
		});
	} catch (e) {
		threw = true;
		assert.deepStrictEqual(
			(e as Error).message.includes("Unknown CDN provider"),
			true,
		);
	}
	assert.deepStrictEqual(threw, true);
});

test("cdn: cloudflare adapter applyCacheHeaders", async () => {
	const { CloudflareCdnAdapter } = await import("../src/cdn/cloudflare.ts");

	const adapter = new CloudflareCdnAdapter({
		zoneId: "zone123",
		apiToken: "token456",
		purgeUrlPrefix: "https://cdn.example.com",
		cacheMaxAge: 60,
		cacheSMaxAge: 120,
		staleWhileRevalidate: 300,
	});

	// 200 response gets headers
	const res200 = new Response("ok", { status: 200 });
	const modified = adapter.applyCacheHeaders(res200);
	assert.deepStrictEqual(
		modified.headers.get("Cache-Control"),
		"public, max-age=60, s-maxage=120, stale-while-revalidate=300",
	);

	// immutable flag uses long-lived headers
	const res200b = new Response("ok", { status: 200 });
	const immutable = adapter.applyCacheHeaders(res200b, true);
	assert.deepStrictEqual(
		immutable.headers.get("Cache-Control"),
		"public, max-age=31536000, immutable",
	);

	// 404 response is not modified
	const res404 = new Response("not found", { status: 404 });
	const unmodified = adapter.applyCacheHeaders(res404);
	assert.deepStrictEqual(unmodified.headers.get("Cache-Control"), null);
});

// ─── cacheStrategy end-to-end through handleServe ────────────────────

const CF_CDN = {
	provider: "cloudflare",
	zoneId: "zone123",
	apiToken: "token456",
	purgeUrlPrefix: "https://cdn.example.com",
	cacheMaxAge: 60,
	cacheSMaxAge: 120,
	staleWhileRevalidate: 300,
} as const;
const MUTABLE_CC = "public, max-age=60, s-maxage=120, stale-while-revalidate=300";
const IMMUTABLE_CC = "public, max-age=31536000, immutable";

test("cacheStrategy: scalar 'immutable' applies to every file", async () => {
	const { staticDir, configDir } = await setup("proj", {
		uploadTokens: [],
		cacheStrategy: "immutable",
	});
	try {
		await placeFile(staticDir, "proj", "img/a.jpg", "x");
		await placeFile(staticDir, "proj", "avatars/b.png", "y");
		const handler = await createHandler({ staticDir, configDir, cdn: CF_CDN });

		const a = await handler(new Request(`${BASE}/proj/img/a.jpg`));
		const b = await handler(new Request(`${BASE}/proj/avatars/b.png`));
		assert.deepStrictEqual(a.headers.get("Cache-Control"), IMMUTABLE_CC);
		assert.deepStrictEqual(b.headers.get("Cache-Control"), IMMUTABLE_CC);
		await a.body?.cancel();
		await b.body?.cancel();
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("cacheStrategy: map form picks per request path", async () => {
	const { staticDir, configDir } = await setup("proj", {
		uploadTokens: [],
		cacheStrategy: { "/img/": "immutable", "*": "mutable" },
	});
	try {
		await placeFile(staticDir, "proj", "img/a.jpg", "x");
		await placeFile(staticDir, "proj", "avatars/b.png", "y");
		const handler = await createHandler({ staticDir, configDir, cdn: CF_CDN });

		const a = await handler(new Request(`${BASE}/proj/img/a.jpg`));
		const b = await handler(new Request(`${BASE}/proj/avatars/b.png`));
		assert.deepStrictEqual(a.headers.get("Cache-Control"), IMMUTABLE_CC);
		assert.deepStrictEqual(b.headers.get("Cache-Control"), MUTABLE_CC);
		await a.body?.cancel();
		await b.body?.cancel();
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("cacheStrategy: map form longest-prefix wins", async () => {
	const { staticDir, configDir } = await setup("proj", {
		uploadTokens: [],
		cacheStrategy: {
			"/img/": "mutable",
			"/img/hashed/": "immutable",
		},
	});
	try {
		await placeFile(staticDir, "proj", "img/loose.jpg", "x");
		await placeFile(staticDir, "proj", "img/hashed/abc.jpg", "y");
		const handler = await createHandler({ staticDir, configDir, cdn: CF_CDN });

		const loose = await handler(new Request(`${BASE}/proj/img/loose.jpg`));
		const hashed = await handler(new Request(`${BASE}/proj/img/hashed/abc.jpg`));
		assert.deepStrictEqual(loose.headers.get("Cache-Control"), MUTABLE_CC);
		assert.deepStrictEqual(hashed.headers.get("Cache-Control"), IMMUTABLE_CC);
		await loose.body?.cancel();
		await hashed.body?.cancel();
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("cacheStrategy: map form honoured on HEAD requests too", async () => {
	const { staticDir, configDir } = await setup("proj", {
		uploadTokens: [],
		cacheStrategy: { "/img/": "immutable", "*": "mutable" },
	});
	try {
		await placeFile(staticDir, "proj", "img/a.jpg", "x");
		await placeFile(staticDir, "proj", "avatars/b.png", "y");
		const handler = await createHandler({ staticDir, configDir, cdn: CF_CDN });

		const a = await handler(
			new Request(`${BASE}/proj/img/a.jpg`, { method: "HEAD" }),
		);
		const b = await handler(
			new Request(`${BASE}/proj/avatars/b.png`, { method: "HEAD" }),
		);
		assert.deepStrictEqual(a.headers.get("Cache-Control"), IMMUTABLE_CC);
		assert.deepStrictEqual(b.headers.get("Cache-Control"), MUTABLE_CC);
		assert.deepStrictEqual(a.body, null);
		assert.deepStrictEqual(b.body, null);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("cdn: cloudflare adapter constructor validation", async () => {
	const { CloudflareCdnAdapter } = await import("../src/cdn/cloudflare.ts");

	let threw = false;
	try {
		new CloudflareCdnAdapter({
			zoneId: "",
			apiToken: "token",
			purgeUrlPrefix: "https://x.com",
			cacheMaxAge: 60,
			cacheSMaxAge: 120,
			staleWhileRevalidate: 300,
		});
	} catch {
		threw = true;
	}
	assert.deepStrictEqual(threw, true);
});
