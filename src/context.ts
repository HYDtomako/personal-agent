import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";

export interface ContextItem { id: string; source: string; text: string; priority: number }
export interface ContextStats { budgetChars: number; chars: number; selected: number; omitted: number; duplicates: number }

/** 仅约束额外背景；用户原文、执行协议和 pi 历史不在这里截断。单位是字符，不冒充模型 Token。 */
export function assembleContext(items: ContextItem[], budgetChars = 12000, requestId?: string): { text: string; stats: ContextStats } {
  const started = performance.now();
  if (!Number.isSafeInteger(budgetChars) || budgetChars < 2) throw new Error("背景预算必须是至少 2 的整数");
  const selected: Array<Omit<ContextItem, "priority">> = [];
  const seen = new Set<string>();
  let chars = 2, omitted = 0, duplicates = 0;
  for (const item of [...items].sort((a, b) => a.priority - b.priority)) {
    if (!item.text.trim()) continue;
    const key = `${item.source}\0${item.text}`;
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    const { priority: _priority, ...data } = item;
    const size = JSON.stringify(data).length + (selected.length ? 1 : 0);
    if (chars + size > budgetChars) { omitted++; continue; }
    selected.push(data); chars += size;
  }
  const result = { text: JSON.stringify(selected), stats: { budgetChars, chars, selected: selected.length, omitted, duplicates } };
  if (requestId) channel("personal-agent.context").publish({ requestId, stats: result.stats, durationMs: performance.now() - started });
  return result;
}
