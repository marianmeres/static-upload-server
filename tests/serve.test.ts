import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { clearConfigCache } from "../src/server.ts";
import {
	BASE,
	cleanup,
	createHandler,
	makeTempDir,
	makeUploadRequest,
	setup,
} from "./_helpers.ts";

// ─── Static serving ─────────────────────────────────────────────────

test("static: GET uploaded file returns correct content", async () => {
	const { staticDir, configDir } = await setup("proj");
	try {
		const handler = await createHandler({ staticDir, configDir });

		const uploadReq = makeUploadRequest("proj", [
			{ name: "hello.txt", content: "world" },
		]);
		await handler(uploadReq);

		const getReq = new Request(`${BASE}/proj/hello.txt`);
		const res = await handler(getReq);
		assert.deepStrictEqual(res.status, 200);
		const text = await res.text();
		assert.deepStrictEqual(text, "world");
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("static: GET non-existent file returns 404", async () => {
	const { staticDir, configDir } = await setup("proj");
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = new Request(`${BASE}/proj/nope.txt`);
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 404);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

// ─── Route matching ─────────────────────────────────────────────────

test("route: invalid projectId returns 404", async () => {
	const staticDir = await makeTempDir();
	const configDir = await makeTempDir();
	clearConfigCache();
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = new Request(`${BASE}/bad%20project!`);
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 404);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("route: HEAD request is handled", async () => {
	const { staticDir, configDir } = await setup("proj");
	try {
		const handler = await createHandler({ staticDir, configDir });

		const uploadReq = makeUploadRequest("proj", [
			{ name: "test.txt", content: "data" },
		]);
		await handler(uploadReq);

		const req = new Request(`${BASE}/proj/test.txt`, {
			method: "HEAD",
		});
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 200);
		const body = await res.text();
		assert.deepStrictEqual(body, "");
	} finally {
		await cleanup(staticDir, configDir);
	}
});

// ─── Upload form ────────────────────────────────────────────────────

test("form: GET /:projectId returns HTML form", async () => {
	const { staticDir, configDir } = await setup("proj", {
		uploadTokens: [],
		enableUploadForm: true,
	});
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = new Request(`${BASE}/proj`);
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 200);
		const ct = res.headers.get("content-type");
		assert.deepStrictEqual(ct, "text/html; charset=utf-8");
		const html = await res.text();
		assert.deepStrictEqual(html.includes("proj"), true);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("form: disabled upload form returns 404", async () => {
	const { staticDir, configDir } = await setup("proj", {
		uploadTokens: [],
		enableUploadForm: false,
	});
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = new Request(`${BASE}/proj`);
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 404);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

// ─── Root-level files ───────────────────────────────────────────────

test("root-level: GET /favicon.ico serves from staticDir root", async () => {
	const staticDir = await makeTempDir();
	const configDir = await makeTempDir();
	clearConfigCache();
	await writeFile(join(staticDir, "favicon.ico"), "icon-data");
	try {
		const handler = await createHandler({
			staticDir,
			configDir,
			rootFiles: ["favicon.ico"],
		});
		const req = new Request(`${BASE}/favicon.ico`);
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 200);
		const text = await res.text();
		assert.deepStrictEqual(text, "icon-data");
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("root-level: GET /robots.txt returns 404 if not exists", async () => {
	const staticDir = await makeTempDir();
	const configDir = await makeTempDir();
	clearConfigCache();
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = new Request(`${BASE}/robots.txt`);
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 404);
		await res.body?.cancel();
	} finally {
		await cleanup(staticDir, configDir);
	}
});
