import assert from "node:assert/strict";
import test from "node:test";
import { providerSpec } from "../../src/runtime/providers.ts";

test("providerSpec: resolves a harness declared in the runbook", () => {
  const declared = { amp: { command: "amp", args: ["--acp"], model: "amp-1" } };
  assert.deepEqual(providerSpec("amp", declared), {
    id: "amp",
    command: "amp",
    args: ["--acp"],
    model: "amp-1",
  });
});

test("providerSpec: a declared harness with no args gets an empty arg list", () => {
  assert.deepEqual(providerSpec("amp", { amp: { command: "amp", model: "amp-1" } }).args, []);
});

test("providerSpec: an unknown name throws and lists the declared ones", () => {
  assert.throws(
    () => providerSpec("nope", { amp: { command: "amp", model: "amp-1" } }),
    /unknown provider "nope" \(known: amp\)/,
  );
});

test("providerSpec: only harnesses the runbook declares exist", () => {
  assert.throws(() => providerSpec("claude", {}), /unknown provider "claude" \(known: none\)/);
});
