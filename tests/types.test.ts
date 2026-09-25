import assert from "node:assert/strict";
import test from "node:test";
import { isScriptStep } from "../src/types.ts";

test("isScriptStep: true when step has run and no prompt body", () => {
  assert.equal(isScriptStep({ id: "script", run: "node script.js" }), true);
});

test("isScriptStep: false when step has an inline or file body, or no run", () => {
  assert.equal(isScriptStep({ id: "prompt", do: "do something", run: "node test.js" }), false);
  assert.equal(isScriptStep({ id: "prompt", do: { file: "prompt.md" }, run: "node test.js" }), false);
  assert.equal(isScriptStep({ id: "default_prompt", do: "Ship it" }), false);
  assert.equal(isScriptStep(undefined), false);
});
