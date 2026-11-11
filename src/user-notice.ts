/** 终态聊天由 PA 按 CA 交付转述。贴原文或写不出来时用固定短句。 */

export const NOTICE_FALLBACK = "事情已经收尾，通知没写出来，细节在验收文件里。";
export const RETELL_MAX = 480;

export interface RetellInput {
  task: string;
  status: string;
  report?: unknown;
  acceptance?: { verdict?: string; summary?: string };
  note?: string;
}

const length = (value: string) => [...value].length;

function clipParagraph(value: string): string {
  const text = value.replace(/\n{3,}/g, "\n\n").trim();
  if (length(text) <= RETELL_MAX) return text;
  const head = [...text].slice(0, RETELL_MAX).join("");
  const end = Math.max(head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"));
  if (end < 8) return "";
  return head.slice(0, end + 1).trim();
}

function pastedFrom(text: string, raw: string[]): boolean {
  const flat = text.replace(/\s+/g, "");
  for (const source of raw) {
    const compact = String(source ?? "").replace(/\s+/g, "");
    if (compact.length >= 24 && (flat === compact || flat.includes(compact))) return true;
    if (compact.length < 40) continue;
    for (let i = 0; i + 40 <= compact.length; i += 8) {
      if (flat.includes(compact.slice(i, i + 40))) return true;
    }
  }
  return false;
}

/** 模型可以看见交付。这里只决定用户能不能看到这段话。 */
export function acceptUserCopy(text: string, raw: string[] = []): string {
  if (text.trim() === NOTICE_FALLBACK) return NOTICE_FALLBACK;
  const body = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!body || !/[\u4e00-\u9fff]/.test(body)) return NOTICE_FALLBACK;
  if (/```|[{}`]|https?:|[/\\]|node_modules|tsconfig|\b(?:npx|npm|pnpm|yarn|git|tsc|PID)\b/i.test(body)) return NOTICE_FALLBACK;
  if (/[A-Za-z][A-Za-z0-9_.:/+-]{2,}/.test(body)) return NOTICE_FALLBACK;
  if (/原先[\s\S]{0,40}。现在[\s\S]{0,40}。做了/.test(body)) return NOTICE_FALLBACK;
  if (pastedFrom(body, raw)) return NOTICE_FALLBACK;
  return clipParagraph(body) || NOTICE_FALLBACK;
}

export function retellPrompt(input: RetellInput): string {
  const report = input.report == null ? "没有交来书面结果" : JSON.stringify(input.report).slice(0, 8000);
  const verdict = input.acceptance?.verdict === "passed" || input.acceptance?.verdict === "failed" || input.acceptance?.verdict === "unverified"
    ? input.acceptance.verdict
    : "未验收";
  const summary = String(input.acceptance?.summary ?? "").slice(0, 2000);
  return [
    "你是 PA。下面是 CA 交来的结果，请用白话讲给胡同学，写成自然的一小段。",
    "讲到这些就够：原先功能或状态是什么样，现在改了什么，这件事或其中某项做完没有，有没有验证过。",
    "用你自己的话连起来。不要套固定格式，不要分条，不要写成「原先…现在…做了…」。",
    "不要贴交付原文，不要贴终端输出，不要写代码、命令、路径或文件名。",
    "CA 自己说完成不算验证过，只以下面的验收结论为准。没核过就直接说还没核过，不要先说做好了再改口。",
    `任务状态：${input.status}`,
    `用户要办的事：${String(input.task ?? "").slice(0, 2000)}`,
    `CA 交付：${report}`,
    `独立验收：${verdict}${summary ? `。${summary}` : ""}`,
    input.note ? `另外：${input.note}` : "",
  ].filter(Boolean).join("\n");
}

function attentionHint(message?: string): string {
  const fallback = "连续一段时间未观察到进展";
  const raw = String(message ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return fallback;
  if (length(raw) > 100) return fallback;
  if (/[{}`]|CA 自述|终端快照|```|https?:|[/\\]|node_modules|\b(?:npx|npm|tsc|PID)\b/i.test(raw)) return fallback;
  if (/[A-Za-z]:[\\/]|[/\\][\w./\\-]+/.test(raw)) return fallback;
  return raw;
}

export function attentionNotice(id: string, message?: string): string {
  return `后台任务 ${id} 需要关注：${attentionHint(message)}。\n任务未因 PA 对话结束而停止，整体执行时限仍有效；你可以继续聊天或取消该任务。`;
}
