// Default is offline/dry-run. Only an explicit --send enables any network I/O.
// No service imports, restarts, token output, chat dumps or transport send retries.
// --send: one PA request per QQ/TG channel, using the CURRENT PA model.
// --send --direct-transport: one standalone QQ transport send, NOT PA mailbox E2E.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync, mkdirSync, openSync, writeFileSync, closeSync, fsyncSync, renameSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { normalizeTelegramReceipt } from "../app/telegram-client.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QQ_ROOT = path.resolve(ROOT, "../pi-napcatqq");
const NAPCAT_SOURCE = "D:/NapCat.Shell.Windows.Node/napcat/napcat.mjs";
const OWNER = "100000001", TG_OWNER = "100000002", BOT = "100000003";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const MAX_READ = 16 * 1024 * 1024;
const REQUEST_TIMEOUT = 9000;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const fault = () => new Error("SELFTEST_OPERATION_FAILED"); // Never echo an upstream exception.
const validId = (id) => (typeof id === "number" || typeof id === "string") && /^-?[1-9]\d*$/.test(String(id)) && Number.isSafeInteger(Number(id));
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const validTime = (seconds, startedAt, now) => Number.isSafeInteger(seconds) && seconds >= Math.floor(startedAt / 1000) - 5 && seconds <= Math.floor(now / 1000) + 60;

export function parseOptions(args) {
  const result = { send: false, directTransport: false, waitMs: 180000, help: false };
  for (const arg of args) {
    if (arg === "--send") result.send = true;
    else if (arg === "--direct-transport") result.directTransport = true;
    else if (arg === "--help") result.help = true;
    else if (/^--wait-ms=\d+$/.test(arg)) result.waitMs = Number(arg.slice(10));
    else throw fault();
  }
  if (!Number.isSafeInteger(result.waitMs) || result.waitMs < 1000 || result.waitMs > 600000) throw fault();
  return result;
}

/** No configurable recipient overrides: unknown/multiple TG targets fail closed. */
export function validateSettings(pa, qq, root = ROOT, qqRoot = QQ_ROOT) {
  const t = pa?.telegram, b = qq?.bot;
  const port = Number(pa?.gui?.port ?? 8787);
  const mailboxDir = path.join(qqRoot, "memory", "bridge");
  if (String(b?.owner) !== OWNER || String(b?.selfId) !== BOT || !Array.isArray(b?.whitelist)
      || !b.whitelist.map(String).includes(OWNER) || !Array.isArray(t?.allowFrom)
      || t.allowFrom.length !== 1 || String(t.allowFrom[0]) !== TG_OWNER || t.enabled === false
      || typeof t.token !== "string" || !t.token.trim() || !Number.isInteger(port) || port < 1 || port > 65535
      || typeof qq?.onebot?.token !== "string" || !qq.onebot.token.trim()
      || (pa.delegations?.qqBridgeDir != null && !samePath(pa.delegations.qqBridgeDir, mailboxDir))) throw fault();
  let ws;
  try { ws = new URL(qq.onebot.wsUrl); } catch { throw fault(); }
  if (ws.protocol !== "ws:" || ws.hostname !== "127.0.0.1" || ws.port !== "3001"
      || ws.username || ws.password || ws.search || ws.hash || ws.pathname !== "/") throw fault();
  return {
    root, qqRoot, owner: OWNER, telegramOwner: TG_OWNER, bot: BOT,
    baseUrl: `http://127.0.0.1:${port}`, guiToken: String(pa.gui?.token ?? "").trim(),
    wsUrl: ws.href, wsToken: qq.onebot.token.trim(),
    mailboxFile: path.join(mailboxDir, "to-qq.jsonl"),
    notificationsFile: path.join(root, "memory", "notifications.json"),
    auditFile: path.join(root, "memory", "telegram-deliveries.jsonl"),
  };
}

function boundedRead(file, limit = MAX_READ) {
  if (statSync(file).size > limit) throw fault();
  const text = readFileSync(file, "utf8");
  if (Buffer.byteLength(text) > limit) throw fault();
  return text;
}

export function loadSettings() {
  return validateSettings(JSON.parse(boundedRead(path.join(ROOT, "config.json"), 256 * 1024)),
    JSON.parse(boundedRead(path.join(QQ_ROOT, "config.json"), 256 * 1024)));
}

