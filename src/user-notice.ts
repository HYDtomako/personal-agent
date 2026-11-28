/** 终态通知由模型写好并用工具发到用户的 Telegram 私聊。不合格的正文不发，主程序也不另编一句。 */

export const RETELL_MAX = 480;

/** 历史占位句。只用于识别并丢掉，不再发给用户。 */
const PLACEHOLDER_COPY = "事情已经收尾，通知没写出来，细节在验收文件里。";

export interface RetellInput {
  task: string;
  status: string;
  report?: unknown;
  acceptance?: { verdict?: string; summary?: string };
  note?: string;
  /** 只写进失败日志，不进提示词。 */
  jobId?: string;
  /** 用户的 Telegram 私聊。群 id 不能填这里。 */
  chatId?: string;
}

/** 只接受用户自己的私聊 id。群（负数）和白名单外的 id 都不用。 */
export function telegramPrivateChatId(
  allowFrom: readonly (string | number)[] = [],
  source?: { channel?: string; chatId?: string },
): string {
  const ids = allowFrom.map((id) => String(id).trim()).filter((id) => /^[1-9]\d*$/.test(id));
  const fromJob = source?.channel === "telegram" ? String(source.chatId ?? "") : "";
  if (fromJob && ids.includes(fromJob)) return fromJob;
  return ids[0] ?? "";
}

/** 模型准备发出去的正文。send 为 false 时调用方不得代发。 */
export function noticeSendDecision(text: string, raw: string[] = []): { send: boolean; text: string; detail: string } {
  const accepted = acceptUserCopy(text, raw);
  if (!accepted) return { send: false, text: "", detail: userCopyRejectDetail(text, raw) ?? "rejected" };
  return { send: true, text: accepted, detail: "" };
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

function oneLine(value: string, limit: number): string {
  const body = String(value ?? "").replace(/\s+/g, " ").trim();
  const count = [...body].length;
  if (!body) return "";
  if (count <= limit) return body;
  return `${[...body].slice(0, limit).join("")}…(共${count}字)`;
}

/** 被丢掉的转述草稿，压成一行，便于写进 server.log。 */
export function summarizeDiscardedCopy(text: string, limit = 400): string {
  return oneLine(text, limit) || "(空)";
}

/** 转述没有发给用户时的一行日志。reason 区分调用失败、过滤拒绝和异常。 */
export function retellFallbackRecord(input: {
  reason: "call-failure" | "filter-rejection" | "exception";
  detail: string;
  draft?: string;
  jobId?: string;
}): string {
  const job = input.jobId ? ` job=${oneLine(input.jobId, 80)}` : "";
  const detail = oneLine(input.detail, 300) || "(无)";
  return `[notify] 转述未采用 reason=${input.reason}${job} detail=${detail} draft=${summarizeDiscardedCopy(input.draft ?? "")}`;
}

const PATH_TOKEN = /(?:[A-Za-z]:[\\/][^\s，。；、]+|[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+)/g;

/** 连着堆三四条路径才像清单。白话里点到一两个文件名仍然要发。 */
function stackedPathDump(body: string): boolean {
  return (body.match(PATH_TOKEN)?.length ?? 0) >= 3;
}

/** 返回 null 表示这段话可以发给用户。工具名、配置文件名写在白话里不算拒绝。 */
export function userCopyRejectDetail(text: string, raw: string[] = []): string | null {
  const body = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!body) return "empty";
  if (body.includes(PLACEHOLDER_COPY)) return "placeholder";
  if (!/[\u4e00-\u9fff]/.test(body)) return "no-han";
  if (/```/.test(body)) return "code-fence";
  if (/[{}`]/.test(body)) return "code-markup";
  if (/https?:/i.test(body)) return "url";
  if (stackedPathDump(body)) return "path-dump";
  if (/原先[\s\S]{0,40}。现在[\s\S]{0,40}。做了/.test(body)) return "template";
  if (pastedFrom(body, raw)) return "pasted";
  if (!clipParagraph(body)) return "no-sentence";
  return null;
}

/** 模型可以看见交付。合格就返回原文；不合格返回空字符串，调用方不要另编一句发给用户。 */
export function acceptUserCopy(text: string, raw: string[] = []): string {
  const body = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (userCopyRejectDetail(body, raw)) return "";
  return clipParagraph(body);
}

export function retellPrompt(input: RetellInput): string {
  const report = input.report == null ? "没有交来书面结果" : JSON.stringify(input.report).slice(0, 8000);
  const verdict = input.acceptance?.verdict === "passed" || input.acceptance?.verdict === "failed" || input.acceptance?.verdict === "unverified"
    ? input.acceptance.verdict
    : "未验收";
  const summary = String(input.acceptance?.summary ?? "").slice(0, 2000);
  return [
    "你是 PA。下面这次后台任务已经结束。请针对这次任务写一段白话，并用 telegram_send 发到胡同学的 Telegram 私聊。",
    "主服务不会替你入队，也不会再转发。只调用 telegram_send，不要改文件、不要派新任务、不要发到群，也不要自己填 chat id。",
    "用自己的话连成一两段，不要分条，不要套「原先…现在…做了…」，也不要照抄别的任务的例子。",
    "要讲清：原先是什么样，这次改了什么，做完没有，哪些验证过、哪些没验证成，还要不要他动手（例如重启或确认；不用他就直接说不用）。",
    "少写代码、命令、路径和文件名。不要贴 CA 原文或终端输出。",
    "CA 自己说完成不算验证过，只以下面的验收结论为准。没核过就说还没核过，并说清为什么没核成，不要先说做好了再改口。",
    input.status === "failed" || input.status === "timed_out" || input.status === "cancelled"
      ? "这次没有做完。请直说没做完，卡在哪，出了什么错。不要说成已经做完，也不要发占位句。"
      : "这次执行已经结束。不要把已经做完的事说成没做完。验收没通过就说没通过，不要改口成没做完。",
    "如果 telegram_send 拒绝发送，按它给的理由改一版再发，不要改成一句敷衍。",
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
