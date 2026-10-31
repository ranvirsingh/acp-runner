import { cpSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "create-acp-agent";

export function installSkill(): string {
  const source = fileURLToPath(new URL(`../.claude/skills/${SKILL_NAME}`, import.meta.url));
  if (!existsSync(join(source, "SKILL.md"))) {
    throw new Error(`skill files not found at ${source}`);
  }
  const target = join(homedir(), ".claude", "skills", SKILL_NAME);
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  return target;
}
