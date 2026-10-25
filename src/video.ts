import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

export interface VideoAnalyzerOptions {
  workspaceDir: string;
  ytDlp?: string;
  proxy?: string;
  maxDurationSec?: number;
  maxTranscriptChars?: number;
  timeoutMs?: number;
  keepArtifacts?: boolean;
  log?: (...args: unknown[]) => void;
}

export type VideoJobState = "queued" | "processing" | "completed" | "failed";

export interface VideoJobStatus {
  jobId: string;
  state: VideoJobState;
  url: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  reply?: string;
  error?: string;
}

export interface VideoAnalysis {
  url: string;
  title: string;
  durationSec?: number;
  transcriptPath: string;
  cleanup: () => void;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface VideoMetadata {
  title?: string;
  duration?: number;
  uploader?: string;
  channel?: string;
  chapters?: Array<{ title?: string; start_time?: number; end_time?: number }>;
}

const KNOWN_VIDEO_HOSTS = new Set([
  "b23.tv",
  "bilibili.com",
  "bilibili.tv",
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "vimeo.com",
  "dailymotion.com",
  "twitch.tv",
  "douyin.com",
  "ixigua.com",
  "kuaishou.com",
  "tiktok.com",
  "nicovideo.jp",
  "rutube.ru",
  "streamable.com",
  "ted.com",
]);
const SUBTITLE_EXTS = new Set([".vtt", ".srt"]);
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_DURATION_SEC = 2 * 60 * 60;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 30_000;

export function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isKnownVideoUrl(raw: string): boolean {
  if (!isHttpUrl(raw)) return false;
  const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  return [...KNOWN_VIDEO_HOSTS].some((item) => host === item || host.endsWith(`.${item}`));
}

export function hasVideoIntent(text: string): boolean {
  return /视频|字幕|影片|录像|讲了什么|说了什么|说了啥|总结.{0,12}(链接|视频|字幕)|链接.{0,12}(视频|字幕)/i.test(text);
}

export function extractVideoUrl(text: string): string | undefined {
  const candidates = text.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];
  for (const candidate of candidates) {
    const cleaned = candidate.replace(/[),，。！？；：]+$/g, "");
    if (isKnownVideoUrl(cleaned) || (hasVideoIntent(text) && isHttpUrl(cleaned))) return cleaned;
  }
  return undefined;
}

export class VideoAnalyzer {
  private readonly opts: Required<Pick<VideoAnalyzerOptions, "workspaceDir">> & VideoAnalyzerOptions;

  constructor(opts: VideoAnalyzerOptions) {
    this.opts = opts;
  }

  async analyze(rawUrl: string): Promise<VideoAnalysis> {
    const url = normalizeUrl(rawUrl);
    const jobDir = path.join(this.opts.workspaceDir, "video-jobs", `${Date.now()}-${randomUUID().slice(0, 8)}`);
    mkdirSync(jobDir, { recursive: true });
    const cleanup = (): void => {
      if (this.opts.keepArtifacts) return;
      try {
        rmSync(jobDir, { recursive: true, force: true });
      } catch {
        this.opts.log?.(`[video] 清理临时目录失败：${jobDir}`);
      }
    };

    try {
      const metadata = await this.readMetadata(url, jobDir);
      this.checkLimits(metadata);
      const subtitlePath = await this.downloadSubtitles(url, jobDir);
      if (!subtitlePath) throw new Error("这个视频没有可读取的字幕；当前 pa 只支持有字幕的视频。");
      const transcript = parseSubtitle(readFileSync(subtitlePath, "utf8"));
      if (!transcript.trim()) throw new Error("字幕文件为空；当前 pa 只支持有文字内容的字幕。");

      const clipped = clipTranscript(transcript, this.opts.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS);
      const transcriptPath = path.join(jobDir, "transcript.md");
      writeFileSync(transcriptPath, buildTranscript(metadata, url, clipped), "utf8");

      this.opts.log?.(`[video] 已准备字幕材料：${metadata.title ?? url}，字幕 ${clipped.length} 字`);
      return {
        url,
        title: metadata.title?.trim() || url,
        durationSec: finiteNumber(metadata.duration),
        transcriptPath,
        cleanup,
      };
    } catch (err) {
      cleanup();
      throw new Error(`视频材料准备失败：${errorMessage(err)}`);
    }
  }

