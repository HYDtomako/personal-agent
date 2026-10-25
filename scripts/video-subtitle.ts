import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { VideoAnalyzer } from "../src/video.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const url = process.argv[2] ?? "";

function write(payload: unknown, code: number): never {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(code);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  write({ ok: true, usage: "node scripts/video-subtitle.ts <公开视频链接>" }, 0);
}
if (!url.trim()) write({ ok: false, error: "缺少视频链接。" }, 2);

try {
  const config = loadConfig(path.join(root, "config.json"));
  if (config.video?.enabled === false) write({ ok: false, error: "视频字幕功能未启用。" }, 2);
  const analyzer = new VideoAnalyzer({
    workspaceDir: path.resolve(root, config.agent?.workspace ?? "workspace"),
    ytDlp: config.video?.ytDlp,
    proxy: config.video?.proxy ?? config.telegram?.proxy,
    maxDurationSec: config.video?.maxDurationSec,
    maxTranscriptChars: config.video?.maxTranscriptChars,
    timeoutMs: config.video?.timeoutMs,
    keepArtifacts: config.video?.keepArtifacts,
    log: (...args) => console.error(...args),
  });
  const analysis = await analyzer.analyze(url);
  try {
    write({
      ok: true,
      url: analysis.url,
      title: analysis.title,
      durationSec: analysis.durationSec,
      transcript: readFileSync(analysis.transcriptPath, "utf8"),
    }, 0);
  } finally {
    analysis.cleanup();
  }
} catch (err) {
  write({ ok: false, error: err instanceof Error ? err.message : String(err) }, 1);
}
