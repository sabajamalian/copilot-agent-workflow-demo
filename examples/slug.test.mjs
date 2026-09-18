import test from "node:test";
import assert from "node:assert/strict";
import { slug } from "./slug.mjs";

test("normalizes whitespace and case", () => {
  assert.equal(slug("  Ship the Pipeline  "), "ship-the-pipeline");
});

test("rejects non-string input", () => {
  assert.throws(() => slug(null), TypeError);
});
