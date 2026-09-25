import assert from "node:assert/strict";
import test from "node:test";
import { renderPromptTemplate } from "../../src/config/vars.ts";

test("template syntax: renders ${{ vars.name }}", () => {
  const result = renderPromptTemplate("Hello ${{ vars.name }}!", { name: "Alice" });
  assert.equal(result, "Hello Alice!");
});

test("template syntax: renders ${{ name }} with implicit vars namespace", () => {
  const result = renderPromptTemplate("Hello ${{ name }}!", { name: "Bob" });
  assert.equal(result, "Hello Bob!");
});

test("template syntax: renders ${{ env.NAME }} from environment", () => {
  const prev = process.env.TEST_ACP_SYNTAX_ENV;
  process.env.TEST_ACP_SYNTAX_ENV = "world";
  try {
    const result = renderPromptTemplate("Hello ${{ env.TEST_ACP_SYNTAX_ENV }}!", {});
    assert.equal(result, "Hello world!");
  } finally {
    if (prev === undefined) delete process.env.TEST_ACP_SYNTAX_ENV;
    else process.env.TEST_ACP_SYNTAX_ENV = prev;
  }
});

test("template syntax: rejects the removed feedback variable in every supported form", () => {
  for (const token of ["{{feedback}}", "{{vars.feedback}}", "${{ feedback }}", "${{ vars.feedback }}"]) {
    for (const vars of [{}, { feedback: "declared" }] as Record<string, string>[]) {
      assert.throws(() => renderPromptTemplate(`Check: ${token}`, vars), /Check failures are attached automatically; remove the feedback placeholder\./);
    }
  }
  assert.equal(renderPromptTemplate("Literal: $${{ feedback }}"), "Literal: ${{ feedback }}");
});

test("template syntax: escapes $${{ vars.name }} to literal ${{ vars.name }}", () => {
  const result = renderPromptTemplate("Literal: $${{ vars.name }} and real: ${{ vars.name }}", {
    name: "test",
  });
  assert.equal(result, "Literal: ${{ vars.name }} and real: test");
});

test("template syntax: does not recursively expand inserted values", () => {
  const result = renderPromptTemplate("Greeting: ${{ greeting }}", {
    greeting: "${{ target }}",
    target: "world",
  });
  assert.equal(result, "Greeting: ${{ target }}");
});

test("template syntax: throws on unknown variable in ${{ ... }}", () => {
  assert.throws(
    () => renderPromptTemplate("Missing: ${{ missing }}", {}),
    /unknown variable/,
  );
});

test("template syntax: legacy {{ ... }} syntax continues to work", () => {
  const result = renderPromptTemplate("Legacy: {{name}} and {{vars.name}}", { name: "Charlie" });
  assert.equal(result, "Legacy: Charlie and Charlie");
});
