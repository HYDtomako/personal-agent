/**
 * time-tools 扩展：获取当前时间与地区信息。
 *
 * 模型自身没有时钟——涉及"今天/现在/几号/周几"时必须调用本工具，不要推算或猜测。
 * 数据全部来自本机（系统时钟、时区、区域设置），不联网、不请求任何外部接口，不泄露 IP。
 * 附带本周/下周日期表，让"下周三""三天后"这类问题直接查表，避免日期运算出错。
 */

interface ExtensionAPI {
  registerTool(tool: ToolRegistration): void;
}

interface ToolRegistration {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
}

const SCHEMA = {
  type: "object",
  properties: {
    timezone: {
      type: "string",
      description:
        "可选：查询指定地区的时间。支持中文城市/国家名（北京、纽约、伦敦、东京…）或标准时区名（Asia/Tokyo、America/New_York、UTC）。不填则返回本机时间。",
    },
  },
  required: [],
};

/** 常见地区 → IANA 时区名。 */
const ZONE_MAP: Record<string, string> = {
  北京: "Asia/Shanghai",
  上海: "Asia/Shanghai",
  中国: "Asia/Shanghai",
  香港: "Asia/Hong_Kong",
  台北: "Asia/Taipei",
  东京: "Asia/Tokyo",
  日本: "Asia/Tokyo",
  首尔: "Asia/Seoul",
  韩国: "Asia/Seoul",
  新加坡: "Asia/Singapore",
  曼谷: "Asia/Bangkok",
  印度: "Asia/Kolkata",
  孟买: "Asia/Kolkata",
  迪拜: "Asia/Dubai",
  莫斯科: "Europe/Moscow",
  伦敦: "Europe/London",
  英国: "Europe/London",
  巴黎: "Europe/Paris",
  柏林: "Europe/Berlin",
  欧洲: "Europe/Berlin",
  纽约: "America/New_York",
  美东: "America/New_York",
  华盛顿: "America/New_York",
  洛杉矶: "America/Los_Angeles",
  旧金山: "America/Los_Angeles",
  美西: "America/Los_Angeles",
  芝加哥: "America/Chicago",
  悉尼: "Australia/Sydney",
  澳洲: "Australia/Sydney",
  新西兰: "Pacific/Auckland",
  巴西: "America/Sao_Paulo",
  UTC: "UTC",
  格林尼治: "UTC",
};

/** 把用户输入解析为合法 IANA 时区名；失败返回 null。 */
function resolveZone(input: string): string | null {
  const key = input.trim();
  if (!key) return null;
  if (ZONE_MAP[key]) return ZONE_MAP[key];
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(ZONE_MAP)) {
    if (k.toLowerCase() === lower || v.toLowerCase() === lower) return v;
  }
  // 已是合法 IANA 名（大小写兼容）
  for (const cand of [key, key.replace(/\s+/g, "_")]) {
    try {
      new Intl.DateTimeFormat("zh-CN", { timeZone: cand });
      return cand;
    } catch {
      /* 继续尝试 */
    }
  }
  return null;
}

/** 格式化指定时区的当前时间，如 "2026/09/21 周一 15:41"。 */
function formatInZone(d: Date, zone: string): { text: string; offsetMin: number } {
  const fmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  const text = `${get("year")}/${get("month")}/${get("day")} ${get("weekday")} ${get("hour")}:${get("minute")}`;
  // 该时区相对 UTC 的偏移（分钟）
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  const there = new Date(d.toLocaleString("en-US", { timeZone: zone }));
  const offsetMin = Math.round((there.getTime() - utc.getTime()) / 60000);
  return { text, offsetMin };
}

