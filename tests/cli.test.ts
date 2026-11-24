// The CLI entry as a deployment runs it (`node src/cli.ts`): configured through
// the environment, on an OS-assigned port, stopped with a signal.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanup, jsonOf, setup } from "./_helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("cli: PORT=0 binds a free port, serves, and exits 0 on SIGTERM", async () => {
	const { staticDir, configDir } = await setup("proj");
	// the test runner's own marker must not reach a process that is not a test
	const { NODE_TEST_CONTEXT: _, ...env } = process.env;
	const child = spawn(process.execPath, [CLI], {
		env: { ...env, PORT: "0", STATIC_DIR: staticDir, CONFIG_DIR: configDir },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const exited = new Promise<number | null>((resolve) => {
		child.once("exit", (code) => resolve(code));
	});
	try {
		let stdout = "";
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const port = await new Promise<number>((resolve, reject) => {
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
				const m = /Listening on :(\d+)/.exec(stdout);
				if (m) resolve(Number(m[1]));
			});
			child.once("exit", (code) =>
				reject(new Error(`cli exited ${code} before listening:\n${stderr}`)),
			);
		});
		assert.ok(port > 0, "the banner must name the bound port, not 0");

		const res = await fetch(`http://127.0.0.1:${port}/`);
		assert.deepStrictEqual(res.status, 200);
		assert.match((await jsonOf(res)).version, /^\d+\.\d+\.\d+/);

		const form = await fetch(`http://127.0.0.1:${port}/proj`);
		assert.deepStrictEqual(form.status, 200);
		assert.ok((await form.text()).includes("<form"));

		child.kill("SIGTERM");
		assert.deepStrictEqual(await exited, 0);
	} finally {
		// the process this test started, by its own handle
		if (child.exitCode === null) child.kill("SIGKILL");
		await exited;
		await cleanup(staticDir, configDir);
	}
});
