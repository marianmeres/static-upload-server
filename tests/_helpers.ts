import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StaticServerOptions } from "../src/server.ts";
import { clearConfigCache, createServer } from "../src/server.ts";

export const BASE = "http://localhost";

/** A fresh, empty directory under the OS temp dir. */
export function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "static-upload-server-test-"));
}

/** A file's content as UTF-8 text. */
export function readTextFile(path: string): Promise<string> {
	return readFile(path, "utf8");
}

/**
 * A response's JSON body. Typed `any` on purpose (the tests assert on its
 * shape), where `Response.json()` is `unknown` under Node's types.
 */
// biome-ignore lint/suspicious/noExplicitAny: see above
export async function jsonOf(res: Response): Promise<any> {
	return await res.json();
}

/** Create a temp dir pair (staticDir + configDir) and a project config file. */
export async function setup(
	projectId: string,
	config: Record<string, unknown> = { uploadTokens: [] },
) {
	const staticDir = await makeTempDir();
	const configDir = await makeTempDir();
	await writeFile(join(configDir, `${projectId}.json`), JSON.stringify(config));
	clearConfigCache();
	return { staticDir, configDir };
}

export async function cleanup(...dirs: string[]) {
	for (const dir of dirs) {
		await rm(dir, { recursive: true });
	}
}

export function makeUploadRequest(
	projectId: string,
	files: { name: string; content: string }[],
	token?: string,
): Request {
	const formData = new FormData();
	for (const f of files) {
		formData.append(
			"file",
			new File([f.content], f.name, {
				type: "application/octet-stream",
			}),
		);
	}
	const headers: Record<string, string> = {};
	if (token) headers["Authorization"] = `Bearer ${token}`;
	return new Request(`${BASE}/${projectId}`, {
		method: "POST",
		body: formData,
		headers,
	});
}

export function makePutRequest(
	projectId: string,
	path: string,
	body: RequestInit["body"],
	opts: { token?: string; headers?: Record<string, string> } = {},
): Request {
	const headers: Record<string, string> = { ...opts.headers };
	if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
	return new Request(`${BASE}/${projectId}/${path}`, {
		method: "PUT",
		body,
		headers,
		// required by Node for a streamed body, ignored for any other
		duplex: "half",
	});
}

/** Create a handler from options, with temp dirs already resolved. */
export async function createHandler(
	opts: StaticServerOptions,
): Promise<(req: Request) => Promise<Response>> {
	const { handler } = await createServer(opts);
	return handler;
}

/** Create a valid HS256 JWT for testing. */
export async function createTestJwt(
	secret: string,
	payload: Record<string, unknown> = {},
): Promise<string> {
	const encoder = new TextEncoder();
	const headerB64 = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	const payloadB64 = btoa(
		JSON.stringify({
			sub: "test",
			exp: Math.floor(Date.now() / 1000) + 3600,
			...payload,
		}),
	)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	const data = encoder.encode(`${headerB64}.${payloadB64}`);
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, data);
	const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return `${headerB64}.${payloadB64}.${sigB64}`;
}
