import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { clearConfigCache, loadProjectConfig } from "../src/config.ts";
import { makeTempDir } from "./_helpers.ts";

test("cache: same projectId in different configDirs isolates", async () => {
	const a = await makeTempDir();
	const b = await makeTempDir();
	try {
		await writeFile(
			join(a, "shared.json"),
			JSON.stringify({ uploadTokens: ["from-a"] }),
		);
		await writeFile(
			join(b, "shared.json"),
			JSON.stringify({ uploadTokens: ["from-b"] }),
		);
		clearConfigCache();

		const fromA = await loadProjectConfig(a, "shared");
		const fromB = await loadProjectConfig(b, "shared");

		assert.deepStrictEqual(fromA?.uploadTokens, ["from-a"]);
		assert.deepStrictEqual(fromB?.uploadTokens, ["from-b"]);
	} finally {
		await rm(a, { recursive: true });
		await rm(b, { recursive: true });
	}
});

test("cache: clearConfigCache(configDir) only clears that dir", async () => {
	const a = await makeTempDir();
	const b = await makeTempDir();
	try {
		await writeFile(
			join(a, "shared.json"),
			JSON.stringify({ uploadTokens: ["from-a"] }),
		);
		await writeFile(
			join(b, "shared.json"),
			JSON.stringify({ uploadTokens: ["from-b"] }),
		);
		clearConfigCache();

		await loadProjectConfig(a, "shared");
		await loadProjectConfig(b, "shared");

		// Update A only, clear A only
		await writeFile(
			join(a, "shared.json"),
			JSON.stringify({ uploadTokens: ["from-a-2"] }),
		);
		clearConfigCache(a);

		const fromA = await loadProjectConfig(a, "shared");
		const fromB = await loadProjectConfig(b, "shared");

		assert.deepStrictEqual(fromA?.uploadTokens, ["from-a-2"]);
		assert.deepStrictEqual(fromB?.uploadTokens, ["from-b"]); // still cached
	} finally {
		await rm(a, { recursive: true });
		await rm(b, { recursive: true });
	}
});
