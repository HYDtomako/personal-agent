/** 终态回聊天的五件事。明细不在这里，仍落验收文件。 */

export const USER_NOTICE_MAX = 150;

export interface FiveNotice {
  before: string;
  now: string;
  did: string;
  outcome: "过" | "挂" | "未核实";
  reason: string;
  action: string;
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

/** 只留一句能念出来的中文；路径、命令、栈和纯英文技术词丢掉。 */
export function spoken(value: string | undefined): string {
  const clause = String(value ?? "").split(/\n|。|！|？/)[0] ?? "";
  let text = stripDanger(clause);
  text = text.replace(/[，、；：,;]{2,}/g, "，");
  text = text.replace(/^[，。；、：,\s.]+|[，。；、：,\s.]+$/g, "");
  if (!/[\u4e00-\u9fff]/.test(text)) return "";
  return text;
}

function clipField(value: string, max: number, fallback: string): string {
  const clean = spoken(value) || fallback;
  const chars = [...clean];
  if (chars.length <= max) return clean;
  return chars.slice(0, max).join("").replace(/[，、；：,;]+$/u, "") || fallback;
}

function shrink(value: string, keep: number, fallback: string): string {
  const chars = [...value];
  const next = chars.slice(0, Math.max(1, keep)).join("").replace(/[，、；：,;]+$/u, "");
  return next || fallback;
}

/** 五段都在，整段按字符硬截到 150。可变部分先缩短，标签保留。 */
export function renderFiveNotice(parts: FiveNotice): string {
  const outcome = parts.outcome === "过" || parts.outcome === "挂" || parts.outcome === "未核实" ? parts.outcome : "未核实";
  let before = clipField(parts.before, 30, "这件事还没完成");
  let now = clipField(parts.now, 30, "还不能确认现在");
  let did = clipField(parts.did, 30, "按你的目标处理了这件事");
  let reason = clipField(parts.reason, 30, "没有补充说明");
  let action = clipField(parts.action, 16, "要确认预览");
  if (!/无需动手|要确认预览|要修/.test(action)) action = "要确认预览";
  const build = () => `原先${before}。现在${now}。做了${did}。${outcome}，${reason}。${action}。`;
  let text = build();
  for (let round = 0; round < 8 && length(text) > USER_NOTICE_MAX; round += 1) {
    const overflow = length(text) - USER_NOTICE_MAX;
    if (length(reason) > 1) reason = shrink(reason, length(reason) - overflow, "无");
    else if (length(did) > 1) did = shrink(did, length(did) - overflow, "已处理");
    else if (length(before) > 1) before = shrink(before, length(before) - overflow, "不详");
    else if (length(now) > 1) now = shrink(now, length(now) - overflow, "不详");
    else break;
    text = build();
  }
  if (length(text) > USER_NOTICE_MAX) text = [...text].slice(0, USER_NOTICE_MAX).join("");
  return text;
}

export function noticeReady(text: string): boolean {
  if (length(text) > USER_NOTICE_MAX || length(text) === 0) return false;
  const before = text.indexOf("原先");
  const now = text.indexOf("现在");
  const did = text.indexOf("做了");
  if (before !== 0 || now <= before || did <= now) return false;
  const outcomeAt = text.search(/过，|挂，|未核实，/);
  const actionAt = text.search(/无需动手|要确认预览|要修/);
  return outcomeAt > did && actionAt > outcomeAt;
}

/** 聊天出口的最后一道：不是五件事，或夹了不能念的细节，就换成一句能直接发的话。 */
export function finalizeUserNotice(text: string): string {
  const cleaned = stripDanger(text).replace(/\s+/g, "");
  if (noticeReady(cleaned)) return cleaned;
  return renderFiveNotice({
    before: "情况还不清楚",
    now: "还不能当它做完",
    did: "先结束了这次处理",
    outcome: "未核实",
    reason: "有些细节不能直接转述",
    action: "要确认预览",
  });
}

export function userNoticeFromReview(input: {
  verdict: "passed" | "failed" | "unverified";
  summary?: string;
  task?: string;
  stage?: string;
}): string {
  const reason = spoken(input.summary);
  const did = spoken(input.task);
  const stage = input.stage;
  if (input.verdict === "passed") {
    return renderFiveNotice({
      before: stage === "execution" ? "改动还在副本里" : stage === "target" ? "原项目刚放进这次改动" : "这件事还没完成",
      now: stage === "execution" ? "副本里的结果已核对通过" : stage === "target" ? "原项目已是改完并通过的样子" : "已经按目标做完",
      did: did || (stage === "target" ? "核对通过后放回原项目" : "按你的目标改完并核对"),
      outcome: "过",
      reason: reason || "核对通过",
      action: "无需动手",
    });
  }
  if (input.verdict === "failed") {
    return renderFiveNotice({
      before: "这件事还没完成",
      now: stage === "target" ? "原项目没有留下这次改动" : "结果还不能用",
      did: did || "按你的目标处理了这件事",
      outcome: "挂",
      reason: reason || "核对没过",
      action: "要修没通过的阻塞",
    });
  }
  return renderFiveNotice({
    before: "这件事还没完成",
    now: "还不能确认是否做完",
    did: did || "按你的目标处理了这件事",
    outcome: "未核实",
    reason: reason || "没有完成独立核对",
    action: "要确认预览",
  });
}

export function failureNotice(status: string, kind: "plain" | "direct" | "delivery"): string {
  const cancelled = status === "cancelled";
  const timedOut = status === "timed_out";
  return renderFiveNotice({
    before: "这件事还在进行",
    now: kind === "direct"
      ? "原项目里可能留有没做完的改动"
      : kind === "delivery"
        ? "原项目没有自动更新"
        : cancelled ? "已经停掉，没有做完" : timedOut ? "到点停了，没有做完" : "中途停了，没有做完",
    did: cancelled ? "按取消停掉了" : timedOut ? "做到时限就停了" : "执行中断了",
    outcome: "挂",
    reason: cancelled ? "已经取消" : timedOut ? "到了执行时限" : "执行失败",
    action: cancelled ? "要确认预览" : "要修没做完的阻塞",
  });
}

export function unsettledNotice(): string {
  return renderFiveNotice({
    before: "事情已经做完并交了报告",
    now: "收尾还没确认，先不交付",
    did: "先停在完成报告，没有继续交付",
    outcome: "未核实",
    reason: "收尾尚未确认",
    action: "要确认预览",
  });
}

export function cleanupHoldNotice(): string {
  return renderFiveNotice({
    before: "结果已经出来了",
    now: "收尾还没确认，项目先锁着",
    did: "先留着结果，没有放开项目",
    outcome: "未核实",
    reason: "收尾尚未确认",
    action: "要确认预览",
  });
}

export function deliveryExceptionNotice(errorMessage?: string): string {
  return renderFiveNotice({
    before: "交付还没完成",
    now: "还不能确认原项目改好了没有",
    did: "尝试交付时中断了",
    outcome: "未核实",
    reason: spoken(errorMessage) || "交付过程异常",
    action: "要修交付中断的阻塞",
  });
}
