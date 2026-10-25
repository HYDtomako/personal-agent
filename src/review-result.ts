export interface ReviewToolEvidence { name: string; isError?: boolean }
export interface ParsedReview { verdict: "passed" | "failed" | "unverified"; summary: string; checks: string[] }

/** Only a final JSON object counts; explanatory text before it is not the verdict. */
export function parseReviewResult(text: string, tools: ReviewToolEvidence[]): ParsedReview {
  const raw = text.trim().replace(/\s*```$/, "").trim().slice(-65536);
  let parsed: any;
  let position = raw.lastIndexOf("{");
  for (let attempts = 0; position >= 0 && attempts < 64; attempts++, position = raw.lastIndexOf("{", position - 1)) {
    try { const candidate = JSON.parse(raw.slice(position)); if (candidate && !Array.isArray(candidate) && ["passed", "failed", "unverified"].includes(candidate.verdict) && typeof candidate.summary === "string") { parsed = candidate; break; } } catch { /* A nested object or a brace inside quoted evidence is not the final object. */ }
    if (position === 0) break;
  }
  if (!parsed) return { verdict: "unverified", summary: "未取得有效的最终结构化验收结论，未放行回写。", checks: [] };
  const checks = Array.isArray(parsed.checks) ? parsed.checks.filter((s: unknown): s is string => typeof s === "string").slice(0, 20) : [];
  let verdict = parsed.verdict as ParsedReview["verdict"];
  let summary = parsed.summary;
  if (verdict === "passed") {
    if (parsed.requiredTestsPassed !== true || !Array.isArray(parsed.failures) || parsed.failures.length) {
      verdict = "unverified"; summary += "（缺少全部必要测试成功且无未解决失败的明确声明，未放行。）";
    } else if (!checks.length || !tools.some(tool => ["read", "bash"].includes(tool.name) && tool.isError === false)) {
      verdict = "unverified"; summary += "（缺少实际成功核查的工具证据，不能仅凭文字放行。）";
    }
  }
  return { verdict, summary, checks };
}
