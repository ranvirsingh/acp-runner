import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: bun scripts/checksum.ts <file>");
  process.exitCode = 1;
} else {
  const abs = resolve(file);
  const hex = createHash("sha256").update(readFileSync(abs)).digest("hex");
  writeFileSync(`${abs}.sha256`, `${hex}  ${basename(abs)}\n`);
  console.log(`${hex}  ${basename(abs)}`);
}
