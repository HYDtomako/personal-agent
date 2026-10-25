import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

/**
 * 文档取文：把用户发来的文档转成纯文本，交给 pi 当文本附件读。
 *
 * pi 的 @路径 附件只认「图片（多模态）」与「文本（原样内联）」两类，
 * 所以 pdf / word / excel / ppt 必须先在这里转成文本。
 * 转换全部本地完成：OOXML（docx/xlsx/pptx 就是 zip+xml）用 Node 自带 zlib 解压，
 * PDF 交给系统里的 pdftotext（Git for Windows 自带，无需额外安装）。
 */

// ── 支持范围 ──

/** 纯文本类：按文本直接读，不做转换 */
export const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "text", "log",
  "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "xml",
  "ini", "cfg", "conf", "properties", "srt", "vtt", "sql", "tex", "bib",
]);

/** 需要转换成文本的文档类 */
export const DOC_EXTS = new Set([
  "pdf",
  "docx", "docm", "dotx", // Word
  "xlsx", "xlsm", // Excel
  "pptx", "pptm", "ppsx", // PowerPoint
  "html", "htm",
]);

/** 明确不支持的二进制/压缩包（给出诚实的拒绝理由，而不是把二进制喂给 pi） */
export const BINARY_EXTS = new Set([
  "doc", "xls", "ppt", "wps", "et", "dps", // 旧版 Office（二进制格式）
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz",
  "exe", "msi", "dll", "apk", "iso",
  "mp3", "wav", "flac", "m4a", "mp4", "avi", "mkv", "mov", "flv", "webm",
  "psd", "ai", "sketch", "ttf", "otf", "woff", "woff2", "db", "sqlite",
]);

export const FORMAT_HINT = "文本（txt/md/csv/json 等）、PDF、Word、Excel、PPT、网页（html）";

/** zip 容器承载的文档格式（解压后从里面取 XML 正文） */
const ZIP_DOC_EXTS = new Set(["docx", "docm", "dotx", "xlsx", "xlsm", "pptx", "pptm", "ppsx"]);

export interface ConvertOpts {
  /** 转换结果超过此字符数则截断（控上下文成本） */
  maxChars: number;
  /** 临时文件目录（pdftotext 需要先落地 pdf） */
  workDir: string;
  /** pdftotext 可执行文件路径；不传则自动查找 */
  pdftotext?: string;
}

export type ConvertResult =
  | { ok: true; text: string; note: string }
  | { ok: false; reason: string };

// ── 文本解码：UTF-8 → GBK → UTF-16 兜底（QQ 上传的中文 txt 常是 GBK）──

export interface DecodedText {
  text: string;
  encoding: string;
}

/** 判断解码结果像不像纯文本：无 NUL、几乎无控制字符。 */
function looksLikeText(s: string): boolean {
  if (s.includes("\0")) return false;
  const bad = [...s].filter((ch) => ch < " " && ch !== "\n" && ch !== "\r" && ch !== "\t").length;
  return bad / Math.max(1, s.length) < 0.01;
}

function decodeWith(buf: Buffer, encoding: string): string | null {
  try {
    const s = new TextDecoder(encoding, { fatal: encoding !== "gbk" }).decode(buf);
    return s.includes("\uFFFD") ? null : s;
  } catch {
    return null;
  }
}

/** 把字节流解成文本；解不出（二进制）返回 null。 */
export function decodePlainText(buf: Buffer): DecodedText | null {
  if (buf.length === 0) return null;
  // 带 BOM 的 UTF-16 先处理
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    const s = decodeWith(buf.subarray(2), "utf-16le");
    return s && looksLikeText(s) ? { text: stripBom(s), encoding: "utf-16le" } : null;
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const s = decodeWith(buf.subarray(2), "utf-16be");
    return s && looksLikeText(s) ? { text: stripBom(s), encoding: "utf-16be" } : null;
  }
  const utf8 = decodeWith(buf, "utf-8");
  if (utf8 && looksLikeText(utf8)) return { text: stripBom(utf8), encoding: "utf-8" };
  // UTF-8 解不出（中文 txt 常见 GBK/GB18030）
  const gbk = decodeWith(buf, "gbk");
  if (gbk && looksLikeText(gbk)) return { text: stripBom(gbk), encoding: "gbk" };
  return null;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// ── 按内容嗅探真实格式（上传的文件名可能没有扩展名，或者跟内容对不上）──

