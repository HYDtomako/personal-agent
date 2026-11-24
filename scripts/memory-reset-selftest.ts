import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "../src/memory.ts";

/**
 * 短期会话留在 Pi 的同一份 JSONL 里。
 * 用法：node scripts/memory-reset-selftest.ts
 *
 * 1. 200KB 的当前会话在 sessionFor（含第二次）后仍在原位
 * 2. 更早的归档 jsonl 和它的 .summary.txt 不被碰
 * 3. resetSession 只把当前文件改名进 archive/，不删旧归档、不删旧摘要
 * 4. 当前文件已经不在时，再次 resetSession 不抛、也不再添一份归档
 * 5. src/main.ts 与 src/memory.ts 不再做整文件压缩
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

const root = mkdtempSync(path.join(tmpdir(), "memory-reset-"));

try {
  const dir = path.join(root, "memory");
  const userId = "me";
  const memory = new MemoryStore({
    dir,
    runText: async () => "",
    log: () => {},
  });
  const live = path.join(dir, `user-${userId}.jsonl`);
  const payload = "x".repeat(200 * 1024);
  writeFileSync(live, payload);

  const oldName = `user-${userId}-2020-01-01T00-00-00-000Z.jsonl`;
  const oldArchive = path.join(memory.archiveDir, oldName);
  const oldSummary = `${oldArchive}.summary.txt`;
  const oldArchiveBody = "old-archive-bytes";
  const oldSummaryBody = "old summary that must stay";
  writeFileSync(oldArchive, oldArchiveBody);
  writeFileSync(oldSummary, oldSummaryBody);
  const archivesBefore = readdirSync(memory.archiveDir).sort();

  console.log("[sessionFor 不搬动当前会话]");
  const first = await memory.sessionFor(userId);
  const second = await memory.sessionFor(userId);
  check("两次 sessionFor 都指向同一份会话文件", first.file === live && second.file === live, second.file);
  check(
    "200KB 会话在两次 sessionFor 后仍在原位",
    existsSync(live) && readFileSync(live, "utf8") === payload,
    existsSync(live) ? `${readFileSync(live).length} bytes` : "missing",
  );
  check(
    "sessionFor 不新增归档",
    JSON.stringify(readdirSync(memory.archiveDir).sort()) === JSON.stringify(archivesBefore),
  );
  check(
    "旧归档与旧摘要在 sessionFor 后未改",
    readFileSync(oldArchive, "utf8") === oldArchiveBody && readFileSync(oldSummary, "utf8") === oldSummaryBody,
  );

  console.log("[resetSession 只改名当前文件]");
  memory.resetSession(userId);
  check("当前会话文件已被移走", !existsSync(live));
  const names = readdirSync(memory.archiveDir).sort();
  const added = names.filter((name) => !archivesBefore.includes(name));
  check("只新增一份归档", added.length === 1, added.join(","));
  const addedName = added[0] ?? "";
  const stamp = /^\d{4}-\d{2}-\d{2}T[\d-]+Z\.jsonl$/;
  check(
    "新归档名是 user-<id>-<ISO 时间戳>.jsonl",
    addedName.startsWith(`user-${userId}-`) && stamp.test(addedName.slice(`user-${userId}-`.length)),
    addedName,
  );
  check(
    "新归档内容就是原来的 200KB 会话",
    addedName !== "" && readFileSync(path.join(memory.archiveDir, addedName), "utf8") === payload,
  );
  check("没有写出新的 .summary.txt", names.filter((name) => name.endsWith(".summary.txt")).join(",") === `${oldName}.summary.txt`);
  check("旧归档仍在且内容未改", existsSync(oldArchive) && readFileSync(oldArchive, "utf8") === oldArchiveBody);
  check("旧摘要仍在且内容未改", existsSync(oldSummary) && readFileSync(oldSummary, "utf8") === oldSummaryBody);

  console.log("[没有当前文件时再次 reset]");
  const afterFirstReset = readdirSync(memory.archiveDir).sort();
  let threw = false;
  try {
    memory.resetSession(userId);
  } catch (error) {
    threw = true;
    check("再次 reset 不抛", false, error instanceof Error ? error.message : String(error));
  }
  if (!threw) check("再次 reset 不抛", true);
  check(
    "再次 reset 不新增归档",
    JSON.stringify(readdirSync(memory.archiveDir).sort()) === JSON.stringify(afterFirstReset),
  );

  console.log("[生产代码不再整文件压缩]");
  const forbidden = ["COMPRESS_PROMPT", "prefetch(", "cleanupArchives", "summarizeSession", "此前对话摘要"];
  for (const file of ["src/main.ts", "src/memory.ts"]) {
    const text = readFileSync(path.join(repoRoot, file), "utf8");
    for (const needle of forbidden) {
      check(`${file} 不再包含 ${needle}`, !text.includes(needle));
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\nFAIL memory-reset-selftest（${failed} 项失败）`);
  process.exit(1);
}
console.log("\nPASS memory-reset-selftest");
