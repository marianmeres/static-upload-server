// Over-the-wire tests: the server is started with `start()` on an OS-assigned port
// and spoken to through real sockets. Everything else in this suite calls
// `handler(req)` directly, which never touches the HTTP layer underneath: request
// bodies arriving in pieces, a client that stops or leaves mid-upload, an upload
// refused before it was read.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { opendir, readFile } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { StaticServerOptions } from "../src/server.ts";
import { createServer } from "../src/server.ts";
import { cleanup, jsonOf, setup } from "./_helpers.ts";

const MB = 1024 * 1024;

/** Start the real server for project "proj"; it is shut down when the test ends. */
async function listen(
	t: TestContext,
	config: Record<string, unknown> = { uploadTokens: [] },
	opts: StaticServerOptions = {},
) {
	const { staticDir, configDir } = await setup("proj", config);
	const { start, version } = await createServer({
		...opts,
		staticDir,
		configDir,
		port: 0,
	});
	const banner = t.mock.method(console, "log", () => {});
	const server = await start();
	banner.mock.restore();
	t.after(async () => {
		// A connection whose upload was refused unread is closed by the server
		// only when its keep-alive timeout runs out, and a graceful shutdown
		// waits for it. The test does not: the listener is closed at once, the
		// stragglers go within seconds.
		await Promise.race([server.shutdown(), sleep(100)]);
		await cleanup(staticDir, configDir);
	});
	return {
		staticDir,
		version,
		port: server.port,
		origin: `http://127.0.0.1:${server.port}`,
	};
}

/** All files (recursively) under dir. [] if dir is missing. */
async function listFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	try {
		for await (const entry of await opendir(dir)) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) out.push(...(await listFiles(full)));
			else out.push(full);
		}
	} catch {
		// missing dir
	}
	return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `check()` holds, or fail after `timeoutMs`. */
async function until(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) assert.fail("condition not met in time");
		await sleep(20);
	}
}

/**
 * Open a raw connection, send `head` (request line + headers + any first body
 * bytes) and collect whatever the server writes back. The caller ends it.
 */
function rawRequest(port: number, head: string) {
	const socket = connect(port, "127.0.0.1");
	let received = "";
	socket.on("data", (chunk: Buffer) => {
		received += chunk.toString();
	});
	socket.on("error", () => {});
	socket.write(head);
	return {
		socket,
		/** Resolves with the status line once the server has answered. */
		async statusLine(timeoutMs = 3000): Promise<string> {
			await until(async () => received.includes("\r\n"), timeoutMs);
			return received.slice(0, received.indexOf("\r\n"));
		},
	};
}

// ─── Listening ──────────────────────────────────────────────────────

test("wire: start() binds a free port and answers with the version", async (t) => {
	const { origin, version, port } = await listen(t);
	assert.ok(port > 0);

	const res = await fetch(`${origin}/`);
	assert.deepStrictEqual(res.status, 200);
	assert.deepStrictEqual(await jsonOf(res), { version });
	assert.match(version, /^\d+\.\d+\.\d+/);

	const head = await fetch(`${origin}/`, { method: "HEAD" });
	assert.deepStrictEqual(head.status, 200);
	assert.deepStrictEqual(await head.text(), "");
});

// ─── Uploads ────────────────────────────────────────────────────────

test("wire: PUT with Content-Length streams to disk intact", async (t) => {
	const { origin, staticDir } = await listen(t);
	const payload = randomBytes(5 * MB);

	const res = await fetch(`${origin}/proj/dumps/big.bin`, {
		method: "PUT",
		body: payload,
	});
	assert.deepStrictEqual(res.status, 200);
	assert.deepStrictEqual(await jsonOf(res), {
		uploaded: ["/proj/dumps/big.bin"],
		size: payload.byteLength,
	});

	const stored = await readFile(join(staticDir, "proj", "dumps", "big.bin"));
	assert.ok(stored.equals(payload), "stored bytes differ from the uploaded ones");
});