export function sniffDocExt(buf: Buffer): string | null {
  if (buf.length >= 5 && buf.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
    // zip 容器：看它其实是哪种 OOXML
    try {
      const names = [...readZip(buf).keys()];
      if (names.includes("word/document.xml")) return "docx";
      if (names.includes("xl/workbook.xml")) return "xlsx";
      if (names.some((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) return "pptx";
    } catch {
      /* 不是能读的 zip */
    }
    return null;
  }
  if (/^\s*<(!doctype|html|xml|\?xml)/i.test(buf.toString("utf8", 0, Math.min(512, buf.length)))) return "html";
  return null;
}

// ── zip 读取（OOXML 容器）──

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function readZipEntry(buf: Buffer, local: number, method: number, csize: number): Buffer | null {
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(local + 26);
  const extraLen = buf.readUInt16LE(local + 28);
  const start = local + 30 + nameLen + extraLen;
  if (start >= buf.length) return null;
  // 长度以中央目录为准（本地头在流式写入时为 0，真实值放在数据描述符里）
  const end = csize > 0 ? Math.min(start + csize, buf.length) : buf.length;
  const raw = buf.subarray(start, end);
  try {
    return method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
  } catch {
    return null;
  }
}

/** 读 zip 全部条目（跳过目录条目与坏条目）。 */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("不是 zip 容器");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!name || name.endsWith("/")) continue;
    const data = readZipEntry(buf, local, method, csize);
    if (data) entries.set(name, data);
  }
  return entries;
}

// ── XML 文本提取 ──

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** 压缩多余空行与行尾空白。 */
export function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 截断到 maxChars，返回是否被截断。 */
function capText(s: string, maxChars: number): { text: string; truncated: boolean } {
  if (s.length <= maxChars) return { text: s, truncated: false };
  return { text: s.slice(0, maxChars), truncated: true };
}

const TAG_RE = /<(\/?)([A-Za-z0-9:_-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
  return m ? m[1] ?? m[2] ?? "" : null;
}

/**
 * Word（word/document.xml）取文：按段落/表格单元切分，标题转 Markdown 标题、列表转 "- "。
 * 只取 `<w:t>` 正文（忽略域代码、修订删除内容）。
 */
export function docxToText(xml: string): string {
  const out: string[] = [];
  let line = "";
  let inText = 0; // 处于 <w:t> 内才收字
  let tableDepth = 0;
  let heading = 0;
  let listItem = false;

  const flush = (): void => {
    const body = line.replace(/[ \t]+$/, "").trim();
    if (body) {
      const prefix = heading ? `${"#".repeat(heading)} ` : listItem ? "- " : "";
      out.push(prefix + body);
    } else if (out.length && !tableDepth && out[out.length - 1] !== "") {
      out.push(""); // 空段落 → 空行，保留原文分段
    }
    line = "";
    heading = 0;
    listItem = false;
  };

  /** 段落结束：表格里同一行的单元格用制表符并排，正文里则另起一行。 */
  const endParagraph = (): void => {
    if (tableDepth > 0) {
      if (line.trim()) line += "\t";
    } else {
      flush();
    }
  };

  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(xml); m; m = TAG_RE.exec(xml)) {
    const [, close, rawTag, attrs, selfClose, textNode] = m;
    if (textNode !== undefined) {
      if (inText > 0) line += decodeEntities(textNode);
      continue;
    }
    const tag = rawTag.toLowerCase();
    const self = selfClose === "/";
    if (tag === "w:t") {
      if (!close && !self) inText++;
      else if (close && inText > 0) inText--;
      continue;
    }
    if (!close) {
      if (tag === "w:tbl") {
        if (line.trim()) flush();
        tableDepth++;
      } else if (tag === "w:tr") {
        if (line.trim()) flush();
      } else if (tag === "w:p") {
        if (line.trim()) endParagraph();
      } else if (tag === "w:pstyle") {
        const v = attr(attrs, "w:val") ?? "";
        const h = /^(?:heading|标题)?\s*([1-6])$/i.exec(v.trim());
        if (h) heading = Number(h[1]);
        else if (/^heading/i.test(v)) heading = 2;
      } else if (tag === "w:outlinelvl") {
        const v = Number(attr(attrs, "w:val") ?? "");
        if (Number.isFinite(v) && v >= 0 && v <= 5 && !heading) heading = v + 1;
      } else if (tag === "w:numpr") {
        listItem = true;
      } else if (tag === "w:tab") {
        line += "\t";
      } else if (tag === "w:br" || tag === "w:cr") {
        line += "\n";
      } else if (tag === "w:drawing" || tag === "w:pict" || tag === "w:object") {
        if (!line.includes("[图片]")) line += "[图片]";
      }
      continue;
    }
    // 闭合标签
    if (tag === "w:p") {
      // 表格里先不换行：等 </w:tc> 决定是同格续写还是换列
      if (tableDepth === 0) flush();
    } else if (tag === "w:tc") {
      if (tableDepth > 0 && line.trim() && !line.endsWith("\t")) line += "\t";
    } else if (tag === "w:tr") {
      flush();
    } else if (tag === "w:tbl") {
      flush();
      if (tableDepth > 0) tableDepth--;
      if (out.length && out[out.length - 1] !== "") out.push("");
    }
  }
  flush();
  return normalizeText(out.join("\n"));
}

