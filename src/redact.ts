/**
 * 输出脱敏。主进程把配置里的密钥放进 secrets；正则再兜一层常见形态，
 * 避免 Telegram URL（…/bot<id>:<token>/…）或漏进列表的 key 出现在页面和日志里。
 */

export interface RedactConfig {
  pi?: { tavilyKey?: string; aliyunKey?: string; aliyunBaseUrl?: string };
  gui?: { token?: string };
  telegram?: { token?: string; proxy?: string };
}

function remember(out: string[], seen: Set<string>, value: string | undefined): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed || seen.has(trimmed)) return;
  seen.add(trimmed);
  out.push(trimmed);
}

/** 从配置和额外运行时密钥收集要整段替换的值。无账号的代理地址不算密钥。 */
export function collectConfigSecrets(cfg: RedactConfig, extra: Array<string | undefined> = []): string[] {
  const proxy = cfg.telegram?.proxy;
  const proxyHasCreds = typeof proxy === "string" && /\/\/[^/\s:]+:[^/\s@]+@/.test(proxy);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [
    cfg.pi?.tavilyKey,
    cfg.pi?.aliyunKey,
    cfg.pi?.aliyunBaseUrl,
    cfg.gui?.token,
    cfg.telegram?.token,
    proxyHasCreds ? proxy : undefined,
    ...extra,
  ]) {
    remember(out, seen, value);
  }
  return out;
}

export function redactText(s: string, secrets: readonly string[]): string {
  let out = s;
  // 较短的密钥可能是另一把密钥的前缀，先替换长的，避免留下后半段。
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) out = out.split(secret).join("[密钥已隐藏]");
  }
  out = out.replace(/\b(?:sk|tvly)-[A-Za-z0-9_-]{8,}\b/g, "[密钥已隐藏]");
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{10,}/gi, "Bearer [已隐藏]");
  out = out.replace(/[a-z0-9-]+\.(?:cn-beijing\.)?maas\.aliyuncs\.com/gi, "[接口地址已隐藏]");
  // Bot API token 常嵌在 /bot<id>:<secret>/ 里，前面没有单词边界。
  out = out.replace(/\d{5,16}:[A-Za-z0-9_-]{20,}/g, "[密钥已隐藏]");
  return out;
}

/**
 * 增量文本脱敏：只发送已确定不会与后续块组成密钥的前缀。
 * 保留未结束的 ASCII token（覆盖 key、Bearer、bot token 和接口域名），
 * 以及配置密钥的尾部前缀；普通中文和已结束的单词仍实时发出。
 * 每个请求须持有独立实例，并在结束时调用 end()。
 */
export class StreamingRedactor {
  private pending = "";
  private readonly secrets: readonly string[];
  private readonly redact: (text: string) => string;

  constructor(redact: (text: string) => string, secrets: readonly string[] = []) {
    this.redact = redact;
    this.secrets = [...new Set(secrets.filter(Boolean))];
  }

  push(text: string): string {
    this.pending += text;
    let end = this.pending.length;
    const token = /[A-Za-z0-9_.:-]+$/.exec(this.pending);
    if (token) end = token.index;
    const bearer = /\bBearer\s+[A-Za-z0-9._-]*$/i.exec(this.pending);
    if (bearer) end = Math.min(end, bearer.index);

    for (const secret of this.secrets) {
      for (let length = Math.min(secret.length - 1, this.pending.length); length > 0; length--) {
        if (this.pending.endsWith(secret.slice(0, length))) {
          end = Math.min(end, this.pending.length - length);
          break;
        }
      }
    }
    // 切分点不能落在完整密钥内部。密钥可能重叠，调整到不再跨界为止。
    let previous: number;
    do {
      previous = end;
      for (const secret of this.secrets) {
        const index = this.pending.indexOf(secret, Math.max(0, end - secret.length + 1));
        if (index >= 0 && index < end) end = index;
      }
    } while (end !== previous);

    const ready = this.pending.slice(0, end);
    this.pending = this.pending.slice(end);
    return ready ? this.redact(ready) : "";
  }

  end(): string {
    const text = this.pending;
    this.pending = "";
    return text ? this.redact(text) : "";
  }
}
