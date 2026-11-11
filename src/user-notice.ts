/** 终态聊天只带验收事实。模型写一句口语；写不出来就用固定短句。明细仍在验收文件。 */

export const SENTENCE_MAX = 80;
export const NOTICE_FALLBACK = "事情已经收尾，通知没写出来，细节在验收文件里。";

export interface AcceptanceFacts {
  verdict: "passed" | "failed" | "unverified";
  changed: string;
  unchecked: string;
  needsUser: boolean;
}

export interface DeliveryFactSource {
  state?: string;
  mode?: string;
  alreadyPresent?: boolean;
  executionReview?: { verdict?: string; summary?: string };
  targetReview?: { verdict?: string; summary?: string };
}

const length = (value: string) => [...value].length;

function stripDanger(value: string): string {
  let text = String(value ?? "");
  text = text.replace(/```[\s\S]*?```/g, "");
  text = text.replace(/[A-Za-z]:[\\/][^\s，。；、]*/g, "");
  text = text.replace(/[/\\][\w./\\-]*/g, "");
  text = text.replace(/\b[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|py|go|rs|css|html|yml|yaml|toml|lock|txt|log|sh)\b/gi, "");
  text = text.replace(/\b(?:npx|npm|pnpm|yarn|node|git|bash|sh|tsc|pytest|cargo|make)\b[^，。；\n]*/gi, "");
  text = text.replace(/(?:^|\s)--?[A-Za-z0-9][\w=-]*/g, "");
  text = text.replace(/\bat\s+\S+/g, "");
  text = text.replace(/\([^)]{0,120}\)/g, "");
  text = text.replace(/\b(?:TypeError|SyntaxError|ReferenceError|Exception|PID)\b[:\s]*\S*/g, "");
  text = text.replace(/https?:\/\/\S+/g, "");
  text = text.replace(/[{}`]/g, "");
  text = text.replace(/[ \t]*\n[ \t]*/g, "");
  text = text.replace(/[ \t]{2,}/g, "");
  return text.trim();
}

/** 只留一句能念出来的中文；路径、命令、栈和纯英文丢掉。 */
export function spoken(value: string | undefined): string {
  const clause = String(value ?? "").split(/\n|。|！|？/)[0] ?? "";
  let text = stripDanger(clause);
  text = text.replace(/[，、；：,;]{2,}/g, "，");
  text = text.replace(/^[，。；、：,\s.]+|[，。；、：,\s.]+$/g, "");
  if (!/[\u4e00-\u9fff]/.test(text)) return "";
  return text;
}

function claimsDone(text: string): boolean {
  return /已经(?:改好|做完|通过|完成)|核过了|核对通过|验收通过/.test(text);
}

/** 验收事实里的一句中文。英文记号、路径和填空腔调不进模型输入。 */
export function factPhrase(value: string | undefined, fallback: string): string {
  let text = spoken(value);
  text = text.replace(/[A-Za-z][A-Za-z0-9_.:/+-]{2,}/g, "");
  text = text.replace(/[+_]+/g, "");
  text = text.replace(/[，、；：,;\s]{2,}/g, "，");
  text = text.replace(/^[，、；：,;\s]+|[，、；：,;\s]+$/g, "");
  if (/原先|未核实|无需动手|要确认预览/.test(text)) return fallback;
  if (!/[\u4e00-\u9fff]/.test(text)) return fallback;
  const clipped = [...text].slice(0, 40).join("").replace(/[，、；：,;]+$/u, "");
  return clipped || fallback;
}

function usableSaid(summary: string | undefined, allowDone: boolean): string {
  const said = factPhrase(summary, "");
  if (!said) return "";
  if (!allowDone && claimsDone(said)) return "";
  return said;
}

export function factsFromReview(input: { verdict?: string; summary?: string; stage?: string }): AcceptanceFacts {
  const verdict = input.verdict === "passed" || input.verdict === "failed" || input.verdict === "unverified" ? input.verdict : "unverified";
  const said = usableSaid(input.summary, verdict !== "unverified");
  if (verdict === "passed") {
    const generic = input.stage === "target" ? "原项目里的改动核过了" : input.stage === "execution" ? "副本里的改动核过了" : "已经按验收改好了";
    return { verdict, changed: said || generic, unchecked: "", needsUser: false };
  }
  if (verdict === "failed") {
    const generic = input.stage === "target" ? "放回原项目后没通过" : "这版没通过";
    return { verdict, changed: said || generic, unchecked: "", needsUser: true };
  }
  const generic = input.stage === "target" ? "原项目这边还不能说已经改好" : "还不能说已经做好";
  return { verdict: "unverified", changed: said || generic, unchecked: "这块还没核过", needsUser: true };
}

export function factsFromDelivery(record?: DeliveryFactSource | null): AcceptanceFacts {
  if (!record?.state) return { verdict: "unverified", changed: "还不能说已经改好", unchecked: "这块还没核过", needsUser: true };
  const inPlace = record.mode === "in-place";
  const failed = record.executionReview?.verdict === "failed" || record.targetReview?.verdict === "failed";
  const delivered = (record.state === "verified" || record.state === "cleaned") && record.targetReview?.verdict === "passed";
  if (delivered) {
    const said = usableSaid(record.targetReview?.summary, true) || usableSaid(record.executionReview?.summary, true);
    const generic = record.alreadyPresent ? "原项目里本来就有同样的结果" : inPlace ? "原处已经改好并核过" : "改动已经放回原项目并核过";
    return { verdict: "passed", changed: said || generic, unchecked: "", needsUser: false };
  }
  if (record.state === "rolled_back") {
    const said = usableSaid(record.targetReview?.summary, true) || usableSaid(record.executionReview?.summary, true);
    return { verdict: "failed", changed: said || "放回去没通过，已经撤回", unchecked: "", needsUser: true };
  }
  if (record.state === "partial" || record.state === "applying") {
    return { verdict: "unverified", changed: "原项目里可能有一部分新改动", unchecked: "这块还没核过", needsUser: true };
  }
  if (failed) {
    const said = usableSaid(record.targetReview?.verdict === "failed" ? record.targetReview.summary : undefined, true)
      || usableSaid(record.executionReview?.verdict === "failed" ? record.executionReview.summary : undefined, true);
    return { verdict: "failed", changed: said || "这版没通过", unchecked: "", needsUser: true };
  }
  const said = usableSaid(record.targetReview?.summary, false) || usableSaid(record.executionReview?.summary, false);
  return { verdict: "unverified", changed: said || "还不能说已经改好", unchecked: "这块还没核过", needsUser: true };
}

export function failureFacts(status: string, kind: "plain" | "direct" | "delivery"): AcceptanceFacts {
  const cancelled = status === "cancelled";
  const timedOut = status === "timed_out";
  const stop = cancelled ? "已经取消，没有做完" : timedOut ? "到点停了，没有做完" : "中途停了，没有做完";
  const where = kind === "direct" ? "原项目里可能留有没做完的改动" : kind === "delivery" ? "原项目没有自动更新" : "";
  return { verdict: "unverified", changed: where ? `${stop}，${where}` : stop, unchecked: "这块还没核过", needsUser: !cancelled };
}

export function unsettledFacts(): AcceptanceFacts {
  return { verdict: "unverified", changed: "执行结束了，收尾还没确认", unchecked: "这块还没核过", needsUser: true };
}

export function cleanupHoldFacts(): AcceptanceFacts {
  return { verdict: "unverified", changed: "结果先留着，项目还锁着", unchecked: "这块还没核过", needsUser: true };
}

export function exceptionFacts(errorMessage?: string): AcceptanceFacts {
  return { verdict: "unverified", changed: factPhrase(errorMessage, "交付中途断了"), unchecked: "这块还没核过", needsUser: true };
}

const VERDICT_LABEL = { passed: "通过", failed: "没通过", unverified: "没核过" } as const;

/** 模型只看见这四行事实。不要把报告、快照或清单拼进来。 */
export function noticePrompt(facts: AcceptanceFacts): string {
  const verdict = facts?.verdict === "passed" || facts?.verdict === "failed" || facts?.verdict === "unverified" ? facts.verdict : "unverified";
  const changed = factPhrase(facts?.changed, "没有单独写出改了什么");
  const unchecked = facts?.unchecked?.trim() ? factPhrase(facts.unchecked, "这块还没核过") : "没有";
  const needsUser = facts?.needsUser === true ? "要" : "不用";
  return [
    "用下面的验收事实，给用户写一句口语。像平时说话，不要像在填表。",
    "只写一句，句末一个句号。不要第二句，不要列表，不要标题。",
    "只能使用这些事实。不要补充报告、日志、路径、命令或文件名。",
    "不要写成「原先…现在…做了…」这种填空。",
    "没核过的内容就直接说「这块还没核过」，不要先说做好了再改口。",
    `结论：${VERDICT_LABEL[verdict]}`,
    `改动：${changed}`,
    `没核过：${unchecked}`,
    `要用户动手：${needsUser}`,
  ].join("\n");
}

function attentionHint(message?: string): string {
  const fallback = "连续一段时间未观察到进展";
  const raw = String(message ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return fallback;
  if (length(raw) > 100) return fallback;
  if (/[{}`]|CA 自述|终端快照|```|https?:|[/\\]|node_modules|\b(?:npx|npm|tsc|PID)\b/i.test(raw)) return fallback;
  const cleaned = stripDanger(raw);
  if (!cleaned || cleaned !== raw) return fallback;
  return raw;
}

export function attentionNotice(id: string, message?: string): string {
  return `后台任务 ${id} 需要关注：${attentionHint(message)}。\n任务未因 PA 对话结束而停止，整体执行时限仍有效；你可以继续聊天或取消该任务。`;
}

/** 只收一句能直接发的话。不合格就用固定短句，不另编模板。 */
export function finalizeUserNotice(text: string, facts?: AcceptanceFacts): string {
  if (text.trim() === NOTICE_FALLBACK) return NOTICE_FALLBACK;
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!flat || /[`*{}\[\]#]|原先|未核实|无需动手|要确认预览|https?:|[/\\]|node_modules/i.test(flat)) return NOTICE_FALLBACK;
  if (/[A-Za-z][A-Za-z0-9_.:/+-]{2,}/.test(flat)) return NOTICE_FALLBACK;
  const parts = flat.split(/(?<=[。！？])/u).map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 1) return NOTICE_FALLBACK;
  let sentence = parts[0];
  if (!/[。！？]$/u.test(sentence)) sentence += "。";
  if (length(sentence) > SENTENCE_MAX || length(sentence) < 2) return NOTICE_FALLBACK;
  if (!/[\u4e00-\u9fff]/.test(sentence)) return NOTICE_FALLBACK;
  const gap = Boolean(facts && (facts.verdict === "unverified" || facts.unchecked.trim()));
  if (gap && !/没核/.test(sentence)) return NOTICE_FALLBACK;
  if (facts?.verdict === "passed" && /没核/.test(sentence)) return NOTICE_FALLBACK;
  if (facts?.verdict === "failed" && /没核/.test(sentence)) return NOTICE_FALLBACK;
  return sentence;
}
