import type { ProviderDeclaration, ProviderId } from "../types.js";

export interface ProviderSpec {
  id: ProviderId;
  command: string;
  args: string[];
  model: string;
}

export function providerSpec(
  provider: ProviderId,
  declared: Record<string, ProviderDeclaration> = {},
): ProviderSpec {
  const entry = declared[provider];
  if (!entry) {
    const known = Object.keys(declared).sort().join(", ") || "none";
    throw new Error(`unknown provider "${provider}" (known: ${known})`);
  }
  return { id: provider, ...entry, args: [...(entry.args ?? [])] };
}
