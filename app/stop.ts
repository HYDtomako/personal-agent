#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireInstance, stopProjectProcesses } from "./runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = await acquireInstance(root, "operation", 45_000);
if (!lock) {
  console.error("另一个 PA 启停操作尚未完成，请稍后重试。");
  process.exit(1);
}
try {
  await stopProjectProcesses(root);
  console.log("PA 主服务与 Telegram 桥接均已停止；未操作 QQbot 或其他项目。");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await lock.release();
}
