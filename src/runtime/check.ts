import { dirname, resolve } from "node:path";
import { loadAgentYaml, resolveRunbookPath } from "../config/yaml.js";
import { AcpSession } from "./session.js";
import { providerSpec } from "./providers.js";
import type { ProviderDeclaration } from "../types.js";

type CheckResult = { ok: true; note: string } | { ok: false; reason: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function checkProvider(
  id: string,
  declared: Record<string, ProviderDeclaration>,
  cwd: string,
): Promise<CheckResult> {
  const spec = providerSpec(id, declared);
  let session: AcpSession;
  try {
    session = await AcpSession.spawn(spec, { cwd, model: spec.model, quiet: true });
  } catch (error) {
    return { ok: false, reason: messageOf(error) };
  }
  try {
    const offered = session.offeredModels;
    if (offered.some((option) => option.value === spec.model || option.name === spec.model)) {
      return { ok: true, note: spec.model };
    }
    const values = offered.map((option) => option.value).join(", ");
    return { ok: true, note: `${spec.model}; not in the harness's list: ${values}` };
  } finally {
    await session.close();
  }
}

export async function checkCommand(target: string): Promise<number> {
  let yamlPath: string;
  let providers: Record<string, ProviderDeclaration>;
  try {
    yamlPath = resolve(resolveRunbookPath(target));
    providers = loadAgentYaml(yamlPath).providers ?? {};
  } catch (error) {
    console.error(messageOf(error));
    return 1;
  }
  const ids = Object.keys(providers);
  const results = await Promise.all(ids.map((id) => checkProvider(id, providers, dirname(yamlPath))));
  ids.forEach((id, index) => {
    const result = results[index];
    if (result.ok) console.log(`ok ${id} (${result.note})`);
    else console.error(`fail ${id}: ${result.reason}`);
  });
  return results.every((result) => result.ok) ? 0 : 1;
}