/** PowerPoint（ppt/slides/slideN.xml）取文：按页给出文本。 */
export function pptxSlideToText(xml: string): string {
  const out: string[] = [];
  let line = "";
  let inText = 0;
  const flush = (): void => {
    const body = line.trim();
    if (body) out.push(body);
    line = "";
  };
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(xml); m; m = TAG_RE.exec(xml)) {
    const [, close, rawTag, , selfClose, textNode] = m;
    if (textNode !== undefined) {
      if (inText > 0) line += decodeEntities(textNode);
      continue;
    }
    const tag = rawTag.toLowerCase();
    const self = selfClose === "/";
    if (tag === "a:t") {
      if (!close && !self) inText++;
      else if (close && inText > 0) inText--;
    } else if (tag === "a:br") {
      line += "\n";
    } else if (tag === "a:p" && close) {
      flush();
    }
  }
  flush();
  return normalizeText(out.join("\n"));
}

export function pptxToText(zip: Map<string, Buffer>): string {
  const slides = [...zip.keys()]
    .map((name) => ({ name, n: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => a.n - b.n);
  const parts: string[] = [];
  for (const s of slides) {
    const body = pptxSlideToText(zip.get(s.name)!.toString("utf8"));
    parts.push(`## 第 ${s.n} 页\n${body || "（本页无文字）"}`);
  }
  return normalizeText(parts.join("\n\n"));
}

// ── Excel ──

function colIndex(ref: string): number {
  const m = /^([A-Z]+)/.exec(ref);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 内置日期/时间数字格式（Excel 规范），用于把序列号还原成日期。 */
const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function excelSerialToDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  const d = new Date(ms);
  if (!Number.isFinite(ms) || d.getUTCFullYear() < 1900) return String(serial);
  const p = (n: number) => String(n).padStart(2, "0");
  const ymd = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const hms = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  return hms === "00:00:00" ? ymd : `${ymd} ${hms}`;
}

/** 每列的 cellXfs 索引 → 是否日期格式。 */
function dateStyleFlags(stylesXml: string | undefined): boolean[] {
  if (!stylesXml) return [];
  const custom = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const id = Number(attr(m[1], "numFmtId") ?? "");
    const code = attr(m[1], "formatCode");
    if (Number.isFinite(id) && code) custom.set(id, decodeEntities(code));
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? "";
  return [...xfs.matchAll(/<xf\b([^>]*)\/?>/g)].map((m) => {
    const id = Number(attr(m[1], "numFmtId") ?? "0");
    if (BUILTIN_DATE_FMT.has(id)) return true;
    const code = custom.get(id);
    if (!code) return false;
    // 自定义格式里同时含 年月日 占位符才算日期（避开 0.00 之类）
    const bare = code.replace(/\[[^\]]*\]|"[^"]*"/g, "");
    return /[ymd]/i.test(bare) && !/^[#0.,%\s]*$/.test(bare);
  });
}

export function xlsxSheetToTable(xml: string, shared: string[], dateStyles: boolean[], maxRows: number): { text: string; omitted: number } {
  const rows: string[] = [];
  let total = 0;
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    total++;
    if (rows.length >= maxRows) continue;
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] ?? "";
      const t = attr(attrs, "t") ?? "";
      let val = "";
      if (t === "s") {
        const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "-1");
        val = shared[idx] ?? "";
      } else if (t === "inlineStr") {
        val = decodeEntities([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));
      } else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (raw === undefined) continue;
        val = decodeEntities(raw).trim();
        if (t === "b") val = val === "1" ? "TRUE" : "FALSE";
        else if (t === "" && val !== "" && Number.isFinite(Number(val))) {
          const styleIdx = Number(attr(attrs, "s") ?? "-1");
          if (styleIdx >= 0 && dateStyles[styleIdx]) val = excelSerialToDate(Number(val));
        }
      }
      const col = colIndex(attr(attrs, "r") ?? "");
      while (cells.length < col) cells.push("");
      cells[col] = val.replace(/[\t\n\r]+/g, " ").trim();
    }
    // 去掉行尾空列
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    rows.push(cells.join("\t"));
  }
  // 连续空行压成一行
  const compact: string[] = [];
  for (const r of rows) {
    if (!r.trim() && !compact[compact.length - 1]?.trim()) continue;
    compact.push(r);
  }
  return { text: compact.join("\n").trim(), omitted: Math.max(0, total - rows.length) };
}

