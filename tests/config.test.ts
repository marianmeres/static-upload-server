import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { clearConfigCache } from "../src/server.ts";
import { BASE, cleanup, createHandler, jsonOf, makeTempDir, setup } from "./_helpers.ts";

// ─── Version endpoint ───────────────────────────────────────────────

test("version: GET / returns version only", async () => {
	const { staticDir, configDir } = await setup("proj");
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = new Request(`${BASE}/`);
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 200);
		const body = await jsonOf(res);
		assert.deepStrictEqual(typeof body.version, "string");
		assert.deepStrictEqual(body.name, undefined);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

// ─── Project config ─────────────────────────────────────────────────

test("config: missing project config returns 404", async () => {
	const staticDir = await makeTempDir();
	const configDir = await makeTempDir();
	clearConfigCache();
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = new Request(`${BASE}/nonexistent`);
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 404);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("config: invalid project config returns 500", async () => {
	const staticDir = await makeTempDir();
	const configDir = await makeTempDir();
	clearConfigCache();
	await writeFile(join(configDir, "bad.json"), "not json");
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = new Request(`${BASE}/bad`);
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 500);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("config: invalid cacheStrategy scalar returns 500", async () => {
	const staticDir = await makeTempDir();
	const configDir = await makeTempDir();
	clearConfigCache();
	await writeFile(
		join(configDir, "bad.json"),
		JSON.stringify({ uploadTokens: [], cacheStrategy: "forever" }),
	);
	try {
		const handler = await createHandler({ staticDir, configDir });
		const res = await handler(new Request(`${BASE}/bad`));
		assert.deepStrictEqual(res.status, 500);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("config: invalid cacheStrategy map value returns 500", async () => {
	const staticDir = await makeTempDir();
	const configDir = await makeTempDir();
	clearConfigCache();
	await writeFile(
		join(configDir, "bad.json"),
		JSON.stringify({
			uploadTokens: [],
			cacheStrategy: { "/img/": "forever" },
		}),
	);
	try {
		const handler = await createHandler({ staticDir, configDir });
		const res = await handler(new Request(`${BASE}/bad`));
		assert.deepStrictEqual(res.status, 500);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("config: cacheStrategy array (not object) returns 500", async () => {
	const staticDir = await makeTempDir();
	const configDir = await makeTempDir();
	clearConfigCache();
	await writeFile(
		join(configDir, "bad.json"),
		JSON.stringify({ uploadTokens: [], cacheStrategy: ["mutable"] }),
	);
	try {
		const handler = await createHandler({ staticDir, configDir });
		const res = await handler(new Request(`${BASE}/bad`));
		assert.deepStrictEqual(res.status, 500);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("config: missing uploadTokens returns 500", async () => {
	const staticDir = await makeTempDir();
	const configDir = await makeTempDir();
	clearConfigCache();
	await writeFile(join(configDir, "notoken.json"), JSON.stringify({ foo: "bar" }));
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = new Request(`${BASE}/notoken`);
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 500);
	} finally {
		await cleanup(staticDir, configDir);
	}
});