function fmtOffset(min: number): string {
  const sign = min >= 0 ? "+" : "-";
  const a = Math.abs(min);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? ":" + String(a % 60).padStart(2, "0") : ""}`;
}

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

/** 时区名与偏移，如 "Asia/Shanghai（UTC+8）"。 */
function timezoneInfo(d: Date): string {
  let zone = "";
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    /* 取不到就只显示偏移 */
  }
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const hh = Math.floor(Math.abs(offMin) / 60);
  const mm = Math.abs(offMin) % 60;
  const offset = `UTC${sign}${hh}${mm ? ":" + String(mm).padStart(2, "0") : ""}`;
  const cn = new Date().toString().match(/\(([^)]+)\)$/)?.[1] ?? "";
  return [zone, offset, cn].filter(Boolean).join("｜");
}

/** 地区/语言：系统区域设置 + 时区所属地区。 */
function regionInfo(): string {
  let locale = "";
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale ?? "";
  } catch {
    /* ignore */
  }
  const zone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    } catch {
      return "";
    }
  })();
  const regionFromZone = zone.includes("/") ? zone.split("/")[0] : "";
  const regionName = regionFromZone === "Asia" && zone.includes("Shanghai") ? "中国" : regionFromZone;
  return [regionName, locale].filter(Boolean).join(" / ");
}

export default function timeToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "current_time",
    label: "Current Time",
    description: "获取当前日期、时间、星期、时区与地区。涉及\"现在/今天/几号/周几/多久之后\"时必须调用。",
    promptSnippet: "current_time: get the current date, time, weekday, timezone and region",
    promptGuidelines: [
      "涉及时间的问题（现在几点、今天几号、周几、某任务还有多久）一律先调用本工具，不要凭印象或推算。",
      "问其他地区/国家的时间（纽约几点、伦敦现在什么时候）时，传 timezone 参数（中文城市名即可），不要自己算时差。",
      "回答\"下周三\"\"三天后\"这类相对日期时，用返回的日期对照表直接查，不要自己做日期运算（外地时间的日期表按当地时间算）。",
      "用户问地点/地区时，用本工具返回的地区信息回答；没有更精确的定位能力，不要编造城市或位置。",
    ],
    parameters: SCHEMA,
    async execute(_id, params) {
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      const W = ["日", "一", "二", "三", "四", "五", "六"];

      // 指定时区：只回答该地区的当前时间与相对本地的时差
      const rawZone = String(params.timezone ?? "").trim();
      if (rawZone) {
        const zone = resolveZone(rawZone);
        if (!zone) {
          return text(
            `无法识别地区「${rawZone}」。可用中文名（北京/东京/纽约/伦敦/洛杉矶/悉尼…）或标准时区名（Asia/Tokyo、America/New_York、UTC）。`,
          );
        }
        const { text: localText, offsetMin } = formatInZone(d, zone);
        const localOffset = -d.getTimezoneOffset();
        const diff = offsetMin - localOffset;
        const diffStr =
          diff === 0
            ? "与本地时间相同"
            : `比本地${diff > 0 ? "快" : "慢"} ${Math.floor(Math.abs(diff) / 60)} 小时${Math.abs(diff) % 60 ? ` ${Math.abs(diff) % 60} 分` : ""}`;
        return text(`${rawZone}（${zone}，${fmtOffset(offsetMin)}）当前时间：${localText}，${diffStr}。`);
      }

      const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      const weekday = `周${W[d.getDay()]}`;

      // 本周与下周日期对照表（周一为一周之始）
      const monday = new Date(d);
      monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const dayStr = (dt: Date) => `${dt.getMonth() + 1}/${dt.getDate()}周${W[dt.getDay()]}`;
      const week: string[] = [];
      const next: string[] = [];
      for (let i = 0; i < 14; i++) {
        const x = new Date(monday);
        x.setDate(monday.getDate() + i);
        (i < 7 ? week : next).push(dayStr(x));
      }

      return text(
        [
          `当前时间：${stamp} ${weekday}`,
          `时区：${timezoneInfo(d)}`,
          `地区：${regionInfo()}`,
          `（下面的日期表仅供你自己推算相对日期用，不要原样转述给用户）`,
          `本周：${week.join(" ")}`,
          `下周：${next.join(" ")}`,
        ].join("\n"),
      );
    },
  });
}
