/**
 * 应用叫什么：以页面标题（public/index.html 的 <title>）为准——
 * 他改页面名，快捷方式和弹窗标题跟着变，不用两边各改一遍。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function appName(): string {
  try {
    const html = readFileSync(path.join(root, "public", "index.html"), "utf8");
    const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
    if (title) return title;
  } catch {
    /* 读不到就用默认 */
  }
  return "个人助手";
}
