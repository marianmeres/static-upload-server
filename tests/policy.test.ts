import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BASE,
	cleanup,
	createHandler,
	jsonOf,
	makeUploadRequest,
	setup,
} from "./_helpers.ts";

// ─── maxFileSize ────────────────────────────────────────────────────

test("policy: maxFileSize rejects oversized file with 413", async () => {
	const { staticDir, configDir } = await setup("p", {
		uploadTokens: [],
		maxFileSize: 5,
	});
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = makeUploadRequest("p", [
			{ name: "big.txt", content: "abcdefghij" }, // 10 bytes > 5
		]);
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 413);
		const body = await jsonOf(res);
		assert.deepStrictEqual(body.uploaded, []);
		assert.deepStrictEqual(body.rejected.length, 1);
		assert.deepStrictEqual(body.rejected[0].name, "big.txt");
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("policy: maxFileSize permits files at or under limit", async () => {
	const { staticDir, configDir } = await setup("p", {
		uploadTokens: [],
		maxFileSize: 10,
	});
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = makeUploadRequest("p", [
			{ name: "ok.txt", content: "exactly10!" }, // 10 bytes
		]);
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 200);
		const body = await jsonOf(res);
		assert.deepStrictEqual(body.uploaded, ["/p/ok.txt"]);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

// ─── allowedExtensions ─────────────────────────────────────────────

test("policy: allowedExtensions rejects disallowed extension", async () => {
	const { staticDir, configDir } = await setup("p", {
		uploadTokens: [],
		allowedExtensions: ["png", "jpg"],
	});
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = makeUploadRequest("p", [
			{ name: "evil.html", content: "<script>alert(1)</script>" },
		]);
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 400);
		const body = await jsonOf(res);
		assert.deepStrictEqual(body.uploaded, []);
		assert.deepStrictEqual(body.rejected[0].reason.includes("extension"), true);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("policy: allowedExtensions accepts case-insensitive match", async () => {
	const { staticDir, configDir } = await setup("p", {
		uploadTokens: [],
		allowedExtensions: ["png"],
	});
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = makeUploadRequest("p", [{ name: "photo.PNG", content: "data" }]);
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 200);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

// ─── allowedMimeTypes ───────────────────────────────────────────────

test("policy: allowedMimeTypes wildcard accepts type/*", async () => {
	const { staticDir, configDir } = await setup("p", {
		uploadTokens: [],
		allowedMimeTypes: ["image/*"],
	});
	try {
		const handler = await createHandler({ staticDir, configDir });
		const formData = new FormData();
		formData.append("file", new File(["bytes"], "a.png", { type: "image/png" }));
		const req = new Request(`${BASE}/p`, { method: "POST", body: formData });
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 200);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("policy: allowedMimeTypes rejects mismatch", async () => {
	const { staticDir, configDir } = await setup("p", {
		uploadTokens: [],
		allowedMimeTypes: ["image/*"],
	});
	try {
		const handler = await createHandler({ staticDir, configDir });
		const formData = new FormData();
		formData.append("file", new File(["bytes"], "a.txt", { type: "text/plain" }));
		const req = new Request(`${BASE}/p`, { method: "POST", body: formData });
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 400);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

// ─── Partial failure reporting ──────────────────────────────────────

test("upload: partial success includes rejected items", async () => {
	const { staticDir, configDir } = await setup("p", {
		uploadTokens: [],
		maxFileSize: 5,
	});
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = makeUploadRequest("p", [
			{ name: "ok.txt", content: "ok" }, // 2 bytes
			{ name: "too-big.txt", content: "too-big-content" }, // >5
		]);
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 200);
		const body = await jsonOf(res);
		assert.deepStrictEqual(body.uploaded, ["/p/ok.txt"]);
		assert.deepStrictEqual(body.rejected.length, 1);
		assert.deepStrictEqual(body.rejected[0].name, "too-big.txt");
	} finally {
		await cleanup(staticDir, configDir);
	}
});