  private async readMetadata(url: string, cwd: string): Promise<VideoMetadata> {
    const result = await this.run(this.ytDlp(), [
      ...this.ytArgs(),
      "--dump-single-json",
      "--skip-download",
      url,
    ], cwd);
    if (result.timedOut) throw new Error("读取视频信息超时。");
    if (result.code !== 0) throw new Error(commandFailure("yt-dlp 读取视频信息失败", result));
    const lines = result.stdout.trim().split(/\r?\n/).reverse();
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as VideoMetadata;
        if (parsed && typeof parsed === "object") return parsed;
      } catch {
        continue;
      }
    }
    throw new Error("yt-dlp 没有返回有效的视频信息。");
  }

  private checkLimits(metadata: VideoMetadata): void {
    const duration = finiteNumber(metadata.duration);
    const maxDuration = this.opts.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC;
    if (duration !== undefined && duration > maxDuration) {
      throw new Error(`视频时长约 ${formatDuration(duration)}，超过上限 ${formatDuration(maxDuration)}。`);
    }
  }

  private async downloadSubtitles(url: string, cwd: string): Promise<string | undefined> {
    const result = await this.run(this.ytDlp(), [
      ...this.ytArgs(),
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      "all",
      "--sub-format",
      "vtt",
      "--output",
      path.join(cwd, "source.%(ext)s"),
      url,
    ], cwd);
    const files = listFiles(cwd).filter((file) => SUBTITLE_EXTS.has(path.extname(file).toLowerCase()));
    if (files.length) return chooseSubtitle(files);
    if (result.code !== 0 && result.stderr.trim()) this.opts.log?.(`[video] 没有可用字幕：${result.stderr.trim().slice(-300)}`);
    return undefined;
  }

  private ytDlp(): string {
    return this.opts.ytDlp?.trim() || "yt-dlp";
  }

  private ytArgs(): string[] {
    const args = ["--ignore-config", "--no-playlist", "--no-warnings", "--no-color"];
    if (this.opts.proxy?.trim()) args.push("--proxy", this.opts.proxy.trim());
    return args;
  }

  private run(command: string, args: string[], cwd: string): Promise<CommandResult> {
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const env = { ...process.env };
    if (this.opts.proxy?.trim()) {
      env.HTTP_PROXY = this.opts.proxy.trim();
      env.HTTPS_PROXY = this.opts.proxy.trim();
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      const finish = (result: CommandResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      child.stdout.on("data", (data: Buffer) => {
        if (stdout.length < 5_000_000) stdout += data.toString("utf8");
      });
      child.stderr.on("data", (data: Buffer) => {
        if (stderr.length < 20_000) stderr += data.toString("utf8");
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err.code === "ENOENT") reject(new Error(`找不到可执行文件：${command}`));
        else reject(err);
      });
      child.on("exit", (code) => finish({ code, stdout, stderr, timedOut }));
    });
  }
}

function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (!isHttpUrl(value)) throw new Error("视频链接必须是 http 或 https 地址。");
  const url = new URL(value);
  url.username = "";
  url.password = "";
  return url.href;
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).map((name) => path.join(dir, name));
}

function chooseSubtitle(files: string[]): string {
  return [...files].sort((a, b) => subtitleScore(a) - subtitleScore(b))[0];
}

function subtitleScore(file: string): number {
  const name = path.basename(file).toLowerCase();
  if (/\.zh(?:[-_](?:hans|cn|chs))?\./.test(name)) return 0;
  if (/\.zh/.test(name)) return 1;
  if (/\.en/.test(name)) return 2;
  if (/\.ja/.test(name)) return 3;
  if (/\.ko/.test(name)) return 4;
  return 10;
}

function parseSubtitle(raw: string): string {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  const output: string[] = [];
  let time = "";
  let cue: string[] = [];
  const flush = (): void => {
    const text = cue
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/\{\\[^}]+\}/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text && text !== output.at(-1)?.replace(/^\[[^\]]+\]\s*/, "")) output.push(`${time ? `[${time}] ` : ""}${text}`);
    time = "";
    cue = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    if (/^(WEBVTT|NOTE|STYLE|REGION|Kind:|Language:)/i.test(trimmed)) continue;
    const match = /^(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)\s*-->/.exec(trimmed);
    if (match) {
      flush();
      time = match[1];
      continue;
    }
    if (/^\d+$/.test(trimmed) && cue.length === 0) continue;
    cue.push(trimmed);
  }
  flush();
  return output.join("\n").trim();
}

function buildTranscript(metadata: VideoMetadata, url: string, transcript: string): string {
  const lines = [
    `# 视频材料`,
    `标题：${metadata.title?.trim() || "未知"}`,
    metadata.uploader || metadata.channel ? `作者：${metadata.uploader ?? metadata.channel}` : "",
    metadata.duration ? `时长：${formatDuration(metadata.duration)}` : "",
    `来源：${url}`,
  ].filter(Boolean);
  if (metadata.chapters?.length) {
    lines.push("章节：");
    for (const chapter of metadata.chapters) {
      if (chapter.title) lines.push(`- ${formatDuration(chapter.start_time ?? 0)} ${chapter.title}`);
    }
  }
  lines.push("", "## 视频字幕", transcript);
  return `${lines.join("\n")}\n`;
}

function clipTranscript(text: string, maxChars: number): string {
  const limit = Math.max(1000, Math.floor(maxChars));
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[转写过长，已截断，以上为前 ${limit} 字]`;
}

function commandFailure(prefix: string, result: CommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `退出码 ${result.code}`;
  return `${prefix}：${detail.slice(-800)}`;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}小时${m}分${s}秒` : `${m}分${s}秒`;
}

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
