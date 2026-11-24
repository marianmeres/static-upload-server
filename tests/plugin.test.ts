import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { clearPluginCache, loadPlugin } from "../src/plugin.ts";
import { clearConfigCache } from "../src/server.ts";
import { BASE, cleanup, createHandler, makeTempDir } from "./_helpers.ts";

async function setupWithPlugin(
	projectId: string,
	pluginSource: string,
	extraConfig: Record<string, unknown> = {},
): Promise<{ staticDir: string; configDir: string; pluginPath: string }> {
	const staticDir = await makeTempDir();
	const configDir = await makeTempDir();
	const pluginPath = join(configDir, `${projectId}.plugin.ts`);
	await writeFile(pluginPath, pluginSource);
	await writeFile(
		join(configDir, `${projectId}.json`),
		JSON.stringify({
			uploadTokens: [],
			plugin: `./${projectId}.plugin.ts`,
			...extraConfig,
		}),
	);
	clearConfigCache();
	clearPluginCache();
	return { staticDir, configDir, pluginPath };
}

// ─── Plugin handler basics ──────────────────────────────────────────

test("plugin: handles request when returning Response", async () => {
	const { staticDir, configDir } = await setupWithPlugin(
		"p",
		`export default async (_req, _ctx) => new Response("from-plugin", { status: 201 });`,
	);
	try {
		const handler = await createHandler({ staticDir, configDir });
		const res = await handler(new Request(`${BASE}/p`));
		assert.deepStrictEqual(res.status, 201);
		assert.deepStrictEqual(await res.text(), "from-plugin");
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("plugin: returning null falls through to default handler", async () => {
	const { staticDir, configDir } = await setupWithPlugin(
		"p",
		`export default async (_req, _ctx) => null;`,
	);
	try {
		const handler = await createHandler({ staticDir, configDir });
		const res = await handler(new Request(`${BASE}/p`));
		// default form is enabled
		assert.deepStrictEqual(res.status, 200);
		assert.deepStrictEqual(
			res.headers.get("content-type"),
			"text/html; charset=utf-8",
		);
		await res.body?.cancel();
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("plugin: throwing plugin returns 500", async () => {
	const { staticDir, configDir } = await setupWithPlugin(
		"p",
		`export default async (_req, _ctx) => { throw new Error("boom"); };`,
	);
	try {
		const handler = await createHandler({ staticDir, configDir });
		const res = await handler(new Request(`${BASE}/p`));
		assert.deepStrictEqual(res.status, 500);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

// ─── Plugin sandboxing ──────────────────────────────────────────────

test("plugin: path resolving outside configDir is rejected", async () => {
	const configDir = await makeTempDir();
	try {
		await assert.rejects(
			() => loadPlugin(configDir, "../../etc/passwd.ts"),
			(e: unknown) =>
				e instanceof Error && e.message.includes("must resolve inside configDir"),
		);
	} finally {
		await cleanup(configDir);
	}
});
