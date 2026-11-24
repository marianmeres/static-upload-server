/**
 * Measures server-side RSS while a large upload is processed, comparing the
 * multipart POST route (which buffers the parsed form in RAM via
 * `req.formData()`) with the raw-body PUT route (which streams to disk).
 *
 * The server runs as a subprocess and its RSS is sampled via `ps`, so client
 * buffers don't pollute the measurement. It listens on an OS-assigned port.
 *
 * Usage:
 *   node scripts/memcheck.ts post [sizeMB]   # peak grows with the file size
 *   node scripts/memcheck.ts put  [sizeMB]   # expect no per-upload multiplier
 */

import { execFile, spawn } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/server.ts";

const MB = 1024 * 1024;
const mb = (n: number) => `${(n / MB).toFixed(1)} MB`;

// ─── child role: run the real server ────────────────────────────────

if (process.argv[2] === "--serve") {
	const server = await createServer({
		port: 0,
		staticDir: process.env.MEMCHECK_STATIC_DIR,
		configDir: process.env.MEMCHECK_CONFIG_DIR,
		maxUploadSize: 0, // unlimited — this script measures, it doesn't police
	});
	const { port } = await server.start();
	console.log(`PORT=${port}`);
} else {
	// ─── parent role: measure ───────────────────────────────────────

	const mode = (process.argv[2] ?? "put").toLowerCase();
	if (mode !== "post" && mode !== "put") {
		console.error(`Usage: node scripts/memcheck.ts [post|put] [sizeMB]`);
		process.exit(1);
	}
	const SIZE = Number(process.argv[3] ?? 150) * MB;

	const staticDir = await mkdtemp(join(tmpdir(), "memcheck-static-"));
	const configDir = await mkdtemp(join(tmpdir(), "memcheck-config-"));
	await writeFile(join(configDir, "proj.json"), JSON.stringify({ uploadTokens: [] }));

	const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--serve"], {
		env: {
			...process.env,
			MEMCHECK_STATIC_DIR: staticDir,
			MEMCHECK_CONFIG_DIR: configDir,
		},
		stdio: ["ignore", "pipe", "inherit"],
	});

	// wait for the child to announce its port
	const port = await new Promise<number>((resolve, reject) => {
		let buf = "";
		child.stdout.on("data", (chunk: Buffer) => {
			buf += chunk.toString();
			const m = buf.match(/PORT=(\d+)/);
			if (m) resolve(Number(m[1]));
		});
		child.once("exit", () => reject(new Error("server subprocess exited early")));
		child.once("error", reject);
	});

	const rss = () =>
		new Promise<number>((resolve, reject) => {
			execFile("ps", ["-o", "rss=", "-p", String(child.pid)], (err, stdout) =>
				err ? reject(err) : resolve(Number(stdout.trim()) * 1024),
			);
		});

	const baseline = await rss();
	let peak = baseline;
	const poll = setInterval(async () => {
		peak = Math.max(peak, await rss().catch(() => 0));
	}, 50);

	// source file streamed from disk in 1 MB chunks — no client-side buffering
	const tmp = join(staticDir, "..", `memcheck-src-${process.pid}.bin`);
	const fh = await open(tmp, "w");
	const chunk = new Uint8Array(MB);
	for (let i = 0; i < SIZE / MB; i++) await fh.write(chunk);
	await fh.close();

	const src = await open(tmp, "r");
	const fileStream = src.readableWebStream() as ReadableStream<Uint8Array>;
	let body: ReadableStream<Uint8Array>;
	const headers: Record<string, string> = {};
	let url: string;

	if (mode === "put") {
		body = fileStream;
		url = `http://localhost:${port}/proj/big.bin`;
	} else {
		const boundary = "----memcheck";
		const head = new TextEncoder().encode(
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\n` +
				`Content-Type: application/octet-stream\r\n\r\n`,
		);
		const foot = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
		const fileReader = fileStream.getReader();
		body = new ReadableStream<Uint8Array>({
			start: (c) => c.enqueue(head),
			async pull(c) {
				const { done, value } = await fileReader.read();
				if (done) {
					c.enqueue(foot);
					c.close();
					return;
				}
				c.enqueue(value);
			},
		});
		headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
		url = `http://localhost:${port}/proj`;
	}

	console.log(`\nUploading ${mb(SIZE)} via ${mode.toUpperCase()} ...`);
	const started = performance.now();
	const res = await fetch(url, {
		method: mode.toUpperCase(),
		headers,
		body,
		duplex: "half",
	});
	const text = await res.text();
	const elapsed = performance.now() - started;
	const afterResponse = await rss();
	await new Promise((r) => setTimeout(r, 2000));
	const settled = await rss();
	clearInterval(poll);

	console.log(`\n  response:            ${res.status} ${text.slice(0, 120)}`);
	console.log(`  elapsed:             ${(elapsed / 1000).toFixed(1)} s`);
	console.log(`  baseline RSS:        ${mb(baseline)}`);
	console.log(`  peak RSS:            ${mb(peak)}`);
	console.log(`  RSS after response:  ${mb(afterResponse)}`);
	console.log(`  RSS after 2s:        ${mb(settled)}`);
	console.log(`  file size uploaded:  ${mb(SIZE)}`);
	console.log(`  peak delta / size:   ${((peak - baseline) / SIZE).toFixed(2)}x\n`);

	// the server this script started, by its own handle
	child.kill();
	await new Promise((r) => child.once("exit", r));
	await src.close().catch(() => {});
	await rm(tmp, { force: true });
	await rm(staticDir, { recursive: true, force: true });
	await rm(configDir, { recursive: true, force: true });
	process.exit(0);
}
