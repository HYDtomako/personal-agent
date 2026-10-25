import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractVideoUrl, hasVideoIntent, isHttpUrl, isKnownVideoUrl } from "../src/video.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

console.log("[视频链接]");
check("识别 B 站链接", isKnownVideoUrl("https://www.bilibili.com/video/BV1xx"));
check("识别短链接", isKnownVideoUrl("https://b23.tv/abc"));
check("识别 YouTube 链接", isKnownVideoUrl("https://youtu.be/example"));
check("识别其他常见平台", isKnownVideoUrl("https://vimeo.com/123456"));
check("未知平台带视频意图可提取", extractVideoUrl("请总结这个视频：https://example.com/video/123") === "https://example.com/video/123");
check("未知平台无视频意图不触发", extractVideoUrl("请看看这个网页：https://example.com/article") === undefined);
check("视频意图可识别", hasVideoIntent("请读取字幕并总结"));
check("只接受 http 链接", isHttpUrl("https://example.com/video"));
check("拒绝非 http 链接", !isHttpUrl("javascript:alert(1)"));

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const extPath = pathToFileURL(path.join(root, "workspace", ".pi", "extensions", "video-subtitle-tools.ts")).href;
const tools: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> = [];
const extMod = (await import(extPath)) as { default: (pi: { registerTool: (t: (typeof tools)[number]) => void }) => void };
extMod.default({ registerTool: (tool) => tools.push(tool) });
check("视频字幕工具已注册", tools.some((tool) => tool.name === "video_subtitle"));

const bad = spawnSync(process.execPath, [path.join(root, "scripts", "video-subtitle.ts")], { cwd: root, encoding: "utf8" });
const badJson = JSON.parse((bad.stdout || "{}").trim() || "{}") as { ok?: boolean; error?: string };
check("字幕入口拒绝空链接", bad.status === 2 && badJson.ok === false && !!badJson.error, badJson.error ?? "");

console.log(failed === 0 ? "\n全部通过。" : `\n${failed} 项失败。`);
process.exit(failed === 0 ? 0 : 1);
