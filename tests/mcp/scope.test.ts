import assert from "node:assert/strict";
import test from "node:test";
import { matchesPattern, normalizeScope, toolAllowed, visibleTools } from "../../src/mcp/scope.ts";

const declared = ["a", "b"];

test("normalizeScope: an omitted list means every declared server, unfiltered", () => {
  assert.deepEqual(normalizeScope(undefined, declared), { a: {}, b: {} });
});

test("normalizeScope: an empty list means no server", () => {
  assert.deepEqual(normalizeScope([], declared), {});
});

test("normalizeScope: a list means those servers unfiltered", () => {
  assert.deepEqual(normalizeScope(["a"], declared), { a: {} });
});

test("normalizeScope: a map keeps its allow and deny", () => {
  assert.deepEqual(normalizeScope({ a: { allow: ["p"] }, b: {} }, declared), {
    a: { allow: ["p"] },
    b: {},
  });
});

test("matchesPattern: star is the only wildcard and matching is case-sensitive", () => {
  assert.equal(matchesPattern("query_events", "query_*"), true);
  assert.equal(matchesPattern("query_events", "*_events"), true);
  assert.equal(matchesPattern("query_events", "*"), true);
  assert.equal(matchesPattern("query_events", "query"), false);
  assert.equal(matchesPattern("Query_events", "query_*"), false);
  assert.equal(matchesPattern("q.uery", "q.uery"), true);
  assert.equal(matchesPattern("qXuery", "q.uery"), false);
});

test("toolAllowed: the 3.2 table", () => {
  assert.equal(toolAllowed(normalizeScope(undefined, declared), "a", "drop"), true);
  assert.equal(toolAllowed(normalizeScope([], declared), "a", "drop"), false);
  assert.equal(toolAllowed(normalizeScope(["a", "b"], declared), "b", "drop"), true);
  assert.equal(toolAllowed(normalizeScope({ a: {} }, declared), "a", "drop"), true);
  assert.equal(toolAllowed(normalizeScope({ a: {} }, declared), "b", "drop"), false);
  assert.equal(toolAllowed(normalizeScope({ a: { allow: ["p*"] } }, declared), "a", "pick"), true);
  assert.equal(toolAllowed(normalizeScope({ a: { allow: ["p*"] } }, declared), "a", "drop"), false);
  assert.equal(toolAllowed(normalizeScope({ a: { deny: ["d*"] } }, declared), "a", "drop"), false);
  assert.equal(toolAllowed(normalizeScope({ a: { deny: ["d*"] } }, declared), "a", "pick"), true);
});

test("toolAllowed: deny wins over allow", () => {
  const scope = normalizeScope({ a: { allow: ["*"], deny: ["drop_*"] } }, declared);
  assert.equal(toolAllowed(scope, "a", "select"), true);
  assert.equal(toolAllowed(scope, "a", "drop_table"), false);
});

test("visibleTools: filters a catalogue and prefixes with the server name", () => {
  const catalogue = new Map([
    ["a", [{ name: "select" }, { name: "drop_table" }]],
    ["b", [{ name: "ping" }]],
  ]);
  const scope = normalizeScope({ a: { deny: ["drop_*"] } }, declared);
  assert.deepEqual(
    visibleTools(catalogue, scope).map((tool) => tool.name),
    ["a__select"],
  );
});
