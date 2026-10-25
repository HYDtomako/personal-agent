import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const HTTP_TIMEOUT_MS = 9000;
export const MAX_TG_LEN = 4000;

const systemClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => delay(ms, undefined, signal ? { signal } : undefined),
  timeoutSignal: (ms) => AbortSignal.timeout(ms),
};

export class TelegramBridgeError extends Error {
  constructor(kind, code, status) {
    super(code);
    this.name = "TelegramBridgeError";
    this.kind = kind;
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

const protocolError = (code) => new TelegramBridgeError("protocol", code);
const safeCode = (value) => typeof value === "string" && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : "UnknownError";

/** Never include raw messages, URLs, response bodies or headers in diagnostics. */
export function classifyError(error) {
  const chain = [];
  const pending = [error];
  const visited = new Set();
  while (pending.length && chain.length < 16) {
    const item = pending.shift();
    if (!item || typeof item !== "object" || visited.has(item)) continue;
    visited.add(item);
    chain.push(item);
    if (item.cause) pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 16));
  }
  const known = chain.find((item) => item instanceof TelegramBridgeError);
  if (known) {
    const code = safeCode(known.code);
    if (known.kind === "http") return { kind: "http", code, status: known.status, message: `HTTP ${Number(known.status) || 0}` };
    const labels = { protocol: "响应/数据协议错误", store: "本地持久化失败", capacity: "待发送回执/消息已达上限" };
    return { kind: known.kind, code, message: `${labels[known.kind] ?? "请求失败"} (${code})` };
  }
  const timeout = chain.find((item) => item.name === "TimeoutError" || ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(item.code));
  if (timeout) return { kind: "timeout", code: safeCode(typeof timeout.code === "string" ? timeout.code : timeout.name), message: "请求超时 (TimeoutError)" };
  if (chain.some((item) => item.code === "ECONNREFUSED")) {
    return { kind: "connection_refused", code: "ECONNREFUSED", message: "连接被拒绝 (ECONNREFUSED)" };
  }
  if (chain.some((item) => item.name === "AbortError")) return { kind: "aborted", code: "AbortError", message: "请求已取消 (AbortError)" };
  const cause = chain.findLast((item) => typeof item.code === "string") ?? chain.at(-1);
  const code = safeCode(cause?.code ?? cause?.name);
  return { kind: "other", code, message: `其他错误 (${code})` };
}

