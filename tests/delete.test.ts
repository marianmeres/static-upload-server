import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
	BASE,
	cleanup,
	createHandler,
	jsonOf,
	makeUploadRequest,
	readTextFile,
	setup,
} from "./_helpers.ts";

// ─── Delete ─────────────────────────────────────────────────────────

test("delete: no tokens configured returns 404", async () => {
	const { staticDir, configDir } = await setup("proj", {
		uploadTokens: [],
	});
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = new Request(`${BASE}/proj/file.txt`, {
			method: "DELETE",
		});
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 404);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("delete: missing auth header returns 401", async () => {
	const { staticDir, configDir } = await setup("proj", {
		uploadTokens: ["secret"],
	});
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = new Request(`${BASE}/proj/file.txt`, {
			method: "DELETE",
		});
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 401);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("delete: wrong token returns 401", async () => {
	const { staticDir, configDir } = await setup("proj", {
		uploadTokens: ["secret"],
	});
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = new Request(`${BASE}/proj/file.txt`, {
			method: "DELETE",
			headers: { Authorization: "Bearer wrong" },
		});
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 401);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("delete: existing file is removed", async () => {
	const { staticDir, configDir } = await setup("proj", {
		uploadTokens: ["secret"],
	});
	try {
		const handler = await createHandler({ staticDir, configDir });

		// Upload a file first
		const uploadReq = makeUploadRequest(
			"proj",
			[{ name: "hello.txt", content: "world" }],
			"secret",
		);
		await handler(uploadReq);

		// Verify it exists
		const content = await readTextFile(join(staticDir, "proj", "hello.txt"));
		assert.deepStrictEqual(content, "world");

		// Delete it
		const deleteReq = new Request(`${BASE}/proj/hello.txt`, {
			method: "DELETE",
			headers: { Authorization: "Bearer secret" },
		});
		const res = await handler(deleteReq);
		assert.deepStrictEqual(res.status, 200);

		const body = await jsonOf(res);
		assert.deepStrictEqual(body.deleted, "/proj/hello.txt");

		// Verify it's gone
		let exists = true;
		try {
			await stat(join(staticDir, "proj", "hello.txt"));
		} catch {
			exists = false;
		}
		assert.deepStrictEqual(exists, false);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("delete: non-existent file returns 404", async () => {
	const { staticDir, configDir } = await setup("proj", {
		uploadTokens: ["secret"],
	});
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = new Request(`${BASE}/proj/nope.txt`, {
			method: "DELETE",
			headers: { Authorization: "Bearer secret" },
		});
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 404);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("delete: a directory is refused with 400 and left in place", async () => {
	const { staticDir, configDir } = await setup("proj", {
		uploadTokens: ["secret"],
	});
	try {
		const handler = await createHandler({ staticDir, configDir });
		await handler(
			makeUploadRequest(
				"proj",
				[{ name: "dir/hello.txt", content: "world" }],
				"secret",
			),
		);

		const res = await handler(
			new Request(`${BASE}/proj/dir`, {
				method: "DELETE",
				headers: { Authorization: "Bearer secret" },
			}),
		);
		assert.deepStrictEqual(res.status, 400);
		assert.deepStrictEqual(await res.text(), "Not a file");
		assert.deepStrictEqual(
			await readTextFile(join(staticDir, "proj", "dir", "hello.txt")),
			"world",
		);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("delete: path traversal is prevented", async () => {
	const { staticDir, configDir } = await setup("proj", {
		uploadTokens: ["secret"],
	});
	try {
		const handler = await createHandler({ staticDir, configDir });

		// Upload a file first
		const uploadReq = makeUploadRequest(
			"proj",
			[{ name: "safe.txt", content: "data" }],
			"secret",
		);
		await handler(uploadReq);

		// Try to delete with traversal
		const req = new Request(`${BASE}/proj/../../etc/passwd`, {
			method: "DELETE",
			headers: { Authorization: "Bearer secret" },
		});
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 404);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("delete: missing file path returns 404", async () => {
	const { staticDir, configDir } = await setup("proj", {
		uploadTokens: ["secret"],
	});
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = new Request(`${BASE}/proj`, {
			method: "DELETE",
			headers: { Authorization: "Bearer secret" },
		});
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 404);
	} finally {
		await cleanup(staticDir, configDir);
	}
});
