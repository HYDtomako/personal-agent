import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..");
// Explicit allowlist: no live model, platform messages, or production runtime.
const commands = [
  ["--test", "scripts/diagnostics-selftest.mjs"],
  ["scripts/requests-selftest.mjs"], ["--test", "scripts/telegram-selftest.mjs"],
  ["scripts/runner-background-selftest.mjs"], ["scripts/delegations-selftest.mjs"], ["scripts/background-selftest.mjs"],
];
for (const name of ["server-security", "runner", "context"]) {
  const file = "scripts/" + name + "-selftest.mjs";
  if (existsSync(path.join(root, file))) commands.unshift(["--test", file]);
}
for (const args of commands) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