/** 读 Excel 的全部工作表（含共享字符串与日期样式）。 */
export function xlsxToText(zip: Map<string, Buffer>, maxRowsPerSheet: number): { text: string; sheets: number } {
  const shared: string[] = [];
  const sst = zip.get("xl/sharedStrings.xml")?.toString("utf8");
  if (sst) {
    for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      shared.push(decodeEntities([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("")));
    }
  }
  const dateStyles = dateStyleFlags(zip.get("xl/styles.xml")?.toString("utf8"));

  // 工作表顺序与名称：workbook.xml + rels（缺了则按文件名顺序兜底）
  const rels = new Map<string, string>();
  const relXml = zip.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  if (relXml) {
    for (const m of relXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const id = attr(m[1], "Id");
      const target = attr(m[1], "Target");
      if (id && target) rels.set(id, target.replace(/^\/?xl\//, "").replace(/^\.\.\//, ""));
    }
  }
  const wb = zip.get("xl/workbook.xml")?.toString("utf8");
  const sheets: Array<{ name: string; file: string }> = [];
  if (wb) {
    for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
      const name = decodeEntities(attr(m[1], "name") ?? "");
      const rid = attr(m[1], "r:id") ?? attr(m[1], "id") ?? "";
      const file = rels.get(rid);
      if (file) sheets.push({ name: name || file, file: "xl/" + file.replace(/^xl\//, "") });
    }
  }
  if (sheets.length === 0) {
    for (const key of [...zip.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()) {
      sheets.push({ name: path.basename(key, ".xml"), file: key });
    }
  }

  const parts: string[] = [];
  let used = 0;
  for (const sheet of sheets) {
    const xml = zip.get(sheet.file)?.toString("utf8");
    if (!xml) continue;
    const { text, omitted } = xlsxSheetToTable(xml, shared, dateStyles, maxRowsPerSheet);
    if (!text) {
      parts.push(`## 工作表「${sheet.name}」\n（空表）`);
      continue;
    }
    const tail = omitted > 0 ? `\n…（该表还有 ${omitted} 行未列出）` : "";
    parts.push(`## 工作表「${sheet.name}」\n${text}${tail}`);
    used += text.length;
    if (used > 200_000) break;
  }
  return { text: normalizeText(parts.join("\n\n")), sheets: sheets.length };
}

// ── HTML ──

export function htmlToText(html: string): string {
  const body = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<h([1-6])\b[^>]*>/gi, (_, n: string) => "\n" + "#".repeat(Number(n)) + " ")
    .replace(/<td\b[^>]*>/gi, "\t")
    // 去掉所有剩余标签，但保留标签之间的空白折叠交给 normalizeText
    .replace(/<[^>]*>/g, "");
  return normalizeText(decodeEntities(body));
}

// ── PDF（交给 pdftotext）──

let pdfExeCache: string | null | undefined;

/** 查找 pdftotext：环境变量 → 配置 → PATH → Git for Windows 安装目录。 */
export function findPdfToText(explicit?: string): string | null {
  const envPath = process.env.PI_PDFTOTEXT;
  for (const p of [explicit, envPath]) {
    if (p && existsSync(p)) {
      pdfExeCache = p;
      return p;
    }
  }
  if (pdfExeCache !== undefined) return pdfExeCache;

  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? ["pdftotext.exe", "pdftotext"] : ["pdftotext"];
  const candidates: string[] = [];
  for (const d of dirs) for (const n of names) candidates.push(path.join(d, n));
  // Git for Windows：按 git.exe / bash.exe 的位置反推 mingw64/bin（那里自带 pdftotext）
  for (const d of dirs) {
    if (!/^[\\/]?(?:[A-Za-z]:)?[\\/]/.test(d) && !path.isAbsolute(d)) continue;
    const base = path.basename(d).toLowerCase();
    if (!["cmd", "bin", "usr"].includes(base)) continue;
    const roots = base === "cmd" ? [path.dirname(d)] : [path.resolve(d, "..", "..")];
    for (const root of roots) {
      for (const n of names) candidates.push(path.join(root, "mingw64", "bin", n), path.join(root, "usr", "bin", n));
    }
  }
  if (process.platform === "win32") {
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pfx86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] ?? "";
    for (const root of [
      path.join(pf, "Git"),
      path.join(pfx86, "Git"),
      local ? path.join(local, "Programs", "Git") : "",
    ].filter(Boolean)) {
      for (const n of names) candidates.push(path.join(root, "mingw64", "bin", n), path.join(root, "usr", "bin", n));
    }
  }
  for (const c of candidates) {
    try {
      if (c && existsSync(c)) {
        pdfExeCache = c;
        return c;
      }
    } catch {
      /* ignore */
    }
  }
  pdfExeCache = null;
  return null;
}

export interface PdfText {
  text: string;
  pages: number;
}

/** pdftotext 的英文报错 → 用户看得懂的中文理由。 */
function pdfErrorHint(stderr: string, code: number | null): string {
  const s = stderr.toLowerCase();
  if (/encrypt|password|permission/.test(s)) return "PDF 有密码保护，读不了";
  if (/damaged|xref|syntax|corrupt|error/.test(s)) return "PDF 文件损坏或格式不标准，读不出文字";
  const detail = stderr.split("\n")[0]?.replace(/\s+/g, " ").trim().slice(0, 80);
  return detail ? `PDF 解析失败（${detail}）` : `PDF 解析失败（退出码 ${code}）`;
}

/** 调 pdftotext 抽取 PDF 文本（-layout 保留表格/分栏的排布，中文按 UTF-8 输出）。 */
export async function pdfToText(buf: Buffer, opts: ConvertOpts): Promise<{ ok: true; data: PdfText } | { ok: false; reason: string }> {
  const exe = findPdfToText(opts.pdftotext);
  if (!exe) {
    return { ok: false, reason: "这台机器上没找到 PDF 解析工具 pdftotext（Git for Windows 自带；也可用 config.files.pdftotext 指定路径）" };
  }
  const tmp = path.join(opts.workDir, `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`);
  try {
    writeFileSync(tmp, buf);
  } catch (err) {
    return { ok: false, reason: `临时文件写入失败：${err instanceof Error ? err.message : err}` };
  }
  try {
    const run = await new Promise<{ code: number | null; stdout: Buffer; stderr: string }>((resolve) => {
      // 不加 -q：失败时把 pdftotext 的报错带回来，便于如实说明原因
      const child = spawn(exe, ["-enc", "UTF-8", "-layout", tmp, "-"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      let stderr = "";
      const timer = setTimeout(() => child.kill(), 120_000);
      child.stdout.on("data", (d: Buffer) => chunks.push(d));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout: Buffer.alloc(0), stderr: err.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout: Buffer.concat(chunks), stderr });
      });
    });
    const raw = run.stdout.toString("utf8");
    if (run.code !== 0 && raw.trim().length === 0) {
      return { ok: false, reason: pdfErrorHint(run.stderr, run.code) };
    }
    const pages = (raw.match(/\f/g) ?? []).length || 1;
    // 分页符 → 页码标记，方便 pi 引用"第几页"
    const text = normalizeText(
      raw
        .split("\f")
        .map((page, i) => (i === 0 || !page.trim() ? page : `\n\n--- 第 ${i + 1} 页 ---\n${page}`))
        .join(""),
    );
    if (text.replace(/--- 第 \d+ 页 ---/g, "").trim().length < 20) {
      return { ok: false, reason: "PDF 里提取不到文字（可能是扫描件/图片型 PDF，或文档已加密）" };
    }
    return { ok: true, data: { text, pages } };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* 清理失败由附件目录的定时清理兜底 */
    }
  }
}

