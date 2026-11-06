import assert from "node:assert/strict";
import test from "node:test";
import { renderPromptTemplate } from "../../src/config/vars.ts";

test("template syntax: ${{ }} is only for outside values, so a workflow var points to {{name}}", () => {
  for (const token of ["${{ vars.name }}", "${{ name }}"]) {
    assert.throws(() => renderPromptTemplate(`Hello ${token}!`, { name: "Alice" }), /use \{\{name\}\} for a workflow var/);
  }
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

test("template syntax: renders ${{ secrets.NAME }} from environment", () => {
  process.env.TEST_ACP_SYNTAX_SECRET = "s3cret-value";
  try {
    assert.equal(renderPromptTemplate("Bearer ${{ secrets.TEST_ACP_SYNTAX_SECRET }}", {}), "Bearer s3cret-value");
  } finally {
    delete process.env.TEST_ACP_SYNTAX_SECRET;
  }
});

test("template syntax: an empty secret is an error, an empty env value is not", () => {
  process.env.TEST_ACP_SYNTAX_EMPTY = "";
  try {
    assert.throws(() => renderPromptTemplate("${{ secrets.TEST_ACP_SYNTAX_EMPTY }}", {}), /secret TEST_ACP_SYNTAX_EMPTY is empty/);
    assert.equal(renderPromptTemplate("[${{ env.TEST_ACP_SYNTAX_EMPTY }}]", {}), "[]");
  } finally {
    delete process.env.TEST_ACP_SYNTAX_EMPTY;
  }
});

test("template syntax: {{ }} is only for workflow vars, so env and secrets point to ${{ }}", () => {
  assert.throws(() => renderPromptTemplate("{{env.HOME}}", {}), /use \$\{\{ env\.HOME \}\} for an outside value/);
  assert.throws(() => renderPromptTemplate("{{secrets.TOKEN}}", {}), /use \$\{\{ secrets\.TOKEN \}\} for an outside value/);
});

test("template syntax: rejects the removed feedback variable in every supported form", () => {
  for (const token of ["{{feedback}}", "{{vars.feedback}}"]) {
    for (const vars of [{}, { feedback: "declared" }] as Record<string, string>[]) {
      assert.throws(() => renderPromptTemplate(`Check: ${token}`, vars), /Check failures are attached automatically; remove the feedback placeholder\./);
    }
  }
  assert.equal(renderPromptTemplate("Literal: $${{ feedback }}"), "Literal: ${{ feedback }}");
});

test("template syntax: escapes $${{ vars.name }} to literal ${{ vars.name }}", () => {
  const result = renderPromptTemplate("Literal: $${{ vars.name }} and real: {{name}}", {
    name: "test",
  });
  assert.equal(result, "Literal: ${{ vars.name }} and real: test");
});

test("template syntax: does not recursively expand inserted values", () => {
  const result = renderPromptTemplate("Greeting: {{greeting}}", {
    greeting: "{{target}}",
    target: "world",
  });
  assert.equal(result, "Greeting: {{target}}");
});

test("template syntax: legacy {{ ... }} syntax continues to work", () => {
  const result = renderPromptTemplate("Legacy: {{name}} and {{vars.name}}", { name: "Charlie" });
  assert.equal(result, "Legacy: Charlie and Charlie");
});