test("wire: chunked PUT (no Content-Length) reports the stored size", async (t) => {
	const { origin, staticDir } = await listen(t);
	const chunks = Array.from({ length: 48 }, () => randomBytes(64 * 1024));
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			const next = chunks.shift();
			if (next) controller.enqueue(next);
			else controller.close();
		},
	});
	const expected = Buffer.concat(chunks);

	const res = await fetch(`${origin}/proj/stream.bin`, {
		method: "PUT",
		body,
		duplex: "half",
	});
	assert.deepStrictEqual(res.status, 200);
	assert.deepStrictEqual((await jsonOf(res)).size, expected.byteLength);

	const stored = await readFile(join(staticDir, "proj", "stream.bin"));
	assert.ok(stored.equals(expected), "stored bytes differ from the uploaded ones");
});

test("wire: mid-stream size cap answers 413 and leaves nothing behind", async (t) => {
	const { origin, staticDir } = await listen(t, { uploadTokens: [], maxFileSize: MB });
	let sent = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			// more than the cap, with no declared length to reject up front
			if (sent < 4 * MB) {
				sent += 64 * 1024;
				controller.enqueue(new Uint8Array(64 * 1024));
			} else controller.close();
		},
	});

	const res = await fetch(`${origin}/proj/too-big.bin`, {
		method: "PUT",
		body,
		duplex: "half",
	});
	assert.deepStrictEqual(res.status, 413);
	assert.deepStrictEqual((await jsonOf(res)).uploaded, []);
	assert.deepStrictEqual(await listFiles(join(staticDir, "proj")), []);
});

// ─── Serving ────────────────────────────────────────────────────────

test("wire: multipart POST, then GET / HEAD / Range / conditional GET", async (t) => {
	const { origin } = await listen(t);

	const form = new FormData();
	form.append("file", new File(["hello world"], "docs/hello.txt"));
	const up = await fetch(`${origin}/proj`, { method: "POST", body: form });
	assert.deepStrictEqual(up.status, 200);
	assert.deepStrictEqual(await jsonOf(up), { uploaded: ["/proj/docs/hello.txt"] });

	const url = `${origin}/proj/docs/hello.txt`;
	const res = await fetch(url);
	assert.deepStrictEqual(res.status, 200);
	assert.deepStrictEqual(await res.text(), "hello world");
	assert.deepStrictEqual(res.headers.get("content-length"), "11");
	assert.deepStrictEqual(res.headers.get("content-type"), "text/plain; charset=utf-8");
	assert.deepStrictEqual(res.headers.get("x-content-type-options"), "nosniff");
	assert.deepStrictEqual(res.headers.get("access-control-allow-origin"), "*");
	assert.deepStrictEqual(res.headers.get("accept-ranges"), "bytes");
	const etag = res.headers.get("etag");
	assert.ok(etag);

	const head = await fetch(url, { method: "HEAD" });
	assert.deepStrictEqual(head.status, 200);
	assert.deepStrictEqual(head.headers.get("content-length"), "11");
	assert.deepStrictEqual(await head.text(), "");

	const range = await fetch(url, { headers: { range: "bytes=6-10" } });
	assert.deepStrictEqual(range.status, 206);
	assert.deepStrictEqual(range.headers.get("content-range"), "bytes 6-10/11");
	assert.deepStrictEqual(await range.text(), "world");

	const cached = await fetch(url, { headers: { "if-none-match": etag } });
	assert.deepStrictEqual(cached.status, 304);
	assert.deepStrictEqual(await cached.text(), "");

	const missing = await fetch(`${origin}/proj/docs/nope.txt`);
	assert.deepStrictEqual(missing.status, 404);
	await missing.body?.cancel();
});

// ─── Uploads the server refuses or loses ────────────────────────────

/**
 * Send an upload of `total` bytes that never looks at the answer before it is
 * done sending, the way a naive streaming client does. Resolves once the
 * server has answered and a moment has passed, with what got through.
 */