/** Only call history with a schema verified in the installed source, not guessed fields.
 * Inspected installation: GetFriendMsgHistory, user_id string/count number, optional
 * message_seq string (omit for latest); messages array; get_msg accepts number|string.
 * A changed/unreadable installation disables these reads instead of guessing.
 */
export function inspectInstalledActions(source) {
  function before(name, size) {
    const index = source.indexOf(`actionName = re.${name};`);
    return index < 0 ? "" : source.slice(Math.max(0, index - size), index);
  }
  const history = before("GetFriendMsgHistory", 1600);
  const getMsg = before("GetMsg", 1800);
  return {
    history: source.includes('GetFriendMsgHistory: "get_friend_msg_history"')
      && /user_id: p\.String\(/.test(history) && /message_seq: p\.Optional\(p\.String\(/.test(history)
      && /count: p\.Number\(/.test(history) && /messages: p\.Array\(/.test(history),
    getMsg: source.includes('GetMsg: "get_msg"') && /message_id: p\.Union\(\[p\.Number\(\), p\.String\(\)\]/.test(getMsg),
    direct: source.includes('SendPrivateMsg: "send_private_msg"') && source.includes("actionName = re.SendPrivateMsg;")
      && /user_id: p\.Optional\(p\.String\(/.test(source) && source.includes("message: Tg"),
  };
}

function installedActions() {
  try { return inspectInstalledActions(boundedRead(NAPCAT_SOURCE, 64 * 1024 * 1024)); }
  catch { return { history: false, getMsg: false, direct: false }; }
}

export function makeProbe(channel, runId, direct = false) {
  if (!["qq", "telegram"].includes(channel) || !UUID.test(runId)) throw fault();
  const expected = `本人投递自检 ${direct ? "QQ独立传输非PA端到端" : channel === "qq" ? "QQ" : "TG"} ${runId}-${channel}`;
  const source = channel === "qq" ? { channel: "qq", target: `private:${OWNER}` } : { channel: "telegram", chatId: TG_OWNER };
  const text = `这是本人授权的一次投递自检。不要调用任何工具，不要分析、解释或添加格式。仅原样回复下一行纯文本（不加引号、不换行）：\n${expected}`;
  if (text.length >= 400 || expected.length >= 400) throw fault();
  return { channel, source, expected, textSha256: hash(expected), idempotencyKey: `delivery-selftest:${runId}:${channel}`, text };
}

function expectedSource(source, spec) {
  return source?.channel === spec.channel && (spec.channel === "qq"
    ? source.target === spec.source.target
    : source.chatId === spec.source.chatId && source.threadId == null);
}

/** Private state is inspected only for this exact notification and recipient. */
export function readOwnNotification(settings, spec, requestId) {
  try {
    const state = JSON.parse(boundedRead(settings.notificationsFile));
    const note = state.notifications?.find((item) => item?.id === `reply:${requestId}`);
    if (!note || !expectedSource(note.source, spec)) return { found: false };
    return { found: true, textMatches: note.text === spec.expected, acked: typeof note.ackedAt === "string" && Number.isFinite(Date.parse(note.ackedAt)) };
  } catch { return { found: false }; }
}

export function readOwnMailbox(settings, requestId) {
  try {
    const lines = boundedRead(settings.mailboxFile).split("\n");
    let pending = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      const item = JSON.parse(line);
      if (item?.notificationId === `reply:${requestId}` && item.type === "private" && String(item.id) === settings.owner) pending = true;
    }
    return { readable: true, pending };
  } catch { return { readable: false, pending: false }; }
}

/** A notification ACK is deliberately NOT used as Telegram platform evidence. */
export function matchTelegramEvidence(lines, { requestId, spec, startedAt, now }) {
  const matches = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item.notificationId !== `reply:${requestId}` || item.chunkIndex !== 0 || item.textSha256 !== spec.textSha256) continue;
      const receipt = normalizeTelegramReceipt(item.receipt, TG_OWNER);
      if (receipt.chatType !== "private" || receipt.threadId != null || !validTime(receipt.date, startedAt, now)) continue;
      matches.set(String(receipt.messageId), { messageId: String(receipt.messageId), date: receipt.date });
    } catch { /* Ignore an incomplete append/corrupt record; never invent a receipt. */ }
  }
  return [...matches.values()];
}

function readTelegramEvidence(settings, context) {
  const lines = [];
  for (const file of [`${settings.auditFile}.1`, settings.auditFile]) {
    try { lines.push(...boundedRead(file, 1024 * 1024 + 4096).split("\n")); }
    catch { /* Missing evidence is unconfirmed, not an excuse to resend. */ }
  }
  return matchTelegramEvidence(lines, context);
}

function plainText(message) {
  if (typeof message?.message === "string") return message.message;
  if (!Array.isArray(message?.message) || message.message.some((part) => part?.type !== "text" || typeof part.data?.text !== "string")) return null;
  return message.message.map((part) => part.data.text).join("");
}

/** History responses are scoped by user_id=owner. Their get_msg results in this
 * NapCat build omit target_id; a matching scoped candidate supplies that binding.
 * Unscoped self events MUST have the owner's target_id, never just a bot sender.
 */
export function matchQQMessage(message, { expected, startedAt, now, scopedHistory = false, candidateId }) {
  if (message?.message_type !== "private" || message.group_id != null || String(message.sender?.user_id) !== BOT
      || String(message.user_id) !== BOT || (message.self_id != null && String(message.self_id) !== BOT)
      || !validId(message.message_id) || !validTime(message.time, startedAt, now) || plainText(message) !== expected
      || (candidateId != null && String(message.message_id) !== String(candidateId))
      || (message.target_id != null && String(message.target_id) !== OWNER)
      || (!scopedHistory && (String(message.target_id) !== OWNER || (message.post_type !== "message_sent" && message.message_sent_type !== "self")))) return null;
  return { messageId: String(message.message_id), date: message.time };
}

/** Forward WS, Bearer authentication, echo-correlated responses, no auto-reconnect.
 * No event bodies or raw errors escape; callers retain only matched probe IDs.
 */
export async function openOneBot(settings, onEvent, { WebSocket, timeoutMs = REQUEST_TIMEOUT } = {}) {
  if (!WebSocket) WebSocket = createRequire(path.join(settings.qqRoot, "package.json"))("ws");
  const socket = new WebSocket(settings.wsUrl, {
    headers: { Authorization: `Bearer ${settings.wsToken}` }, handshakeTimeout: timeoutMs, maxPayload: 1024 * 1024,
  });
  const pending = new Map();
  let sequence = 0, closed = false;
  const prefix = randomUUID();
  const failAll = () => {
    closed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(fault()); }
    pending.clear();
  };
  socket.on("error", failAll);
  socket.on("close", failAll);
  socket.on("message", (raw) => {
    let value;
    try { value = JSON.parse(String(raw)); } catch { return; }
    if (typeof value?.echo === "string") {
      const item = pending.get(value.echo);
      if (!item) return;
      pending.delete(value.echo);
      clearTimeout(item.timer);
      if (value.status === "ok" && value.retcode === 0) item.resolve(value.data);
      else item.reject(fault());
    } else {
      try { onEvent(value); } catch { /* No unrelated chat/error output. */ }
    }
  });
  try {
    await new Promise((resolve, reject) => {
      const done = (error) => {
        clearTimeout(timer);
        socket.off("open", opened); socket.off("error", failed); socket.off("close", failed);
        if (error) reject(fault()); else resolve();
      };
      const opened = () => done(), failed = () => done(true);
      const timer = setTimeout(failed, timeoutMs);
      socket.once("open", opened); socket.once("error", failed); socket.once("close", failed);
    });
  } catch { socket.terminate(); throw fault(); }
  return {
    call(action, params) {
      if (closed || socket.readyState !== 1) return Promise.reject(fault());
      const echo = `${prefix}:${++sequence}`;
      return new Promise((resolve, reject) => {
        const expire = () => { const item = pending.get(echo); if (item) { pending.delete(echo); clearTimeout(item.timer); reject(fault()); } };
        const timer = setTimeout(expire, timeoutMs);
        pending.set(echo, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ action, params, echo }), (error) => { if (error) expire(); }); }
        catch { expire(); }
      });
    },
    close() { failAll(); socket.terminate(); },
  };
}