// ── 统一入口 ──

/** 文档 → 文本。ext 为小写扩展名（无扩展名时传空串，会按内容嗅探）。 */
export async function convertDocument(buf: Buffer, ext: string, opts: ConvertOpts): Promise<ConvertResult> {
  let e = ext.toLowerCase();
  if (!e) e = sniffDocExt(buf) ?? "";
  if (!e) {
    if (buf.length === 0) return { ok: false, reason: "文件是空的（没有内容）" };
    const dec = decodePlainText(buf);
    if (dec) return finishPlain(dec.text, dec, opts);
    return { ok: false, reason: "识别不出文件格式（既不是支持的文档，也不是文本）" };
  }

  if (TEXT_EXTS.has(e)) {
    if (buf.length === 0) return { ok: false, reason: "文件是空的（没有内容）" };
    const dec = decodePlainText(buf);
    if (!dec) return { ok: false, reason: "内容是二进制，和扩展名对不上" };
    return finishPlain(dec.text, dec, opts);
  }

  if (BINARY_EXTS.has(e)) {
    const hint =
      e === "doc" || e === "xls" || e === "ppt" || e === "wps" || e === "et" || e === "dps"
        ? "旧版 Office 格式（doc/xls/ppt）读不了，请另存为 docx/xlsx/pptx 或 PDF"
        : "压缩包/可执行文件/音视频等二进制文件读不了";
    return { ok: false, reason: hint };
  }

  try {
    if (e === "pdf") {
      const r = await pdfToText(buf, opts);
      if (!r.ok) return r;
      const { text, truncated } = capText(r.data.text, opts.maxChars);
      return {
        ok: true,
        text: text + (truncated ? "\n\n（正文过长，以上为前部分内容）" : ""),
        note: `已转成文本，共 ${r.data.pages} 页${truncated ? `，内容过长只取了前 ${opts.maxChars} 字` : ""}`,
      };
    }

    if (e === "html" || e === "htm") {
      const text = htmlToText(decodePlainText(buf)?.text ?? buf.toString("utf8"));
      return finishDoc(text, "网页已转成文本", opts);
    }
    if (!ZIP_DOC_EXTS.has(e)) return { ok: false, reason: "暂不支持这种格式" };

    const zip = readZip(buf);
    let text = "";
    let note = "";
    if (e === "docx" || e === "docm" || e === "dotx") {
      const doc = zip.get("word/document.xml");
      if (!doc) return { ok: false, reason: "文件里没有正文（可能不是标准的 Word 文档）" };
      text = docxToText(doc.toString("utf8"));
      note = "Word 文档已转成文本";
    } else if (e === "xlsx" || e === "xlsm") {
      const r = xlsxToText(zip, 200);
      text = r.text;
      note = `Excel 已转成制表符分隔的文本（${r.sheets} 个工作表）`;
    } else {
      text = pptxToText(zip);
      note = "PPT 已按页转成文本";
    }
    return finishDoc(text, note, opts);
  } catch (err) {
    return { ok: false, reason: `解析失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 文档转换收尾：空正文如实拒绝，超长截断并在说明里标注。 */
function finishDoc(text: string, note: string, opts: ConvertOpts): ConvertResult {
  if (normalizeText(text).length === 0) {
    return { ok: false, reason: "文档里没有可提取的文字（可能是纯图片/扫描件）" };
  }
  const { text: capped, truncated } = capText(text, opts.maxChars);
  return {
    ok: true,
    text: capped + (truncated ? "\n\n（内容过长，以上为前部分内容）" : ""),
    note: `${note}${truncated ? "，内容过长有所截断" : ""}`,
  };
}

function finishPlain(text: string, dec: DecodedText, opts: ConvertOpts): ConvertResult {
  const body = normalizeText(text);
  if (body.length === 0) return { ok: false, reason: "文件是空的（没有内容）" };
  const { text: capped, truncated } = capText(body, opts.maxChars);
  return {
    ok: true,
    text: capped + (truncated ? "\n\n（内容过长，以上为前部分内容）" : ""),
    note: dec.encoding === "utf-8" ? "" : `按 ${dec.encoding.toUpperCase()} 解码`,
  };
}
