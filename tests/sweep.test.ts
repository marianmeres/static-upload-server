// The startup sweep of upload leftovers (`<name>.tmp_<uuid>` files a crashed or
// killed upload left behind).

import assert from "node:assert/strict";
import { mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "../src/server.ts";
import { cleanup, setup } from "./_helpers.ts";

const UUID_A = "0b0f8c1e-6a52-4d6e-9c57-2f1d3a4b5c6d";
const UUID_B = "7e9a1c2d-3b4f-4a5e-8d6c-9f0a1b2c3d4e";
const UUID_C = "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f";

/** Create `path` with a modification time `ageMs` in the past. */
async function touch(path: string, ageMs: number): Promise<void> {
	await writeFile(path, "x");
	const when = new Date(Date.now() - ageMs);
	await utimes(path, when, when);
}

test("sweep: startup removes stale .tmp_<uuid> files, and only those", async () => {
	const { staticDir, configDir } = await setup("proj");
	const HOUR = 60 * 60 * 1000;
	const swept: string[] = [];
	try {
		const dir = join(staticDir, "proj");
		const nested = join(dir, "a", "b");
		await mkdir(nested, { recursive: true });
		// stale leftovers: removed, at any depth
		await touch(join(dir, `big.bin.tmp_${UUID_A}`), 2 * HOUR);
		await touch(join(nested, `deep.bin.tmp_${UUID_B}`), 2 * HOUR);
		// an upload that may still be running: kept
		await touch(join(dir, `fresh.bin.tmp_${UUID_C}`), 0);
		// stored files, however old and however similar the name: kept
		await touch(join(dir, "backup.tmp_2026-07-14"), 2 * HOUR);
		await touch(join(dir, "old.bin"), 2 * HOUR);

		await createServer({
			staticDir,
			configDir,
			tmpSweepMaxAgeMs: HOUR,
			logger: {
				debug: () => {},
				warn: () => {},
				error: () => {},
				info: (event, data) => {
					if (event === "tmp.swept") swept.push(String(data?.path));
				},
			},
		});

		// the sweep runs in the background of createServer()
		const deadline = Date.now() + 3000;
		while (swept.length < 2 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		assert.deepStrictEqual((await readdir(dir)).sort(), [
			"a",
			"backup.tmp_2026-07-14",
			`fresh.bin.tmp_${UUID_C}`,
			"old.bin",
		]);
		assert.deepStrictEqual(await readdir(nested), []);
		assert.deepStrictEqual(swept.sort(), [
			`${dir}/a/b/deep.bin.tmp_${UUID_B}`,
			`${dir}/big.bin.tmp_${UUID_A}`,
		]);
	} finally {
		await cleanup(staticDir, configDir);
	}
});

test("sweep: tmpSweepMaxAgeMs 0 disables it", async () => {
	const { staticDir, configDir } = await setup("proj");
	try {
		const dir = join(staticDir, "proj");
		await mkdir(dir, { recursive: true });
		await touch(join(dir, `big.bin.tmp_${UUID_A}`), 24 * 60 * 60 * 1000);

		await createServer({ staticDir, configDir, tmpSweepMaxAgeMs: 0 });
		await new Promise((resolve) => setTimeout(resolve, 100));

		assert.deepStrictEqual(await readdir(dir), [`big.bin.tmp_${UUID_A}`]);
	} finally {
		await cleanup(staticDir, configDir);
	}
});
