/**
 * Smoke-tests the built npm package (`pnpm run smoke`, or
 * `node scripts/smoke-npm.ts` after `pnpm run build`).
 *
 * `pnpm pack`s the repo root - the tarball `pnpm publish` would upload - and in a
 * throw-away project under the OS temp dir installs it with npm, as a consumer gets
 * it, then on Node:
 *
 *  1. checks the installed package.json (the `.` and `./server` exports and their
 *     files, the bin, the runtime dependencies, `engines.node`) and that the
 *     tarball carries `dist/` with `upload.html`, without any repo-only directory;
 *  2. runs the installed bin on an OS-assigned port (`PORT=0`): the suite runs
 *     `src/*.ts`, so only here does the server run from `dist/*.js`, through npm's
 *     bin link. It must report the package's own version (read from the installed
 *     package.json), serve the upload form (the copied `upload.html`), take a PUT
 *     and serve it back, run a TypeScript plugin from the config dir, and exit 0 on
 *     SIGTERM;
 *  3. imports the library through both specifiers and calls its handler.
 *
 * Repo tool, Node only (nothing here is shipped).
 */

import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { name: PKG, bin: BINS } = JSON.parse(
	readFileSync(join(ROOT, "package.json"), "utf8"),
) as { name: string; bin: Record<string, string> };
const [BIN] = Object.keys(BINS);
const DEPS = ["@marianmeres/demino", "mime-types"];

/** Repo directories the published tarball must not carry. */
const REPO_ONLY = ["src", "tests", "scripts", "tmp", "example", "node_modules"];

/** Step 3: a library consumer. */
const LIBRARY = `
import assert from "node:assert/strict";
import * as root from "${PKG}";
import * as server from "${PKG}/server";

assert.equal(root.createServer, server.createServer, "'.' and './server' are the same module");
const { handler, version } = await root.createServer({
	staticDir: "./lib-static",
	configDir: "./lib-config",
});
const res = await handler(new Request("http://localhost/"));
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), { version });
console.log("smoke: the library imports through both specifiers and answers a request");
`;

/** Step 2: a plugin as a deployment writes one, typed and outside node_modules. */
const PLUGIN = `
type Ctx = { projectId: string };
export default async (req: Request, ctx: Ctx): Promise<Response | null> =>
	new URL(req.url).pathname.endsWith("/hello")
		? new Response("plugin ok " + ctx.projectId)
		: null;
`;

type Manifest = {
	name?: string;
	version?: string;
	exports?: Record<string, Record<string, string>>;
	bin?: Record<string, string>;
	dependencies?: Record<string, string>;
	engines?: Record<string, string>;
};

