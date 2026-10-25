import { mkdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { convertDocument, findPdfToText } from "../src/docparse.ts";

/**
 * 文档取文回归：脱离 bot 进程直接跑，检查各类文件能不能被读成文本。
 * 用法：node scripts/docparse-selftest.ts <文件...>（可传 pdf/docx/xlsx/pptx/txt…）
 * 传 -v 可以打印转换后的正文预览。
 */
const args = process.argv.slice(2);
const verbose = args.includes("-v");
const files = args.filter((a) => a !== "-v");
if (files.length === 0) {
  console.log("用法: node scripts/docparse-selftest.ts [-v] <文件...>");
  process.exit(1);
}

const workDir = path.join(os.tmpdir(), "docparse-selftest");
mkdirSync(workDir, { recursive: true });
console.log(`pdftotext: ${findPdfToText() ?? "（未找到，PDF 读不了）"}\n`);

let ok = 0;
let fail = 0;
for (const file of files) {
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch (err) {
    console.log(`✗ ${file}\n    读取失败: ${err instanceof Error ? err.message : err}\n`);
    fail++;
    continue;
  }
  const ext = path.extname(file).replace(/^\./, "").toLowerCase();
  const started = Date.now();
  const r = await convertDocument(buf, ext, { maxChars: 30_000, workDir });
  const ms = Date.now() - started;
  const size = `${Math.round(statSync(file).size / 1024)}KB`;
  if (!r.ok) {
    console.log(`✗ ${path.basename(file)} [${ext || "无扩展名"} ${size}] 拒绝：${r.reason}（${ms}ms）\n`);
    fail++;
    continue;
  }
  ok++;
  const truncated = r.text.includes("（内容过长") || r.text.includes("（正文过长");
  console.log(
    `✓ ${path.basename(file)} [${ext || "无扩展名"} ${size}] → ${r.text.length} 字${truncated ? "（截断）" : ""}` +
      `${r.note ? `｜${r.note}` : ""}（${ms}ms）`,
  );
  if (verbose) {
    console.log("    " + r.text.replace(/\n/g, "\n    ").slice(0, 800));
  }
  console.log();
}
console.log(`共 ${files.length} 个：成功 ${ok}，失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
