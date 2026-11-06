import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pickAllowOption, pickRejectOption, AcpSession } from "../../src/runtime/session.ts";
import type { ProviderSpec } from "../../src/runtime/providers.ts";

const fixturePath = join(fileURLToPath(import.meta.url), "../../fixtures/acp-child.ts");

test("permission choices do not fall back to an unrelated or conflicting option", () => {
  assert.equal(pickRejectOption([{ optionId: "allow", kind: "allow_once" }]), undefined);
  assert.equal(pickAllowOption([{ optionId: "unknown" }]), undefined);
  assert.equal(pickAllowOption([{ optionId: "disallow" }]), undefined);
  assert.equal(pickAllowOption([{ optionId: "allow", kind: "reject_once" }]), undefined);
  assert.equal(pickRejectOption([{ optionId: "reject", kind: "allow_once" }]), undefined);
});

test("AcpSession: an invalid permission callback result cancels the request", async () => {
  const session = await AcpSession.spawn(fixtureSpec(), {
    cwd: "/tmp", env: { ACP_FIXTURE_MODE: "permission" }, quiet: true,
    confirm: true, promptPermission: () => "unoffered-choice",
    onPermissionResolved: (choice) => assert.equal(choice, "cancelled"),
  });
  try {
    await session.prompt([{ type: "text", text: "needs-perm" }]);
  } finally {
    await session.close();
  }
});

function fixtureSpec(overrides: Partial<ProviderSpec> = {}): ProviderSpec {
  return { id: "claude", command: "bun", args: [fixturePath], model: "test-model", ...overrides };
}

test("pickRejectOption: selects reject option when present", () => {
  const options = [
    { optionId: "opt_allow", kind: "allow_once", name: "Allow" },
    { optionId: "opt_reject", kind: "reject_once", name: "Reject" },
  ];
  assert.equal(pickRejectOption(options), "opt_reject");
});

test("AcpSession: confirm with promptPermission selects returned option", async () => {
  const driver = fixtureSpec();
  let requested = false;

  const session = await AcpSession.spawn(driver, {
    cwd: "/tmp",
    env: { ACP_FIXTURE_MODE: "permission" },
    quiet: true,
    confirm: true,
    promptPermission: async () => {
      requested = true;
      return "reject";
    },
  });

  const reply = await session.prompt([{ type: "text", text: "needs-perm" }]);
  assert.equal(reply, "echo:needs-perm");
  assert.equal(requested, true);

  await session.close();
});

test("AcpSession: confirm with promptPermission gates fs/write_text_file", async () => {
  const driver = fixtureSpec();
  let requested = false;

  const session = await AcpSession.spawn(driver, {
    cwd: "/tmp",
    env: { ACP_FIXTURE_MODE: "write-file" },
    quiet: true,
    confirm: true,
    promptPermission: async () => {
      requested = true;
      return "allow";
    },
  });

  await session.prompt([{ type: "text", text: "write" }]);
  assert.equal(requested, true);

  await session.close();
});

test("AcpSession: rejecting fs/write_text_file prevents write", async () => {
  const driver = fixtureSpec();
  const session = await AcpSession.spawn(driver, {
    cwd: "/tmp",
    env: { ACP_FIXTURE_MODE: "write-file" },
    quiet: true,
    confirm: true,
    promptPermission: async () => "reject",
  });

  await assert.rejects(
    () => session.prompt([{ type: "text", text: "write" }]),
    (err: any) => err.message.includes("Internal error") && String(err.data?.details).includes("Permission denied"),
  );

  await session.close();
});

test("AcpSession: disallow cannot approve a file write", async () => {
  const session = await AcpSession.spawn(fixtureSpec(), {
    cwd: "/tmp", env: { ACP_FIXTURE_MODE: "write-file" }, quiet: true,
    confirm: true, promptPermission: () => "disallow",
  });
  try {
    await assert.rejects(() => session.prompt([{ type: "text", text: "write" }]),
      (error: any) => String(error.data?.details).includes("Permission denied"));
  } finally {
    await session.close();
  }
});