function run(cmd: string, args: string[], cwd: string): string {
	console.log(`smoke: $ ${[cmd, ...args].join(" ")}`);
	return execFileSync(cmd, args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
}

function check(condition: unknown, what: string): asserts condition {
	if (!condition) throw new Error(`smoke: ${what}`);
}

function checkInstalledManifest(dir: string): Manifest {
	const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
	check(pkg.name === PKG, `installed package is "${pkg.name}", expected "${PKG}"`);
	const exportKeys = Object.keys(pkg.exports ?? {});
	check(
		JSON.stringify(exportKeys) === JSON.stringify([".", "./server"]),
		`exports keys are ${JSON.stringify(exportKeys)}`,
	);
	for (const key of exportKeys) {
		for (const kind of ["types", "default"]) {
			const file = pkg.exports?.[key]?.[kind];
			check(
				file && existsSync(join(dir, file)),
				`exports["${key}"].${kind} does not exist: ${file}`,
			);
		}
	}
	const bin = BIN && pkg.bin?.[BIN];
	check(bin && existsSync(join(dir, bin)), `bin "${BIN}" does not exist: ${bin}`);
	check(
		existsSync(join(dir, "dist", "upload.html")),
		"the tarball has no dist/upload.html (the upload form)",
	);
	for (const dep of DEPS) {
		check(
			typeof pkg.dependencies?.[dep] === "string",
			`${dep} is not a runtime dependency: ${JSON.stringify(pkg.dependencies)}`,
		);
	}
	check(typeof pkg.engines?.node === "string", "engines.node missing");
	for (const name of REPO_ONLY) {
		check(!existsSync(join(dir, name)), `the tarball carries "${name}/"`);
	}
	console.log(
		`smoke: ${pkg.name}@${pkg.version} - bin ${BIN}, ` +
			`deps ${DEPS.map((d) => `${d} ${pkg.dependencies?.[d]}`).join(", ")}, ` +
			`engines.node ${pkg.engines?.node}`,
	);
	return pkg;
}

/** Step 2: the installed bin, as `npx <package>` runs it. */
async function checkBin(project: string, pkg: Manifest): Promise<void> {
	const staticDir = join(project, "static");
	const configDir = join(project, "config");
	mkdirSync(join(configDir, "plugins"), { recursive: true });
	writeFileSync(join(configDir, "proj.json"), JSON.stringify({ uploadTokens: [] }));
	writeFileSync(join(configDir, "plugins", "hello.ts"), PLUGIN);
	writeFileSync(
		join(configDir, "plug.json"),
		JSON.stringify({ uploadTokens: [], plugin: "./plugins/hello.ts" }),
	);

	const bin = join(project, "node_modules", ".bin", BIN ?? "");
	console.log(`smoke: $ PORT=0 ${bin}`);
	const child = spawn(bin, [], {
		cwd: project,
		env: { ...process.env, PORT: "0", STATIC_DIR: staticDir, CONFIG_DIR: configDir },
		stdio: ["ignore", "pipe", "inherit"],
	});
	const exited = new Promise<number | null>((resolve) => {
		child.once("exit", (code) => resolve(code));
	});
	try {
		const port = await new Promise<number>((resolve, reject) => {
			let stdout = "";
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
				const m = /Listening on :(\d+)/.exec(stdout);
				if (m) resolve(Number(m[1]));
			});
			child.once("error", reject);
			child.once("exit", (code) =>
				reject(new Error(`smoke: the bin exited ${code} before listening`)),
			);
		});
		const origin = `http://127.0.0.1:${port}`;

		const version = (await (await fetch(`${origin}/`)).json()) as {
			version?: string;
		};
		check(
			version.version === pkg.version,
			`GET / reported version "${version.version}", expected "${pkg.version}"`,
		);

		const form = await fetch(`${origin}/proj`);
		check(
			form.status === 200 && (await form.text()).includes("<form"),
			`GET /proj did not serve the upload form (status ${form.status})`,
		);

		const put = await fetch(`${origin}/proj/dir/hello.txt`, {
			method: "PUT",
			body: "smoke",
		});
		check(put.status === 200, `PUT answered ${put.status}`);
		const got = await fetch(`${origin}/proj/dir/hello.txt`);
		check(
			got.status === 200 && (await got.text()) === "smoke",
			`GET of the uploaded file answered ${got.status}`,
		);
		check(
			readFileSync(join(staticDir, "proj", "dir", "hello.txt"), "utf8") === "smoke",
			"the upload is not on disk under STATIC_DIR",
		);

		const plugin = await fetch(`${origin}/plug/hello`);
		const pluginText = await plugin.text();
		check(
			plugin.status === 200 && pluginText === "plugin ok plug",
			`the TypeScript plugin answered ${plugin.status} "${pluginText}"`,
		);

		child.kill("SIGTERM");
		const code = await exited;
		check(code === 0, `the bin exited ${code} on SIGTERM, expected 0`);
		console.log(
			"smoke: the bin runs from dist/ (version, upload form, PUT + GET, a .ts plugin, SIGTERM)",
		);
	} finally {
		// the process this script started, by its own handle
		if (child.exitCode === null) child.kill("SIGKILL");
		await exited;
	}
}

check(
	existsSync(join(ROOT, "dist", "server.js")) &&
		existsSync(join(ROOT, "dist", "cli.js")),
	"dist/ is missing - run `pnpm run build` first",
);

const project = mkdtempSync(join(tmpdir(), "static-upload-server-npm-smoke-"));
try {
	writeFileSync(
		join(project, "package.json"),
		JSON.stringify({ name: "npm-smoke", private: true, type: "module" }),
	);
	const packDir = join(project, "pack");
	mkdirSync(packDir);
	run("pnpm", ["pack", "--pack-destination", packDir], ROOT);
	const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
	const [tarball] = tarballs;
	check(
		tarballs.length === 1 && tarball,
		`expected one tarball, got ${JSON.stringify(tarballs)}`,
	);

	run(
		"npm",
		[
			"install",
			"--no-audit",
			"--no-fund",
			"--loglevel=error",
			join(packDir, tarball),
		],
		project,
	);
	const pkg = checkInstalledManifest(join(project, "node_modules", PKG));

	await checkBin(project, pkg);

	writeFileSync(join(project, "library.mjs"), LIBRARY);
	process.stdout.write(run(process.execPath, ["library.mjs"], project));
	console.log("smoke: OK");
} finally {
	rmSync(project, { recursive: true, force: true });
}
