import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCacheStrategy } from "../src/cache-strategy.ts";

test("resolveCacheStrategy: undefined → mutable", () => {
	assert.deepStrictEqual(resolveCacheStrategy(undefined, "/anything"), "mutable");
});

test("resolveCacheStrategy: scalar form passes through", () => {
	assert.deepStrictEqual(resolveCacheStrategy("immutable", "/x.jpg"), "immutable");
	assert.deepStrictEqual(resolveCacheStrategy("mutable", "/x.jpg"), "mutable");
});

test("resolveCacheStrategy: map form, longest matching prefix wins", () => {
	const cfg = {
		"/img/": "mutable" as const,
		"/img/hashed/": "immutable" as const,
	};
	assert.deepStrictEqual(resolveCacheStrategy(cfg, "/img/foo.jpg"), "mutable");
	assert.deepStrictEqual(
		resolveCacheStrategy(cfg, "/img/hashed/abc-DJ21.jpg"),
		"immutable",
	);
});

test("resolveCacheStrategy: map with fallback ('' key) when no prefix matches", () => {
	const cfg = { "/img/": "immutable" as const, "": "mutable" as const };
	assert.deepStrictEqual(resolveCacheStrategy(cfg, "/img/foo.jpg"), "immutable");
	assert.deepStrictEqual(resolveCacheStrategy(cfg, "/avatars/u.png"), "mutable");
});

test("resolveCacheStrategy: map without fallback, no match → mutable", () => {
	const cfg = { "/img/": "immutable" as const };
	assert.deepStrictEqual(resolveCacheStrategy(cfg, "/avatars/u.png"), "mutable");
});

test("resolveCacheStrategy: empty map → mutable", () => {
	assert.deepStrictEqual(resolveCacheStrategy({}, "/x"), "mutable");
});
