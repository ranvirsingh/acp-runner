import { execFileSync } from "node:child_process";

if (process.platform === "darwin") {
  execFileSync("codesign", ["--force", "--sign", "-", process.argv[2]], { stdio: "inherit" });
}