function relentlessUpload(
	port: number,
	method: string,
	path: string,
	headers: Record<string, string>,
	total: number,
): Promise<{ status: number; accepted: number }> {
	return new Promise((resolve, reject) => {
		const chunk = Buffer.alloc(64 * 1024, 7);
		let handed = 0;
		let answered = false;
		const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
			answered = true;
			res.resume();
			// Keep pushing for a moment after the answer: a server that drains
			// the rejected body would swallow most of it in that time.
			setTimeout(() => {
				resolve({ status: res.statusCode ?? 0, accepted: handed });
				req.destroy();
			}, 300);
		});
		req.on("error", (e) => {
			// the server may close a connection it is done with; anything before
			// its answer is a failure
			if (!answered) reject(e);
		});
		const pump = () => {
			while (handed < total && !req.destroyed) {
				handed += chunk.length;
				// stops while the server is not reading: `drain` then never fires
				if (!req.write(chunk)) {
					req.once("drain", pump);
					return;
				}
			}
			if (!req.destroyed) req.end();
		};
		pump();
	});
}

test("wire: an unauthorized PUT is answered at once and its body is not read", async (t) => {
	const { port, staticDir } = await listen(t, { uploadTokens: ["secret"] });
	const total = 256 * MB;

	const { status, accepted } = await relentlessUpload(
		port,
		"PUT",
		"/proj/big.bin",
		{ "content-length": String(total) },
		total,
	);
	assert.deepStrictEqual(status, 401);
	assert.ok(accepted < 32 * MB, `server took ${accepted} of ${total} bytes`);
	assert.deepStrictEqual(await listFiles(join(staticDir, "proj")), []);
});

test("wire: an unauthorized multipart POST is answered at once, body unread", async (t) => {
	const { port } = await listen(t, { uploadTokens: ["secret"] });
	const total = 256 * MB;

	const { status, accepted } = await relentlessUpload(
		port,
		"POST",
		"/proj",
		{
			"content-length": String(total),
			"content-type": "multipart/form-data; boundary=x",
		},
		total,
	);
	assert.deepStrictEqual(status, 401);
	assert.ok(accepted < 32 * MB, `server took ${accepted} of ${total} bytes`);
});

test("wire: a PUT over the declared size cap is refused before it is read", async (t) => {
	const { port, staticDir } = await listen(t, { uploadTokens: [], maxFileSize: MB });
	const total = 256 * MB;

	const { status, accepted } = await relentlessUpload(
		port,
		"PUT",
		"/proj/big.bin",
		{ "content-length": String(total) },
		total,
	);
	assert.deepStrictEqual(status, 413);
	assert.ok(accepted < 32 * MB, `server took ${accepted} of ${total} bytes`);
	assert.deepStrictEqual(await listFiles(join(staticDir, "proj")), []);
});

test("wire: a stalled PUT is answered 408 and nothing is published", async (t) => {
	const { port, staticDir } = await listen(
		t,
		{ uploadTokens: [] },
		{ uploadIdleTimeoutMs: 100 },
	);

	// 10 of the 1000 declared bytes, then silence
	const client = rawRequest(
		port,
		"PUT /proj/stalled.bin HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n0123456789",
	);
	try {
		assert.deepStrictEqual(await client.statusLine(), "HTTP/1.1 408 Request Timeout");
		assert.deepStrictEqual(await listFiles(join(staticDir, "proj")), []);
	} finally {
		client.socket.destroy();
	}
});

test("wire: a client that leaves mid-upload publishes nothing", async (t) => {
	const events: string[] = [];
	const { port, staticDir } = await listen(
		t,
		{ uploadTokens: [] },
		{
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: (event) => events.push(event),
			},
		},
	);

	const client = rawRequest(
		port,
		"PUT /proj/gone.bin HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n0123456789",
	);
	// the upload is in progress once its tmp file exists
	await until(async () => (await listFiles(join(staticDir, "proj"))).length === 1);
	client.socket.destroy();

	await until(async () => (await listFiles(join(staticDir, "proj"))).length === 0);
	assert.deepStrictEqual(events, ["upload.write_failed"]);
});