/** Only local, short-lived API requests. A 202 is acceptance, never a PA/CA result. */
export function createTelegramClient({ baseUrl, token = "", fetch: fetchImpl = globalThis.fetch, clock = {} }) {
  const time = { ...systemClock, ...clock };
  const base = String(baseUrl).replace(/\/+$/, "");
  async function request(route, method = "GET", body, expectedStatus = 200) {
    const signal = time.timeoutSignal(HTTP_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(`${base}${route}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { "x-token": token } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    }
    if (!response.ok || response.status !== expectedStatus) {
      // Do not log the error body: it may contain user input or secrets.
      // Body cleanup must not obscure an observed HTTP error (or delay retry).
      response.body?.cancel().catch(() => {});
      throw new TelegramBridgeError("http", "HTTP_ERROR", response.status);
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof SyntaxError) throw protocolError("INVALID_JSON");
      throw error;
    }
    if (data?.ok !== true) throw protocolError("API_NOT_OK");
    return data;
  }
  return {
    async submit({ text, chatId, threadId, updateId }) {
      const source = { channel: "telegram", chatId: String(chatId), ...(threadId == null ? {} : { threadId }) };
      const data = await request("/api/requests", "POST", {
        text, source, idempotencyKey: `telegram:${String(updateId)}`,
      }, 202);
      if (!data.request || typeof data.request.id !== "string" || !data.request.id || typeof data.request.status !== "string") {
        throw protocolError("INVALID_REQUEST_RECEIPT");
      }
      return data.request;
    },
    async notifications() {
      const data = await request("/api/notifications?channel=telegram&limit=20");
      if (!Array.isArray(data.notifications)) throw protocolError("INVALID_NOTIFICATIONS");
      return data.notifications;
    },
    async ack(id) {
      await request(`/api/notifications/${encodeURIComponent(id)}/ack`, "POST");
    },
  };
}

/** Keep each chunk within Telegram's limit without splitting a UTF-16 surrogate pair. */
export function splitTelegramText(text) {
  let rest = String(text || "（空回复）");
  const chunks = [];
  while (rest.length > MAX_TG_LEN) {
    let end = MAX_TG_LEN;
    if (/^[\uD800-\uDBFF]$/.test(rest[end - 1]) && /^[\uDC00-\uDFFF]$/.test(rest[end])) end--;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  chunks.push(rest);
  return chunks;
}

/** ASCII command-line data avoids Windows curl's Chinese/GBK argument conversion. */
export function telegramSendBody(chatId, text, threadId) {
  return new URLSearchParams({
    chat_id: String(chatId),
    text,
    disable_web_page_preview: "true",
    ...(threadId == null ? {} : { message_thread_id: String(threadId) }),
  }).toString();
}

/** Whitelist platform evidence; never retain a Bot API body, text, sender or token. */
export function normalizeTelegramReceipt(value, chatId, threadId) {
  if (value?.platform !== "telegram" || !Number.isSafeInteger(value.messageId) || value.messageId <= 0
      || typeof value.chatId !== "string" || !/^-?[1-9]\d*$/.test(value.chatId)
      || !Number.isSafeInteger(Number(value.chatId)) || value.chatId !== String(chatId)
      || !["private", "group", "supergroup", "channel"].includes(value.chatType)
      || !Number.isSafeInteger(value.date) || value.date <= 0
      || (value.threadId != null && (!Number.isSafeInteger(value.threadId) || value.threadId < 0))
      || (threadId != null && value.threadId !== threadId)) {
    throw protocolError("TELEGRAM_RECEIPT_MISMATCH");
  }
  return {
    platform: "telegram", messageId: value.messageId, chatId: value.chatId,
    chatType: value.chatType, date: value.date,
    ...(value.threadId == null ? {} : { threadId: value.threadId }),
  };
}

function auditRecord(context, receipt, textSha256) {
  if (typeof context?.notificationId !== "string" || !context.notificationId || context.notificationId.length > 512
      || /[\x00-\x1f]/.test(context.notificationId) || !Number.isSafeInteger(context.chunkIndex) || context.chunkIndex < 0
      || typeof textSha256 !== "string" || !/^[a-f0-9]{64}$/.test(textSha256)) {
    throw protocolError("TELEGRAM_AUDIT_CONTEXT_INVALID");
  }
  return {
    notificationId: context.notificationId, chunkIndex: context.chunkIndex,
    receipt: normalizeTelegramReceipt(receipt, receipt?.chatId), textSha256,
  };
}

/** One bridge instance owns this small forensic log: current + one rotation, 1 MiB each.
 * It is evidence, NOT the retry journal. Partial trailing records are ignored by readers.
 * Rotation/appending failures must never turn a confirmed send into a retry.
 */
export function createTelegramDeliveryAudit({ file, maxBytes = 1024 * 1024 }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4096) throw new TelegramBridgeError("store", "INVALID_AUDIT_LIMIT");
  return (value) => {
    const record = auditRecord(value, value.receipt, value.textSha256);
    // Start on a fresh line even after a power loss left an incomplete previous line.
    const line = `\n${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > maxBytes) throw new TelegramBridgeError("store", "AUDIT_RECORD_TOO_LARGE");
    mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try { size = statSync(file).size; } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (size + bytes > maxBytes) {
      try { unlinkSync(`${file}.1`); } catch (error) { if (error.code !== "ENOENT") throw error; }
      renameSync(file, `${file}.1`);
    }
    const fd = openSync(file, "a", 0o600);
    try { writeFileSync(fd, line, "utf8"); fsyncSync(fd); }
    finally { closeSync(fd); }
  };
}

/** sendRequest returns Telegram's result, not its envelope. No I/O at construction.
 * An optional fourth argument links a chunk to its notification. Audit is deliberately
 * outside the send failure path: disk failure means missing evidence, NOT unsent text.
 */
export function createTelegramSender({ sendRequest, appendAudit, log = () => {} }) {
  return async (chatId, text, threadId, context) => {
    let message, receipt;
    try {
      message = await sendRequest(chatId, text, threadId);
      if (!Number.isSafeInteger(message?.chat?.id)) throw protocolError("TELEGRAM_RECEIPT_MISMATCH");
      receipt = normalizeTelegramReceipt({
        platform: "telegram", messageId: message?.message_id, chatId: String(message.chat.id),
        chatType: message.chat.type, date: message.date, threadId: message.message_thread_id,
      }, chatId, threadId);
    } catch (error) {
      return { ok: false, error };
    }
    if (appendAudit && context !== undefined) {
      try {
        // Hash the actual confirmed Bot API text, not merely the intended request.
        if (typeof message.text !== "string" || message.text !== text) throw protocolError("TELEGRAM_AUDIT_TEXT_MISMATCH");
        await appendAudit(auditRecord(context, receipt, createHash("sha256").update(message.text).digest("hex")));
      } catch {
        // Neither raw exception text nor even a throwing logger may escape this path.
        try { log("Telegram 已确认发送；审计未保存 (TELEGRAM_AUDIT_FAILED)，不因此重发，平台证据可能缺失。"); } catch { /* already sent */ }
      }
    }
    return { ok: true, receipt };
  };
}

function validProgress(item) {
  return Number.isSafeInteger(item.nextChunk) && item.nextChunk >= 0;
}

function loadState(store) {
  const loaded = store.load();
  const state = structuredClone(loaded ?? { offset: 0 });
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new TelegramBridgeError("store", "INVALID_STATE");
  state.offset = Number(state.offset ?? 0);
  state.localReplies ??= [];
  state.receipts ??= [];
  if (!Number.isSafeInteger(state.offset) || state.offset < 0 || !Array.isArray(state.localReplies) || !Array.isArray(state.receipts)) {
    throw new TelegramBridgeError("store", "INVALID_STATE");
  }
  const ids = new Set();
  for (const receipt of state.receipts) {
    if (!receipt || typeof receipt.id !== "string" || !receipt.id || ids.has(receipt.id) || !validProgress(receipt)
        || !Number.isSafeInteger(receipt.chunkCount) || receipt.chunkCount < 1 || receipt.nextChunk > receipt.chunkCount
        || typeof receipt.fingerprint !== "string") throw new TelegramBridgeError("store", "INVALID_RECEIPT");
    ids.add(receipt.id);
  }
  for (const reply of state.localReplies) {
    if (!reply || typeof reply.id !== "string" || typeof reply.chatId !== "string" || typeof reply.text !== "string"
        || !validProgress(reply) || reply.nextChunk > splitTelegramText(reply.text).length
        || (reply.threadId != null && !Number.isSafeInteger(reply.threadId))) throw new TelegramBridgeError("store", "INVALID_LOCAL_REPLY");
  }
  state.version = 1;
  return state;
}

function notificationPayload(notification) {
  if (!notification || typeof notification.id !== "string" || !notification.id || notification.source?.channel !== "telegram"
      || typeof notification.source.chatId !== "string" || !notification.source.chatId || typeof notification.text !== "string"
      || (notification.source.threadId != null && !Number.isSafeInteger(notification.source.threadId))) {
    throw protocolError("INVALID_NOTIFICATION");
  }
  const { chatId, threadId } = notification.source;
  const chunks = splitTelegramText(notification.text);
  const fingerprint = createHash("sha256").update(JSON.stringify([chatId, threadId ?? null, notification.text])).digest("hex");
  return { chatId, threadId, chunks, fingerprint };
}

/**
 * No startup side effects. All I/O is injected; store.load/save are synchronous,
 * and save must atomically persist the entire snapshot before returning.
 * One receiver and one delivery loop share synchronous state commits, never a
 * network lock. Persisted nextChunk prevents resending confirmed chunks on retry.
 * Telegram has no idempotency key: a lost send response or a crash between send
 * and receipt commit can still duplicate a chunk (at-least-once, not exactly-once).
 */
export function createTelegramBridge({
  api, getUpdates, send, store, allowFrom = [], clock = {}, log = () => {},
  retryMs = 2000, deliveryIntervalMs = 1000, receiveIntervalMs = 100,
  logCooldownMs = 60_000, maxReceipts = 100, maxLocalReplies = 100,
}) {
  const time = { ...systemClock, ...clock };
  const allowed = allowFrom.map(String);
  const state = loadState(store);
  const lastLog = new Map();
  let dirty = false;

  function report(scope, error) {
    const info = classifyError(error);
    const key = `${scope}:${info.kind}:${info.status ?? info.code}`;
    const now = time.now();
    if (lastLog.has(key) && now - lastLog.get(key) < logCooldownMs) return;
    if (lastLog.size >= 100) lastLog.delete(lastLog.keys().next().value);
    lastLog.set(key, now);
    log(`${scope}：${info.message}；保留状态，稍后重试。`);
  }

  function persist() {
    // Keep successful send progress in memory even if the disk write fails.
    // No further polling/sending is allowed until this dirty snapshot is saved.
    dirty = true;
    try {
      store.save(structuredClone(state));
      dirty = false;
    } catch {
      throw new TelegramBridgeError("store", "STATE_WRITE_FAILED");
    }
  }
  function flush() { if (dirty) persist(); }

  async function acceptUpdate(update) {
    const message = update.message;
    if (!message) return; // Explicitly ignored, safe to advance.
    const fromId = String(message.from?.id ?? "");
    if (allowed.length && !allowed.includes(fromId)) return;
    if (message.chat?.id == null) return;
    const chatId = String(message.chat.id);
    const threadId = message.message_thread_id;
    if (threadId != null && !Number.isSafeInteger(threadId)) throw protocolError("INVALID_THREAD_ID");
    const text = String(message.text ?? message.caption ?? "").trim();
    let localText;
    if (text === "/start") {
      localText = "咕嘎一号在线。直接发消息就能使唤，本机读写、命令、联网都能干。";
    } else if (!allowed.length) {
      localText = `当前未配置白名单，暂不转发。\n你的 Telegram id 是：${fromId}\n把它加进 config.json 的 telegram.allowFrom 后重启本脚本。`;
    }
    if (localText !== undefined) {
      if (state.localReplies.length >= maxLocalReplies) throw new TelegramBridgeError("capacity", "LOCAL_REPLY_LIMIT");
      state.localReplies.push({ id: `telegram:${update.update_id}`, chatId, ...(threadId == null ? {} : { threadId }), text: localText, nextChunk: 0 });
      return; // Queued durably with the offset below, never wait for sendMessage.
    }
    if (!text) return;
    await api.submit({ text, chatId, threadId, updateId: update.update_id });
    log(`已提交 Telegram update ${update.update_id}；回复由 outbox 投递。`);
  }

  async function receiveOnce() {
    flush();
    const updates = await getUpdates(state.offset);
    if (!Array.isArray(updates) || updates.some((item) => !Number.isSafeInteger(item?.update_id) || item.update_id < 0 || item.update_id === Number.MAX_SAFE_INTEGER)) {
      throw protocolError("INVALID_UPDATES");
    }
    for (const update of [...updates].sort((a, b) => a.update_id - b.update_id)) {
      flush();
      if (update.update_id < state.offset) continue;
      // If this POST fails, throw before committing offset or visiting later updates.
      await acceptUpdate(update);
      state.offset = update.update_id + 1;
      persist();
    }
    return updates.length;
  }

  async function sendChunks(progress, { chatId, threadId, chunks }) {
    for (let index = progress.nextChunk; index < chunks.length; index++) {
      flush();
      let result;
      try {
        result = await send(chatId, chunks[index], threadId, { notificationId: progress.id, chunkIndex: index });
        if (!(result === true || result?.ok === true)) {
          report("Telegram 发送", result?.error ?? protocolError("SEND_NOT_CONFIRMED"));
          return false;
        }
      } catch (error) {
        report("Telegram 发送", error);
        return false;
      }
      progress.nextChunk = index + 1;
      persist(); // Persist every confirmed chunk, not only the final one.
    }
    return true;
  }

  async function acknowledge(receipt) {
    flush();
    try {
      await api.ack(receipt.id);
    } catch (error) {
      report("outbox ACK", error);
      return false;
    }
    state.receipts = state.receipts.filter((item) => item.id !== receipt.id);
    persist(); // A crash here only repeats an idempotent ACK, never a send.
    return true;
  }

  async function deliverOnce() {
    flush();
    // /start and empty-allowlist responses use this loop too, not getUpdates.
    for (const reply of [...state.localReplies]) {
      const sent = await sendChunks(reply, { ...reply, chunks: splitTelegramText(reply.text) });
      if (sent) {
        state.localReplies = state.localReplies.filter((item) => item.id !== reply.id);
        persist();
      }
    }
    const visited = new Set();
    // ACK-only recovery works even if GET fails or no longer lists the notification.
    for (const receipt of [...state.receipts]) {
      if (receipt.nextChunk === receipt.chunkCount) {
        visited.add(receipt.id);
        await acknowledge(receipt);
      }
    }
    const notifications = await api.notifications();
    for (const notification of notifications) {
      let payload;
      try {
        payload = notificationPayload(notification);
      } catch (error) {
        report("outbox 数据", error);
        continue; // Invalid notifications are not ACKed as if they were sent.
      }
      if (visited.has(notification.id)) continue;
      visited.add(notification.id);
      let receipt = state.receipts.find((item) => item.id === notification.id);
      if (!receipt) {
        if (state.receipts.length >= maxReceipts) {
          report("outbox 容量", new TelegramBridgeError("capacity", "RECEIPT_LIMIT"));
          continue; // Never evict an unacknowledged receipt just to make room.
        }
        receipt = { id: notification.id, nextChunk: 0, chunkCount: payload.chunks.length, fingerprint: payload.fingerprint };
        state.receipts.push(receipt);
        persist();
      }
      if (receipt.fingerprint !== payload.fingerprint || receipt.chunkCount !== payload.chunks.length) {
        report("outbox 数据", protocolError("NOTIFICATION_CHANGED"));
        continue;
      }
      if (await sendChunks(receipt, payload)) await acknowledge(receipt);
    }
  }

  async function loop(step, intervalMs, scope, signal) {
    while (!signal?.aborted) {
      let wait = intervalMs;
      try {
        await step();
      } catch (error) {
        if (signal?.aborted) break;
        report(scope, error);
        wait = retryMs;
      }
      if (signal?.aborted) break;
      try {
        await time.sleep(wait, signal);
      } catch (error) {
        if (!signal?.aborted) throw error;
      }
    }
  }

  return {
    receiveOnce,
    deliverOnce,
    snapshot: () => structuredClone(state),
    runReceiver: ({ signal } = {}) => loop(receiveOnce, receiveIntervalMs, "入口接收/提交", signal),
    runDelivery: ({ signal } = {}) => loop(deliverOnce, deliveryIntervalMs, "outbox 拉取/投递", signal),
    async run({ signal } = {}) {
      await Promise.all([
        loop(receiveOnce, receiveIntervalMs, "入口接收/提交", signal),
        loop(deliverOnce, deliveryIntervalMs, "outbox 拉取/投递", signal),
      ]);
    },
  };
}