export function createReportWriter(root, runId) {
  const directory = path.join(root, "memory", "selftest-evidence");
  const file = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${runId}.json`);
  return {
    file,
    save(rows) {
      // Exactly these six fields; no request/response payload, model text or secrets.
      const safe = rows.map(({ requestId, channel, recipientId, platformMessageId, result, time }) => ({ requestId, channel, recipientId, platformMessageId, result, time }));
      mkdirSync(directory, { recursive: true });
      const temporary = `${file}.tmp`;
      let fd;
      try {
        fd = openSync(temporary, "w", 0o600);
        writeFileSync(fd, JSON.stringify(safe, null, 2) + "\n"); fsyncSync(fd); closeSync(fd); fd = undefined;
        renameSync(temporary, file);
      } finally {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    },
  };
}

/** Dependency-injected for offline fakes. No network constructor is touched in dry-run. */
export async function runDeliverySelftest(settings, options = {}, deps = {}) {
  const now = deps.now ?? Date.now, pause = deps.sleep ?? sleep;
  const runId = deps.runId ?? randomUUID();
  const startedAt = now();
  const direct = options.directTransport === true;
  const specs = (direct ? ["qq"] : ["qq", "telegram"]).map((channel) => makeProbe(channel, runId, direct));
  const rows = specs.map((spec) => ({
    requestId: null, channel: spec.channel, recipientId: spec.channel === "qq" ? OWNER : TG_OWNER,
    platformMessageId: null, result: "dry-run-no-network", time: new Date(now()).toISOString(),
  }));
  const save = () => deps.save?.(structuredClone(rows));
  save(); // A tiny checkpoint report; never an unattended full-message log.
  if (options.send !== true) return rows;
  const actions = deps.actions ?? installedActions();
  const candidates = new Map();
  let ws;
  try {
    ws = await (deps.openOneBot ?? openOneBot)(settings, (event) => {
      const match = matchQQMessage(event, { expected: specs[0].expected, startedAt, now: now() });
      if (match && candidates.size < 5) candidates.set(match.messageId, match);
    });
    const login = await ws.call("get_login_info", {});
    if (String(login?.user_id) !== BOT) throw fault();
  } catch {
    ws?.close();
    rows.forEach((row) => { row.result = "preflight-refused-no-send"; });
    save(); return rows;
  }
  try {
    if (direct) {
      if (!actions.direct) rows[0].result = "direct-action-unverified-no-send";
      else {
        rows[0].result = "unknown-direct-send"; save();
        try {
          const response = await ws.call("send_private_msg", { user_id: OWNER, message: [{ type: "text", data: { text: specs[0].expected } }] });
          if (validId(response?.message_id)) {
            rows[0].platformMessageId = String(response.message_id);
            rows[0].result = "direct-transport-confirmed-not-pa-e2e-not-read";
          }
        } catch { /* Lost response: unknown; NEVER repeat a send. */ }
      }
      rows[0].time = new Date(now()).toISOString(); save(); return rows;
    }
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    async function api(route, body) {
      let response;
      try {
        response = await fetchImpl(`${settings.baseUrl}${route}`, {
          method: body === undefined ? "GET" : "POST", redirect: "error",
          headers: { ...(settings.guiToken ? { "x-token": settings.guiToken } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        });
        if (response.status !== (body === undefined ? 200 : 202)) { await response.body?.cancel(); throw fault(); }
        const value = await response.json();
        if (value?.ok !== true || !UUID.test(value.request?.id)) throw fault();
        return value.request;
      } catch { throw fault(); }
    }
    const deadline = now() + (options.waitMs ?? 180000);
    const states = specs.map((spec, index) => ({ spec, row: rows[index], terminal: false, done: false, historyTries: 0, nextHistory: 0, checkedIds: new Set() }));
    for (const state of states) {
      state.row.result = "unknown-submit"; save();
      try {
        const request = await api("/api/requests", { text: state.spec.text, source: state.spec.source, idempotencyKey: state.spec.idempotencyKey });
        state.row.requestId = request.id;
        state.row.result = "submitted-awaiting-terminal";
      } catch { state.done = true; } // POST may have succeeded. No automatic retry, even with idempotencyKey.
      save();
    }
    const noteReader = deps.readNotification ?? readOwnNotification;
    const mailboxReader = deps.readMailbox ?? readOwnMailbox;
    const auditReader = deps.readTelegramEvidence ?? readTelegramEvidence;
    for (let poll = 0; poll < 600 && now() < deadline && states.some((state) => !state.done); poll++) {
      for (const state of states) {
        if (state.done) continue;
        const { row, spec } = state;
        if (!state.terminal) {
          let request;
          try { request = await api(`/api/requests/${encodeURIComponent(row.requestId)}`); }
          catch { row.result = "unknown-request-status"; continue; }
          if (request.id !== row.requestId || !expectedSource(request.source, spec)) { row.result = "request-source-mismatch"; state.done = true; continue; }
          if (!TERMINAL.has(request.status)) continue;
          state.terminal = true;
          if (request.status !== "completed") { row.result = `request-${request.status}-platform-unconfirmed`; state.done = true; continue; }
          if (request.reply !== spec.expected) { row.result = "reply-mismatch-platform-unconfirmed"; state.done = true; continue; }
        }
        if (spec.channel === "telegram") {
          const evidence = auditReader(settings, { requestId: row.requestId, spec, startedAt, now: now() });
          if (evidence.length) {
            row.platformMessageId = evidence.length === 1 ? evidence[0].messageId : evidence.slice(0, 10).map((item) => item.messageId);
            row.result = evidence.length === 1 ? "platform-confirmed-not-read" : "platform-confirmed-multiple-not-read";
            row.time = new Date(evidence[0].date * 1000).toISOString(); state.done = true;
          } else row.result = "telegram-platform-unconfirmed";
          continue;
        }
        const note = noteReader(settings, spec, row.requestId), mailbox = mailboxReader(settings, row.requestId);
        if (note.found && !note.textMatches) { row.result = "notification-mismatch-platform-unconfirmed"; state.done = true; continue; }
        row.result = note.acked && mailbox.readable && !mailbox.pending ? "pa-mailbox-consumed-platform-unconfirmed"
          : mailbox.pending ? "pa-mailbox-pending-platform-unconfirmed" : "pa-mailbox-state-unknown-platform-unconfirmed";
        // At most three small owner-only history reads, only after this PA reply was handed off.
        if (actions.history && actions.getMsg && note.acked && state.historyTries < 3 && now() >= state.nextHistory) {
          state.historyTries++; state.nextHistory = now() + 5000;
          try {
            const history = await ws.call("get_friend_msg_history", { user_id: OWNER, count: 5 });
            for (const message of Array.isArray(history?.messages) ? history.messages.slice(0, 5) : []) {
              const match = matchQQMessage(message, { expected: spec.expected, startedAt, now: now(), scopedHistory: true });
              if (match && candidates.size < 5) candidates.set(match.messageId, match);
            }
          } catch { /* Read unavailable. Mailbox ACK remains explicitly unconfirmed. */ }
        }
        if (actions.getMsg) for (const candidate of candidates.values()) {
          if (state.checkedIds.has(candidate.messageId)) continue;
          state.checkedIds.add(candidate.messageId);
          try {
            const message = await ws.call("get_msg", { message_id: Number(candidate.messageId) });
            const match = matchQQMessage(message, { expected: spec.expected, startedAt, now: now(), scopedHistory: true, candidateId: candidate.messageId });
            if (match) {
              row.platformMessageId = match.messageId; row.result = "platform-confirmed-not-read";
              row.time = new Date(match.date * 1000).toISOString(); state.done = true; break;
            }
          } catch { /* No send fallback. A lone self-event is insufficient. */ }
        }
      }
      save();
      if (states.some((state) => !state.done) && now() < deadline) await pause(Math.min(1000, deadline - now()));
    }
    for (const state of states) {
      if (!state.done && !state.terminal) state.row.result = "unknown-terminal-timeout";
      if (!state.row.platformMessageId) state.row.time = new Date(now()).toISOString();
    }
    save(); return rows;
  } finally { ws.close(); }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log("默认 dry-run（零网络）。--send 每个QQ/TG渠道提交一次PA自检；--send --direct-transport 仅直接发送一条QQ消息，不是PA信箱端到端；--wait-ms=180000，最大600000。目标固定本人，凭据只读配置，不输出。所有平台确认均不是已读回执。");
    return;
  }
  const settings = loadSettings();
  const runId = randomUUID(), report = createReportWriter(settings.root, runId);
  const rows = await runDeliverySelftest(settings, options, { runId, save: report.save });
  console.log(JSON.stringify(rows, null, 2));
  if (rows.some((row) => row.result === "pa-mailbox-consumed-platform-unconfirmed")) console.log("PA信箱已消费、平台未确认；不会额外发送或宣称已读。");
  console.log(`取证报告 ${report.file}`);
  if (options.send && rows.some((row) => !["platform-confirmed-not-read", "direct-transport-confirmed-not-pa-e2e-not-read"].includes(row.result))) process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error("SELFTEST_FAILED：配置、参数或本地取证写盘失败；未输出原始错误。若已启用发送，不要盲目重跑，请检查现有取证报告。"); process.exitCode = 2; });
}
