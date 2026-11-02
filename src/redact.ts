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
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[密钥已隐藏]");
  }
  out = out.replace(/\b(?:sk|tvly)-[A-Za-z0-9_-]{8,}\b/g, "[密钥已隐藏]");
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{10,}/gi, "Bearer [已隐藏]");
  out = out.replace(/[a-z0-9-]+\.(?:cn-beijing\.)?maas\.aliyuncs\.com/gi, "[接口地址已隐藏]");
  // Bot API token 常嵌在 /bot<id>:<secret>/ 里，前面没有单词边界。
  out = out.replace(/\d{5,16}:[A-Za-z0-9_-]{20,}/g, "[密钥已隐藏]");
  return out;
}
