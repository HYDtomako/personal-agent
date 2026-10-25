import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BINARY_EXTS, DOC_EXTS, FORMAT_HINT, TEXT_EXTS, convertDocument, sniffDocExt } from "./docparse.ts";

/**
 * 上传附件落地：把 GUI 传上来的文件变成 pi 能吃的形式。
 *
 * pi 的附件只认图片与文本，所以：
 *  - 图片 → 原样以 @路径 交给 pi（多模态直接看）
 *  - 纯文本（txt/md/csv/json…）→ 原样交给 pi
 *  - PDF / Word / Excel / PPT → 先取文，落成 .md 再交给 pi
 *  - 其他（压缩包、音视频、旧版 Office）→ 如实拒绝，不要让模型硬猜
 */

export interface IngestOptions {
  /** 取文产物与临时文件的落地目录 */
  dir: string;
  log?: (...args: unknown[]) => void;
  /** 单个文件的文本上限（字符），超出截断 */
  maxTextChars?: number;
  /** 一条消息所有附件文本总量上限（字符） */
  maxTotalChars?: number;
  pdftotext?: string;
}

export interface Ingested {
  /** 以 @路径 交给 pi 的附件 */
  attach: string[];
  /** 给模型看的附件说明（进 prompt） */
  notes: string[];
  /** 读不了的，附带原因 */
  rejected: string[];
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const SUPPORTED_EXTS = new Set([...TEXT_EXTS, ...DOC_EXTS, ...IMAGE_EXTS]);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_DOC_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARS = 30_000;
const DEFAULT_MAX_TOTAL_CHARS = 60_000;

/** 取末尾扩展名（小写）。只有形如 "xxx.md" 的结尾才算，避免把 "报告 v1.2" 当后缀。 */
function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

/** 按文件头判断是不是图片（浏览器偶尔给不出扩展名）。 */
function isImageBytes(buf: Buffer): boolean {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "GIF8") return true;
  if (buf.length >= 12 && buf.toString("ascii", 8, 12) === "WEBP") return true;
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return true;
  return false;
}

/** 不支持时的拒绝理由（旧版 Office 单独提示，便于换格式重发）。 */
function rejectHint(ext: string): string {
  if (["doc", "xls", "ppt", "wps", "et", "dps"].includes(ext)) {
    return "旧版 Office 格式读不了，请另存为 docx/xlsx/pptx 或 PDF";
  }
  return BINARY_EXTS.has(ext) ? "这种二进制格式读不了" : `只支持 ${FORMAT_HINT}`;
}

/** 把上传的文件转成可交给 pi 的附件。 */
export async function ingestUploads(paths: string[], opts: IngestOptions): Promise<Ingested> {
  const { dir, log } = opts;
  mkdirSync(dir, { recursive: true });
  const maxTextChars = opts.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const maxTotalChars = opts.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;

  const attach: string[] = [];
  const notes: string[] = [];
  const rejected: string[] = [];
  let budget = maxTotalChars;

  for (const src of paths) {
    const name = path.basename(src);
    const ext = extOf(name);
    if (!existsSync(src)) {
      rejected.push(`${name}（文件不存在）`);
      continue;
    }
    let size = 0;
    try {
      size = statSync(src).size;
    } catch {
      rejected.push(`${name}（无法读取）`);
      continue;
    }

    let buf: Buffer;
    try {
      buf = readFileSync(src);
    } catch {
      rejected.push(`${name}（无法读取）`);
      continue;
    }

    // 图片：直接交给 pi 看
    if (IMAGE_EXTS.has(ext) || isImageBytes(buf)) {
      attach.push(src);
      notes.push(`${name}（图片，可直接查看）`);
      continue;
    }

    if (ext && !SUPPORTED_EXTS.has(ext)) {
      rejected.push(`${name}（${rejectHint(ext)}）`);
      continue;
    }

    const kind = ext || sniffDocExt(buf) || "";
    const limit = DOC_EXTS.has(kind) ? MAX_DOC_BYTES : MAX_TEXT_BYTES;
    if (size > limit) {
      rejected.push(`${name}（过大 ${Math.round(size / 1024)}KB，上限 ${Math.round(limit / 1024)}KB）`);
      continue;
    }
    if (budget <= 0) {
      rejected.push(`${name}（本条消息附件内容已达上限，请分开发送）`);
      continue;
    }

    if (TEXT_EXTS.has(kind)) {
      // 纯文本：pi 自己就能读，原样交过去
      const text = decodeText(buf);
      const clipped = text.length > Math.min(maxTextChars, budget);
      if (clipped) {
        const p = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${safeStem(name)}.md`);
        writeFileSync(p, text.slice(0, Math.min(maxTextChars, budget)), "utf8");
        attach.push(p);
        notes.push(`${name}（文本，过长已截断，只读了前 ${Math.min(maxTextChars, budget)} 字）`);
      } else {
        attach.push(src);
        notes.push(`${name}（文本）`);
      }
      budget -= Math.min(text.length, Math.min(maxTextChars, budget));
      continue;
    }

    // 文档：先取文
    const conv = await convertDocument(buf, kind, {
      maxChars: Math.min(maxTextChars, budget),
      workDir: dir,
      pdftotext: opts.pdftotext,
    });
    if (!conv.ok) {
      rejected.push(`${name}（${conv.reason}）`);
      log?.(`[upload] ${name} 未能取文：${conv.reason}`);
      continue;
    }
    budget -= conv.text.length;
    const p = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${safeStem(name)}.md`);
    writeFileSync(p, conv.text, "utf8");
    attach.push(p);
    notes.push(`${name}（已转换成文本${conv.note ? `：${conv.note}` : ""}）`);
    log?.(`[upload] ${name} 已取文（${Math.round(size / 1024)}KB → ${conv.text.length} 字）${conv.note ? `｜${conv.note}` : ""}`);
  }

  return { attach, notes, rejected };
}

/** 文本解码：UTF-8 优先，出现替换符则退回 GBK/UTF-16。 */
function decodeText(buf: Buffer): string {
  const utf8 = buf.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("gbk").decode(buf);
  } catch {
    return utf8;
  }
}

function safeStem(name: string): string {
  return (
    (name.replace(/\.[^.]+$/, "") || "文件")
      .replace(/[\\/:*?"<>|\s]+/g, "_")
      .replace(/[._-]+$/, "")
      .slice(0, 60) || "文件"
  );
}
