/**
 * web-tools 扩展：为企鹅主任提供外部知识能力
 *
 * - web_search：Tavily 搜索（key 经环境变量 TAVILY_API_KEY 注入）
 * - web_read：抓取网页正文（仅公网 http/https，封禁内网地址防 SSRF）
 *
 * 本机无代理：境外站点（YouTube/X/OpenAI 等）大概率超时，返回明确提示。
 */

interface ExtensionAPI {
  registerTool(tool: ToolRegistration): void;
}

import dns from "node:dns/promises";

interface ToolRegistration {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines?: string[];
  // TypeBox 风格 JSON Schema（手写等价于 Type.Object，避免依赖 typebox 模块解析）
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
}

const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "搜索关键词，用目标语言的地道写法（中文内容用中文，技术名词用英文）" },
  },
  required: ["query"],
};

const READ_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", description: "要读取的网页完整 URL（http/https）" },
  },
  required: ["url"],
};

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 3 * 1024 * 1024;
// 正文上限（字符）：技术长文动辄三四万字，太小会拦腰截断读不完整
const DEFAULT_MAX_TEXT_CHARS = 50_000;
const MAX_TEXT_CHARS = envMaxTextChars() ?? DEFAULT_MAX_TEXT_CHARS;

// IP 回显/查询类网站：访问它们会拿到本机出口 IP，属信息安全红线，一律拒绝
const IP_ECHO_HOSTS = [
  "api.ipify.org", "ipify.org", "ip.sb", "api.ip.sb", "ipinfo.io", "ifconfig.me",
  "ifconfig.co", "cip.cc", "myip.ipip.net", "ip.3322.net", "checkip.amazonaws.com",
  "api.my-ip.io", "ip-api.com", "ip138.com", "ipip.net", "whatismyip.com",
  "whatismyipaddress.com", "icanhazip.com", "ident.me", "ipify.org",
];

export default function webToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "联网搜索。用于了解新闻、新技术名词、求职信息等外部知识。",
    promptSnippet: "web_search: search the web via Tavily",
    promptGuidelines: [
      "遇到你不了解或时效性强的问题（新技术、新闻、招聘信息等），先用 web_search 搜索再回答。",
      "回答里注明信息来源链接。",
    ],
    parameters: SEARCH_SCHEMA,
    async execute(_id, params) {
      const query = String(params.query ?? "").trim();
      if (!query) return text("缺少搜索关键词。");
      const key = process.env.TAVILY_API_KEY ?? "";
      if (!key) return text("搜索未配置（缺少 TAVILY_API_KEY），请直接用已有知识回答并说明可能过时。");

      try {
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ query, max_results: 5, search_depth: "basic" }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          return text(`搜索服务返回错误（HTTP ${res.status}），请稍后重试或用已有知识回答。`);
        }
        const data = (await res.json()) as {
          results?: Array<{ title?: string; url?: string; content?: string }>;
        };
        const results = data.results ?? [];
        if (results.length === 0) return text(`没有搜到与「${query}」相关的结果，换个关键词试试。`);
        const lines = results.map((r, i) => {
          const snippet = (r.content ?? "").replace(/\s+/g, " ").slice(0, 500);
          return `${i + 1}. ${r.title ?? "(无标题)"}\n   ${r.url ?? ""}\n   ${snippet}`;
        });
        return text(`搜索「${query}」的结果：\n\n${lines.join("\n\n")}`);
      } catch (err) {
        return text(`搜索失败：${errMsg(err)}。请用已有知识回答并说明信息可能不是最新。`);
      }
    },
  });

  pi.registerTool({
    name: "web_read",
    label: "Web Read",
    description: "读取一个网页的正文内容。用于总结文章、解读文档、查看 GitHub 仓库说明等。",
    promptSnippet: "web_read: fetch a public web page as plain text",
    promptGuidelines: [
      "用户给出链接要求总结/解读时，用 web_read 读取原文再回答。",
      "境外站点（YouTube、X、OpenAI 等）本机无代理可能读不到，读不到就如实说明，并尝试用 web_search 找替代信息。",
    ],
    parameters: READ_SCHEMA,
    async execute(_id, params) {
      const raw = String(params.url ?? "").trim();
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return text(`无效的 URL：${raw}`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return text("只支持 http/https 链接。");
      }
      if (url.port && url.port !== "80" && url.port !== "443") {
        return text("只支持 80/443 端口。");
      }
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (IP_ECHO_HOSTS.some((h) => host === h || host.endsWith("." + h))) {
        return text("出于信息安全要求，不允许查询本机出口 IP 或访问 IP 回显类网站。");
      }

      const guard = await ssrfGuard(url.hostname).catch((err) => `地址检查失败：${errMsg(err)}`);
      if (guard) return text(`拒绝读取该地址：${guard}`);

      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return text(`网页返回 HTTP ${res.status}，读不到内容。`);

        const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
        if (!/text\/|json|xml/.test(ctype)) {
          return text(`不支持的内容类型：${ctype || "未知"}（只读文本类页面）。`);
        }
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_BODY_BYTES) return text("页面过大（>3MB），读不了。");
        const html = new TextDecoder("utf-8").decode(buf);
        // 裸 IP 响应 = 疑似 IP 回显接口（黑名单之外的变体），一律拒绝
        const raw0 = /html/.test(ctype) ? html : html.trim();
        if (!/html/.test(ctype) && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw0)) {
          return text("出于信息安全要求，不允许查询本机出口 IP 或访问 IP 回显类接口。");
        }
        const raw = /html/.test(ctype) ? htmlToText(html) : html;
        const clipped = clip(raw);
        if (!clipped.trim()) return text("页面没有可读正文（可能是纯脚本渲染的站点）。");
        return text(`【${url.href}】\n\n${clipped}`);
      } catch (err) {
        return text(
          `读取失败：${errMsg(err)}。若是境外站点（YouTube/X/OpenAI 等），本机不访问外网，读不到；可用 web_search 找替代信息。`,
        );
      }
    },
  });
}

