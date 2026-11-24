import assert from "node:assert/strict";
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

// ─── Upload ──────────────────────────────────────────────────────────

test("upload: valid file is stored on disk", async () => {
	const { staticDir, configDir } = await setup("myapp");
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = makeUploadRequest("myapp", [
			{ name: "image.webp", content: "fake-image-data" },
		]);
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 200);

		const body = await jsonOf(res);
		assert.deepStrictEqual(body.uploaded, ["/myapp/image.webp"]);

		const stored = await readTextFile(join(staticDir, "myapp", "image.webp"));
		assert.deepStrictEqual(stored, "fake-image-data");
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("upload: preserves subdirectory structure", async () => {
	const { staticDir, configDir } = await setup("myapp");
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = makeUploadRequest("myapp", [
			{ name: "images/thumbs/photo.webp", content: "data" },
		]);
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 200);

		const body = await jsonOf(res);
		assert.deepStrictEqual(body.uploaded, ["/myapp/images/thumbs/photo.webp"]);

		const stored = await readTextFile(
			join(staticDir, "myapp", "images", "thumbs", "photo.webp"),
		);
		assert.deepStrictEqual(stored, "data");
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("upload: no files in form data returns 400", async () => {
	const { staticDir, configDir } = await setup("proj");
	try {
		const handler = await createHandler({ staticDir, configDir });
		const formData = new FormData();
		formData.append("text-field", "not a file");
		const req = new Request(`${BASE}/proj`, {
			method: "POST",
			body: formData,
		});
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 400);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("upload: all-files-write-failed returns 500, not 400", async () => {
	const { staticDir, configDir } = await setup("proj");
	try {
		const handler = await createHandler({ staticDir, configDir });
		// store a plain file "a" …
		const first = await handler(
			makeUploadRequest("proj", [{ name: "a", content: "f" }]),
		);
		assert.deepStrictEqual(first.status, 200);
		// … then upload "a/b": mkdir hits the file, a server-side write
		// failure — must surface as 5xx with a structured envelope
		const res = await handler(
			makeUploadRequest("proj", [{ name: "a/b", content: "x" }]),
		);
		assert.deepStrictEqual(res.status, 500);
		const body = await jsonOf(res);
		assert.deepStrictEqual(body.uploaded, []);
		assert.deepStrictEqual(body.rejected[0].reason, "write failed");
	} finally {
		await cleanup(staticDir, configDir);
	}
});

// ─── Path traversal ─────────────────────────────────────────────────

test("path traversal: .. segments are stripped", async () => {
	const { staticDir, configDir } = await setup("proj");
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = makeUploadRequest("proj", [
			{ name: "../../etc/passwd", content: "pwned" },
		]);
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 200);

		const body = await jsonOf(res);
		assert.deepStrictEqual(body.uploaded, ["/proj/etc/passwd"]);

		const stored = await readTextFile(join(staticDir, "proj", "etc", "passwd"));
		assert.deepStrictEqual(stored, "pwned");
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("path traversal: dot segments are stripped", async () => {
	const { staticDir, configDir } = await setup("proj");
	try {
		const handler = await createHandler({ staticDir, configDir });
		const req = makeUploadRequest("proj", [
			{ name: "./foo/./bar.txt", content: "ok" },
		]);
		const res = await handler(req);
		assert.deepStrictEqual(res.status, 200);

		const body = await jsonOf(res);
		assert.deepStrictEqual(body.uploaded, ["/proj/foo/bar.txt"]);
	} finally {
		await cleanup(staticDir, configDir);
	}
});
