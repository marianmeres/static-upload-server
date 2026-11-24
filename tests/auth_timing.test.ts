import assert from "node:assert/strict";
import { test } from "node:test";
import { timingSafeEqualStr } from "../src/auth.ts";

test("timingSafeEqualStr: equal strings match", () => {
	assert.deepStrictEqual(timingSafeEqualStr("hello", "hello"), true);
});

test("timingSafeEqualStr: different strings do not match", () => {
	assert.deepStrictEqual(timingSafeEqualStr("hello", "world"), false);
});

test("timingSafeEqualStr: different lengths do not match", () => {
	assert.deepStrictEqual(timingSafeEqualStr("hello", "hello!"), false);
	assert.deepStrictEqual(timingSafeEqualStr("hello!", "hello"), false);
});

test("timingSafeEqualStr: empty strings match", () => {
	assert.deepStrictEqual(timingSafeEqualStr("", ""), true);
});

test("timingSafeEqualStr: one-char diff at start or end", () => {
	assert.deepStrictEqual(timingSafeEqualStr("Xbcdef", "abcdef"), false);
	assert.deepStrictEqual(timingSafeEqualStr("abcdeX", "abcdef"), false);
});