/** config.json 的 web.maxTextChars 经 WEB_MAX_TEXT_CHARS 注入；非法值按缺省处理。 */
function envMaxTextChars(): number | undefined {
  const n = Number(process.env.WEB_MAX_TEXT_CHARS ?? "");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function clip(body: string): string {
  if (body.length <= MAX_TEXT_CHARS) return body;
  const note = `\n\n(正文过长，已截断：全文约 ${body.length} 字，以上为前 ${MAX_TEXT_CHARS} 字)`;
  return body.slice(0, MAX_TEXT_CHARS) + note;
}

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.name === "TimeoutError" ? "超时" : err.message;
  return String(err);
}

/** 内网/本机地址防护：返回拒绝原因字符串，安全则返回空。 */
async function ssrfGuard(hostname: string): Promise<string> {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) {
    return "不允许访问内网地址";
  }
  let addrs: string[];
  try {
    const r = await dns.lookup(h, { all: true });
    addrs = r.map((a) => a.address);
  } catch {
    return `域名解析失败：${h}`;
  }
  for (const ip of addrs) {
    if (isPrivateIp(ip)) return `目标解析到内网地址（${ip}），已拦截`;
  }
  return "";
}

function isPrivateIp(ip: string): boolean {
  // IPv4 及 IPv4-mapped IPv6
  const v4 = ip.match(/^(?:\d{1,3}\.){3}\d{1,3}$/)
    ? ip
    : ip.toLowerCase().match(/^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/)?.[1];
  if (v4) {
    const [a, b] = v4.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  const low = ip.toLowerCase();
  if (low === "::1" || low === "::") return true;
  if (/^f[cd]/.test(low)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(low)) return true; // fe80::/10 link-local
  return false;
}

/** HTML → 纯文本：去脚本样式、块级标签转换行、解实体、压缩空白。 */
function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, (m) => (/<title[^>]*>([\s\S]*?)<\/title>/i.test(m) ? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(m)![1] : ""));
  s = s
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
  return s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
