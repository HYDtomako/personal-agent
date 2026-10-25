export type ReplySource =
  | { channel: "gui" }
  | { channel: "qq"; target: string }
  | { channel: "telegram"; chatId: string; threadId?: number };

export function normalizeSource(value: unknown): ReplySource {
  if (value === undefined) return { channel: "gui" };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("消息来源必须为对象");
  const source = value as Record<string, unknown>;
  if (source.channel === "telegram") {
    if (typeof source.chatId !== "string" && typeof source.chatId !== "number") throw new Error("Telegram chatId 类型无效");
    const chatId = String(source.chatId);
    if (!/^-?\d+$/.test(chatId)) throw new Error("Telegram chatId 无效");
    if (source.threadId !== undefined && typeof source.threadId !== "number") throw new Error("Telegram threadId 类型无效");
    const threadId = source.threadId as number | undefined;
    if (threadId !== undefined && (!Number.isSafeInteger(threadId) || threadId < 0)) throw new Error("Telegram threadId 无效");
    return { channel: "telegram", chatId, ...(threadId === undefined ? {} : { threadId }) };
  }
  if (source.channel === "qq") {
    if (typeof source.target !== "string") throw new Error("QQ 回发目标类型无效");
    const target = source.target;
    if (!/^(private|group):\d+$/.test(target)) throw new Error("QQ 回发目标无效");
    return { channel: "qq", target };
  }
  if (source.channel !== "gui") throw new Error("消息来源无效");
  return { channel: "gui" };
}
