import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore, type MemoryOptions } from "../src/memory.ts";

/**
 * resetSession 不得把已丢弃对话的预热摘要注入新会话。
 * 用法：node scripts/memory-reset-selftest.ts
 *
 * 1. 会话过阈值 → 后台预热写出摘要 → resetSession → sessionFor 摘要为空
 * 2. 不 reset 时，sessionFor 仍拿到预热摘要
 * 3. reset 发生在预热尚未完成时，新会话同样拿不到这份摘要
 * 4. 没有预热、走同步兜底压缩时：压缩进行中 reset，新会话摘要为空；不 reset 仍返回摘要
 */

const SUMMARY = "此前在讨论发布计划，决定下周上线。";
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

function deferred(): { promise: Promise<string>; resolve: (value: string) => void } {
  let resolve: (value: string) => void = () => {};
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function newStore(dir: string, summarize: MemoryOptions["summarize"]): MemoryStore {
  return new MemoryStore({
    dir,
    // 测试里把阈值压到很小，不改生产默认值。预算 = 30 token，约 90 字节就触发。
    contextWindow: 30,
    compressAt: 1,
    summarize,
    runText: async () => "",
    log: () => {},
  });
}

/** 写一份超过压缩阈值的会话文件，让 prefetch 会归档并预热。 */
function writeHotSession(dir: string, userId: string): void {
  writeFileSync(path.join(dir, `user-${userId}.jsonl`), "x".repeat(300));
}

function summaryFiles(dir: string): string[] {
  const archive = path.join(dir, "archive");
  return readdirSync(archive).filter((name) => name.endsWith(".summary.txt"));
}

const root = mkdtempSync(path.join(tmpdir(), "memory-reset-"));

try {
  console.log("[预热完成后 reset]");
  {
    const dir = path.join(root, "after-prefetch");
    const userId = "after";
    const memory = newStore(dir, async () => SUMMARY);
    writeHotSession(dir, userId);
    await memory.prefetch(userId);
    check("预热写出了摘要文件", summaryFiles(dir).length === 1, summaryFiles(dir).join(","));
    memory.resetSession(userId);
    const session = await memory.sessionFor(userId);
    check("reset 之后 sessionFor 摘要为空", session.summary === "", JSON.stringify(session.summary));
    check("新会话文件路径仍是该用户的会话文件", session.file === path.join(dir, `user-${userId}.jsonl`));
  }

  console.log("[不 reset，正常压缩路径]");
  {
    const dir = path.join(root, "no-reset");
    const userId = "keep";
    const memory = newStore(dir, async () => SUMMARY);
    writeHotSession(dir, userId);
    await memory.prefetch(userId);
    const session = await memory.sessionFor(userId);
    check("不 reset 时 sessionFor 拿到预热摘要", session.summary === SUMMARY, JSON.stringify(session.summary));
  }

  console.log("[预热进行中 reset]");
  {
    const dir = path.join(root, "in-flight");
    const userId = "flight";
    const gate = deferred();
    const memory = newStore(dir, () => gate.promise);
    writeHotSession(dir, userId);
    const pending = memory.prefetch(userId);
    check("预热已归档且摘要尚未落盘", summaryFiles(dir).length === 0 && !existsSync(path.join(dir, `user-${userId}.jsonl`)));
    // sessionFor 已经在等这份预热，随后才 reset，预热完成时不得把摘要交出去。
    const waiting = memory.sessionFor(userId);
    memory.resetSession(userId);
    gate.resolve(SUMMARY);
    const session = await waiting;
    await pending;
    check("预热最终写出了摘要文件", summaryFiles(dir).length === 1, summaryFiles(dir).join(","));
    check("预热进行中 reset 后，正在等的 sessionFor 摘要为空", session.summary === "", JSON.stringify(session.summary));
    const again = await memory.sessionFor(userId);
    check("预热完成后再次 sessionFor 仍然为空", again.summary === "", JSON.stringify(again.summary));
  }

  console.log("[预热进行中先 reset，完成后再开新会话]");
  {
    const dir = path.join(root, "in-flight-then-session");
    const userId = "later";
    const gate = deferred();
    const memory = newStore(dir, () => gate.promise);
    writeHotSession(dir, userId);
    const pending = memory.prefetch(userId);
    memory.resetSession(userId);
    gate.resolve(SUMMARY);
    await pending;
    check("完成后摘要文件在盘上", summaryFiles(dir).length === 1);
    const session = await memory.sessionFor(userId);
    check("预热完成之后的新会话摘要为空", session.summary === "", JSON.stringify(session.summary));
  }

  console.log("[同步兜底压缩]");
  {
    const dir = path.join(root, "sync-keep");
    const userId = "sync-keep";
    const memory = newStore(dir, async () => SUMMARY);
    writeHotSession(dir, userId);
    const session = await memory.sessionFor(userId);
    check("不 reset 时同步兜底返回摘要", session.summary === SUMMARY, JSON.stringify(session.summary));
    check("同步兜底把摘要落盘", summaryFiles(dir).length === 1, summaryFiles(dir).join(","));
  }

  {
    const dir = path.join(root, "sync-reset");
    const userId = "sync-reset";
    const gate = deferred();
    const memory = newStore(dir, () => gate.promise);
    writeHotSession(dir, userId);
    const waiting = memory.sessionFor(userId);
    memory.resetSession(userId);
    gate.resolve(SUMMARY);
    const session = await waiting;
    check("同步兜底进行中 reset，本次摘要为空", session.summary === "", JSON.stringify(session.summary));
    const again = await memory.sessionFor(userId);
    check("同步兜底完成后新会话摘要仍为空", again.summary === "", JSON.stringify(again.summary));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\nFAIL memory-reset-selftest（${failed} 项失败）`);
  process.exit(1);
}
console.log("\nPASS memory-reset-selftest");
