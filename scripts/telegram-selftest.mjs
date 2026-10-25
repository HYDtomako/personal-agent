// Offline only: no tg-bridge startup, real configuration reads, curl, Telegram or models.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  HTTP_TIMEOUT_MS, TelegramBridgeError, classifyError, createTelegramClient,
  createTelegramBridge, splitTelegramText, telegramSendBody,
  createTelegramSender, createTelegramDeliveryAudit, normalizeTelegramReceipt,
} from "../app/telegram-client.mjs";
import {
  parseOptions, validateSettings, makeProbe, matchTelegramEvidence, matchQQMessage,
  runDeliverySelftest, openOneBot, createReportWriter, readOwnMailbox, readOwnNotification,
  inspectInstalledActions,
} from "./delivery-live-selftest.mjs";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const networkError = (code = "ECONNRESET") => new TypeError("fetch failed: DO_NOT_LOG_TEST_SECRET", { cause: Object.assign(new Error("private URL"), { code }) });
const update = (id, text = "你好", extra = {}) => ({
  update_id: id,
  message: { from: { id: 7 }, chat: { id: -1001234567890 }, text, message_thread_id: 42, ...extra },
});
const notification = (id = "n1", text = "任务完成", extra = {}) => ({
  id, source: { channel: "telegram", chatId: "-1001234567890", threadId: 42 }, text, kind: "reply", createdAt: "2026-10-13T00:00:00Z", ...extra,
});
function memoryStore(initial = { offset: 0 }) {
  let disk = structuredClone(initial);
  return {
    fail: false,
    writes: 0,
    load: () => structuredClone(disk),
    save(state) {
      if (this.fail) throw Object.assign(new Error("disk unavailable"), { code: "EIO" });
      disk = structuredClone(state);
      this.writes++;
    },
  };
}
async function within(promise, ms = 1500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("offline test deadline exceeded")), ms); })]);
  } finally { clearTimeout(timer); }
}

function rig(options = {}) {
  const store = options.store ?? memoryStore();
  const calls = [];
  const sent = [];
  const logs = [];
  const offsets = [];
  const accepted = new Map();
  const pending = [...(options.notifications ?? [])];
  const deadlines = [];
  const clock = {
    now: () => 0,
    timeoutSignal: (ms) => { deadlines.push(ms); return new AbortController().signal; },
    ...options.clock,
  };
  const fakeFetch = async (url, init) => {
    const call = { url, route: new URL(url).pathname, init, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const respond = () => {
      if (call.route === "/api/requests" && init.method === "POST") {
        const key = call.body.idempotencyKey;
        if (!accepted.has(key)) accepted.set(key, { id: `request-${accepted.size + 1}`, status: "running" });
        return json({ ok: true, request: accepted.get(key) }, 202);
      }
      if (call.route === "/api/notifications" && init.method === "GET") {
        assert.equal(new URL(url).search, "?channel=telegram&limit=20");
        return json({ ok: true, notifications: pending.slice(0, 20) });
      }
      const match = call.route.match(/^\/api\/notifications\/(.+)\/ack$/);
      if (match && init.method === "POST") {
        const id = decodeURIComponent(match[1]);
        const index = pending.findIndex((item) => item.id === id);
        if (index !== -1) pending.splice(index, 1);
        return json({ ok: true });
      }
      throw new Error(`unexpected offline route: ${call.route}`);
    };
    return options.fetch ? options.fetch(call, respond) : respond();
  };
  const api = createTelegramClient({ baseUrl: "http://127.0.0.1:8787/", token: "FAKE_GUI_TOKEN", fetch: fakeFetch, clock });
  const getUpdates = async (offset) => {
    offsets.push(offset);
    return options.getUpdates ? options.getUpdates(offset) : (options.updates ?? []).filter((item) => item.update_id >= offset);
  };
  const send = async (...args) => { sent.push(args); return options.send ? options.send(...args) : { ok: true }; };
  const restart = () => createTelegramBridge({
    api, getUpdates, send, store, clock, log: (line) => logs.push(line), allowFrom: options.allowFrom ?? ["7"],
    ...options.bridgeOptions,
  });
  return { bridge: restart(), restart, api, store, calls, sent, logs, offsets, accepted, pending, deadlines };
}
const posts = (r) => r.calls.filter((call) => call.route === "/api/requests");
const acks = (r) => r.calls.filter((call) => call.route.endsWith("/ack"));

// A mistake in dependency injection must fail rather than touch any real endpoint.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Real fetch forbidden in telegram-selftest"); };
test.after(() => { globalThis.fetch = originalFetch; });

test("exact queue/outbox contract, authentication, chatId/threadId and 9s deadlines", async () => {
  const r = rig({ updates: [update(123)], notifications: [notification("id/with spaces")] });
  await r.bridge.receiveOnce();
  assert.equal(posts(r)[0].url, "http://127.0.0.1:8787/api/requests");
  assert.deepEqual(posts(r)[0].body, {
    text: "你好", source: { channel: "telegram", chatId: "-1001234567890", threadId: 42 }, idempotencyKey: "telegram:123",
  });
  assert.equal(r.store.load().offset, 124);
  assert.equal(r.sent.length, 0);
  await r.bridge.deliverOnce();
  assert.deepEqual(r.sent, [["-1001234567890", "任务完成", 42, { notificationId: "id/with spaces", chunkIndex: 0 }]]);
  assert.equal(acks(r)[0].route, "/api/notifications/id%2Fwith%20spaces/ack");
  assert(r.calls.every((call) => call.init.headers["x-token"] === "FAKE_GUI_TOKEN"));
  assert(r.deadlines.length >= 3 && r.deadlines.every((ms) => ms === 9000 && ms === HTTP_TIMEOUT_MS));
});

test("unfinished background work does not prevent a second message being accepted", async () => {
  const background = Promise.withResolvers();
  const r = rig({ updates: [update(1, "开始长任务"), update(2, "继续聊天")] });
  const completion = background.promise.then(() => r.pending.push(notification("background-complete", "后台完成")));
  await within(r.bridge.receiveOnce());
  assert.equal(r.accepted.size, 2);
  assert([...r.accepted.values()].every((request) => request.status === "running"));
  assert.equal(r.store.load().offset, 3);
  await r.bridge.deliverOnce();
  assert.equal(r.sent.length, 0);
  assert(!r.calls.some((call) => call.route.includes("external") || /^\/api\/requests\//.test(call.route)));
  background.resolve();
  await completion;
  await r.bridge.deliverOnce();
  assert.equal(r.sent[0][1], "后台完成");
});

test("actual receive and delivery loops run independently while sendMessage is blocked", async () => {
  const enteredSend = Promise.withResolvers();
  const releaseSend = Promise.withResolvers();
  const secondAccepted = Promise.withResolvers();
  const controller = new AbortController();
  let completedSend = false;
  const r = rig({
    notifications: [notification()],
    getUpdates: async (offset) => offset === 0 ? [update(1)] : offset === 2 ? [update(2)] : [],
    send: async () => { enteredSend.resolve(); await releaseSend.promise; completedSend = true; return { ok: true }; },
    fetch: (call, respond) => {
      const response = respond();
      if (call.body?.idempotencyKey === "telegram:2") secondAccepted.resolve();
      return response;
    },
    clock: { sleep: (_, signal) => delay(1, undefined, { signal }) },
  });
  const running = r.bridge.run({ signal: controller.signal });
  try {
    await within(Promise.all([enteredSend.promise, secondAccepted.promise]));
    assert.equal(r.accepted.size, 2);
    assert.equal(completedSend, false);
    assert(r.offsets.includes(2));
  } finally {
    controller.abort();
    releaseSend.resolve();
    await within(running);
  }
});

test("POST accepted then connection lost retries the identical key without skipping later updates", async () => {
  let loseFirstResponse = true;
  const r = rig({
    store: memoryStore({ offset: 50 }), updates: [update(50), update(51)],
    fetch: (call, respond) => {
      const response = respond();
      if (call.route === "/api/requests" && loseFirstResponse) { loseFirstResponse = false; throw networkError(); }
      return response;
    },
  });
  await assert.rejects(r.bridge.receiveOnce(), (error) => classifyError(error).code === "ECONNRESET");
  assert.equal(r.store.load().offset, 50);
  assert.equal(r.bridge.snapshot().offset, 50);
  assert.equal(r.accepted.size, 1);
  assert.equal(posts(r).length, 1);
  await r.restart().receiveOnce();
  assert.deepEqual(posts(r).map((call) => call.body.idempotencyKey), ["telegram:50", "telegram:50", "telegram:51"]);
  assert.equal(r.accepted.size, 2);
  assert.equal(r.store.load().offset, 52);
  assert.deepEqual(r.offsets, [50, 50]);
});

test("classifies refused, timeout, HTTP and other nested causes without leaking raw errors", () => {
  assert.equal(classifyError(networkError("ECONNREFUSED")).kind, "connection_refused");
  assert.equal(classifyError(new AggregateError([networkError("ECONNREFUSED")])).kind, "connection_refused");
  assert.equal(classifyError(new DOMException("private URL", "TimeoutError")).kind, "timeout");
  assert.equal(classifyError(networkError("UND_ERR_CONNECT_TIMEOUT")).kind, "timeout");
  assert.equal(classifyError(new TelegramBridgeError("http", "HTTP_ERROR", 500)).status, 500);
  const other = classifyError(networkError("ENOTFOUND"));
  assert.equal(other.kind, "other");
  assert.equal(other.code, "ENOTFOUND");
  assert(!other.message.includes("DO_NOT_LOG_TEST_SECRET"));
  assert.equal(classifyError(new Error("private URL")).kind, "other");
});

test("fetch and response-body timeouts retain TimeoutError, not a generic connection error", async () => {
  for (const afterHeaders of [false, true]) {
    const controller = new AbortController();
    const api = createTelegramClient({
      baseUrl: "http://offline.invalid", clock: { timeoutSignal: (ms) => { assert.equal(ms, 9000); return controller.signal; } },
      fetch: async () => {
        const timeout = () => { controller.abort(new DOMException("deadline", "TimeoutError")); throw new DOMException("aborted", "AbortError"); };
        if (!afterHeaders) return timeout();
        return { ok: true, status: 202, json: async () => timeout() };
      },
    });
    await assert.rejects(api.submit({ text: "x", chatId: "1", updateId: 1 }), (error) => classifyError(error).kind === "timeout");
  }
});

test("HTTP failures, malformed successes and unknown errors never advance offset", async () => {
  const failures = [
    () => json({ error: "DO_NOT_LOG_TEST_SECRET" }, 401),
    () => json({ error: "DO_NOT_LOG_TEST_SECRET" }, 500),
    () => json({ ok: true, request: { id: "r", status: "running" } }, 200),
    () => json({ ok: false }, 202),
    () => json({ ok: true }, 202),
    () => new Response("invalid JSON", { status: 202 }),
    () => { throw networkError("EAI_AGAIN"); },
  ];
  for (const fail of failures) {
    const r = rig({ updates: [update(1), update(2)], fetch: fail });
    await assert.rejects(r.bridge.receiveOnce());
    assert.equal(r.bridge.snapshot().offset, 0);
    assert.equal(r.store.load().offset, 0);
    assert.equal(posts(r).length, 1);
    assert.equal(r.sent.length, 0);
  }
});

test("failed/throwing/unconfirmed sends are never ACKed and remain retryable", async () => {
  for (const failure of [() => ({ ok: false }), () => undefined, () => { throw networkError(); }]) {
    let failed = true;
    const r = rig({ notifications: [notification()], send: () => failed ? failure() : { ok: true } });
    await r.bridge.deliverOnce();
    assert.equal(acks(r).length, 0);
    assert.equal(r.store.load().receipts[0].nextChunk, 0);
    assert.equal(r.pending.length, 1);
    failed = false;
    await r.bridge.deliverOnce();
    assert.equal(r.sent.length, 2);
    assert.equal(acks(r).length, 1);
    assert.equal(r.store.load().receipts.length, 0);
  }
});

test("ACK failure does not resend and persisted receipts survive restart", async () => {
  let failAck = true;
  const r = rig({
    notifications: [notification()],
    fetch: (call, respond) => call.route.endsWith("/ack") && failAck ? json({ ok: false }, 500) : respond(),
  });
  await r.bridge.deliverOnce();
  assert.equal(r.sent.length, 1);
  assert.equal(r.store.load().receipts[0].nextChunk, 1);
  await r.bridge.deliverOnce();
  assert.equal(r.sent.length, 1);
  assert.equal(acks(r).length, 2);
  const restarted = r.restart();
  await restarted.deliverOnce();
  assert.equal(r.sent.length, 1);
  failAck = false;
  await restarted.deliverOnce();
  assert.equal(r.sent.length, 1);
  assert.equal(acks(r).length, 4);
  assert.equal(r.store.load().receipts.length, 0);
});

test("ACK-only restart recovery does not require a working GET notification endpoint", async () => {
  let recovering = false;
  const r = rig({
    notifications: [notification()],
    fetch: (call, respond) => {
      if (call.route.endsWith("/ack") && !recovering) throw networkError();
      if (call.route === "/api/notifications" && recovering) return json({ ok: false }, 500);
      return respond();
    },
  });
  await r.bridge.deliverOnce();
  recovering = true;
  await assert.rejects(r.restart().deliverOnce(), (error) => classifyError(error).status === 500);
  assert.equal(r.sent.length, 1);
  assert.equal(r.store.load().receipts.length, 0);
  assert.equal(r.pending.length, 0);
});

test("partial multi-chunk success resumes at the unsent chunk after restart", async () => {
  const text = `${"甲".repeat(3999)}😀${"乙".repeat(4001)}`;
  const chunks = splitTelegramText(text);
  let attempt = 0;
  const r = rig({ notifications: [notification("chunks", text)], send: () => ({ ok: ++attempt !== 2 }) });
  await r.bridge.deliverOnce();
  assert.equal(acks(r).length, 0);
  assert.equal(r.store.load().receipts[0].nextChunk, 1);
  await r.restart().deliverOnce();
  assert.deepEqual(r.sent.map((args) => args[1]), [chunks[0], chunks[1], ...chunks.slice(1)]);
  assert(r.sent.every(([chatId, , threadId]) => chatId === "-1001234567890" && threadId === 42));
  assert.deepEqual(r.sent.map((args) => args[3]), [0, 1, 1, 2].map((chunkIndex) => ({ notificationId: "chunks", chunkIndex })));
  assert.equal(acks(r).length, 1);
  assert.equal(r.store.load().receipts.length, 0);
});

test("a notification changing under a partial receipt is not silently sent or ACKed", async () => {
  let attempt = 0;
  const r = rig({ notifications: [notification("changing", "x".repeat(5000))], send: () => ({ ok: ++attempt === 1 }) });
  await r.bridge.deliverOnce();
  r.pending[0].text = "changed";
  await r.restart().deliverOnce();
  assert.equal(r.sent.length, 2);
  assert.equal(acks(r).length, 0);
  assert(r.logs.some((line) => line.includes("NOTIFICATION_CHANGED")));
});

test("allowlist, /start, captions and explicit ignores preserve semantics without inline sends", async () => {
  const r = rig({ updates: [
    update(1, "/start"), update(2, "/start", { from: { id: 8 } }), update(3, " "),
    { update_id: 4, edited_message: { text: "ignored" } }, update(5, undefined, { text: undefined, caption: "图注" }),
  ] });
  await r.bridge.receiveOnce();
  assert.equal(posts(r).length, 1);
  assert.equal(posts(r)[0].body.text, "图注");
  assert.equal(r.sent.length, 0);
  assert.equal(r.store.load().offset, 6);
  assert.equal(r.store.load().localReplies.length, 1);
  await r.restart().deliverOnce();
  assert.match(r.sent[0][1], /^咕嘎一号在线/);
  assert.equal(r.sent[0][2], 42);
  assert.equal(r.store.load().localReplies.length, 0);
});

test("an empty allowlist only queues /start and sender-ID replies, never submits PA work", async () => {
  const r = rig({ allowFrom: [], updates: [update(1, "/start"), update(2, "hello")] });
  await r.bridge.receiveOnce();
  assert.equal(posts(r).length, 0);
  assert.equal(r.sent.length, 0);
  assert.equal(r.store.load().localReplies.length, 2);
  await r.restart().deliverOnce();
  assert.match(r.sent[0][1], /^咕嘎一号在线/);
  assert.match(r.sent[1][1], /你的 Telegram id 是：7/);
});

test("optional threadId is omitted, zero threadId is retained, chatId is a string", async () => {
  const r = rig({ updates: [update(1, "a", { message_thread_id: undefined, chat: { id: 77 } }), update(2, "b", { message_thread_id: 0 })] });
  await r.bridge.receiveOnce();
  assert.deepEqual(posts(r)[0].body.source, { channel: "telegram", chatId: "77" });
  assert.equal(posts(r)[1].body.source.threadId, 0);
});

test("failed offset persistence blocks later polling until a durable retry succeeds", async () => {
  const store = memoryStore();
  const r = rig({ store, updates: [update(1), update(2)] });
  store.fail = true;
  await assert.rejects(r.bridge.receiveOnce(), (error) => classifyError(error).kind === "store");
  assert.equal(posts(r).length, 1);
  assert.equal(store.load().offset, 0);
  await assert.rejects(r.bridge.receiveOnce());
  assert.equal(r.offsets.length, 1);
  store.fail = false;
  await r.bridge.receiveOnce();
  assert.equal(posts(r).length, 2);
  assert.equal(store.load().offset, 3);
});

test("a failed send-progress disk write does not resend within the running process", async () => {
  const store = memoryStore();
  const r = rig({ store, notifications: [notification()], send: () => { store.fail = true; return { ok: true }; } });
  await assert.rejects(r.bridge.deliverOnce(), (error) => classifyError(error).kind === "store");
  assert.equal(r.sent.length, 1);
  assert.equal(acks(r).length, 0);
  await assert.rejects(r.bridge.deliverOnce());
  assert.equal(r.sent.length, 1);
  store.fail = false;
  await r.bridge.deliverOnce();
  assert.equal(r.sent.length, 1);
  assert.equal(acks(r).length, 1);
});

test("invalid notification/ACK responses are not treated as successful delivery", async () => {
  const r = rig({ notifications: [notification("invalid", "x", { source: { channel: "telegram" } })] });
  await r.bridge.deliverOnce();
  assert.equal(r.sent.length, 0);
  assert.equal(acks(r).length, 0);
  assert.match(r.logs[0], /INVALID_NOTIFICATION/);
  const badAck = rig({ notifications: [notification()], fetch: (call, respond) => call.route.endsWith("/ack") ? json({ ok: false }) : respond() });
  await badAck.bridge.deliverOnce();
  await badAck.restart().deliverOnce();
  assert.equal(badAck.sent.length, 1);
  assert.equal(badAck.store.load().receipts.length, 1);
});

test("receipts are bounded without evicting sent-but-unacknowledged items", async () => {
  const r = rig({
    notifications: [notification("one"), notification("two")], bridgeOptions: { maxReceipts: 1 },
    fetch: (call, respond) => call.route.endsWith("/ack") ? json({ ok: false }, 500) : respond(),
  });
  await r.bridge.deliverOnce();
  await r.restart().deliverOnce();
  assert.equal(r.sent.length, 1);
  assert.equal(r.store.load().receipts.length, 1);
  assert.equal(r.store.load().receipts[0].id, "one");
  assert.equal(r.pending.length, 2);
});

test("repeated local failures log with throttling and never spam Telegram", async () => {
  const controller = new AbortController();
  let retries = 0;
  let now = 0;
  const r = rig({
    updates: [update(1)], fetch: () => { throw networkError("ECONNREFUSED"); },
    clock: { now: () => now, sleep: async () => { now += 2000; if (++retries === 4) controller.abort(); } },
  });
  await within(r.bridge.runReceiver({ signal: controller.signal }));
  assert.equal(posts(r).length, 4);
  assert.equal(r.logs.length, 1);
  assert.match(r.logs[0], /ECONNREFUSED/);
  assert(!r.logs.join(" ").includes("DO_NOT_LOG_TEST_SECRET"));
  assert(!r.logs.join(" ").includes("FAKE_GUI_TOKEN"));
  assert.equal(r.sent.length, 0);
  assert.equal(r.store.load().offset, 0);
});

test("UTF-8 form encoding stays ASCII and chunk splitting preserves emoji", () => {
  const text = `${"中".repeat(3999)}😀中文 & +`;
  const chunks = splitTelegramText(text);
  assert.equal(chunks.join(""), text);
  assert(chunks.every((chunk) => chunk.length <= 4000 && !/[\uD800-\uDBFF]$/.test(chunk)));
  const body = telegramSendBody("-1001234567890", "你好 😀 & +", 42);
  assert(/^[\x00-\x7F]+$/.test(body));
  assert.equal(new URLSearchParams(body).get("text"), "你好 😀 & +");
  assert.equal(new URLSearchParams(body).get("message_thread_id"), "42");
});

test("legacy offset state migrates while corrupt receipts fail closed", () => {
  assert.equal(rig({ store: memoryStore({ offset: 17 }) }).bridge.snapshot().offset, 17);
  assert.throws(() => rig({ store: memoryStore({ offset: 17, receipts: [{ id: "bad", nextChunk: 4, chunkCount: 1 }] }) }), /INVALID_RECEIPT/);
});

test("duplicate updates and duplicate outbox entries do not duplicate confirmed work", async () => {
  const r = rig({ updates: [update(1), update(1)], notifications: [notification(), notification()] });
  await r.bridge.receiveOnce();
  await r.bridge.deliverOnce();
  assert.equal(posts(r).length, 1);
  assert.equal(r.sent.length, 1);
  assert.equal(acks(r).length, 1);
});

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const unixTime = 1791849600;
const botMessage = (chatId, text, threadId, extra = {}) => ({
  message_id: 1234, chat: { id: Number(chatId), type: String(chatId).startsWith("-") ? "supergroup" : "private", token: "NEVER_RETAIN" },
  date: unixTime, text, ...(threadId == null ? {} : { message_thread_id: threadId }), token: "NEVER_RETAIN", ...extra,
});

test("sender validates platform receipts, strips secrets and hashes the actual confirmed text", async () => {
  const records = [];
  const send = createTelegramSender({ sendRequest: async (...args) => botMessage(...args), appendAudit: (item) => records.push(item) });
  const result = await send("100000002", "本人测试 marker", undefined, { notificationId: "reply:one", chunkIndex: 0, token: "NEVER_RETAIN" });
  assert.deepEqual(result, { ok: true, receipt: { platform: "telegram", messageId: 1234, chatId: "100000002", chatType: "private", date: unixTime } });
  assert.deepEqual(records, [{ notificationId: "reply:one", chunkIndex: 0, receipt: result.receipt, textSha256: sha256("本人测试 marker") }]);
  assert(!JSON.stringify(records).includes("NEVER_RETAIN"));
  assert(!JSON.stringify(records).includes("本人测试 marker"));
  const group = await send("-1001234567890", "group", 42, { notificationId: "reply:two", chunkIndex: 1 });
  assert.equal(group.receipt.chatType, "supergroup");
  assert.equal(group.receipt.threadId, 42); // Private-only is a live TEST rule, not a bridge restriction.
});

test("wrong target, thread, date or platform ID never creates a Telegram receipt or audit", async () => {
  const changes = [
    { chat: { id: 5, type: "private" } }, { message_id: undefined }, { message_id: 0 },
    { date: undefined }, { message_thread_id: 9 }, { chat: { id: 100000002, type: "unknown" } },
  ];
  for (const extra of changes) {
    let audited = false;
    const send = createTelegramSender({ sendRequest: () => botMessage("100000002", "x", 42, extra), appendAudit: () => { audited = true; } });
    const result = await send("100000002", "x", 42, { notificationId: "n", chunkIndex: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.receipt, undefined);
    assert.equal(audited, false);
    assert.equal(classifyError(result.error).code, "TELEGRAM_RECEIPT_MISMATCH");
  }
  assert.throws(() => normalizeTelegramReceipt({ platform: "telegram", chatId: "100000002", messageId: 2, date: unixTime, chatType: "private" }, "7"));
});

test("audit failure after a confirmed send does not cause another send or fake platform evidence", async () => {
  const logs = [];
  let sends = 0, failAck = true;
  const send = createTelegramSender({
    sendRequest: (...args) => { sends++; return botMessage(...args); },
    appendAudit: () => { throw new Error("DO_NOT_LOG_TEST_SECRET"); }, log: (line) => logs.push(line),
  });
  const r = rig({ notifications: [notification()], send, fetch: (call, respond) => call.route.endsWith("/ack") && failAck ? json({ ok: false }, 500) : respond() });
  await r.bridge.deliverOnce();
  assert.equal(r.store.load().receipts[0].nextChunk, 1);
  failAck = false;
  await r.restart().deliverOnce();
  assert.equal(sends, 1);
  assert.equal(r.store.load().receipts.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /TELEGRAM_AUDIT_FAILED/);
  assert(!logs[0].includes("DO_NOT_LOG_TEST_SECRET"));
  const throwingLog = createTelegramSender({ sendRequest: (...args) => botMessage(...args), appendAudit: () => { throw new Error(); }, log: () => { throw new Error(); } });
  assert.equal((await throwingLog("7", "x", undefined, { notificationId: "n", chunkIndex: 0 })).ok, true);
});

test("text/context audit mismatch preserves success but cannot fabricate a matching hash", async () => {
  for (const context of [{ notificationId: "n", chunkIndex: 0 }, { notificationId: "n", chunkIndex: -1 }]) {
    const records = [];
    const send = createTelegramSender({ sendRequest: () => botMessage("7", "different actual text"), appendAudit: (item) => records.push(item) });
    assert.equal((await send("7", "intended text", undefined, context)).ok, true);
    assert.equal(records.length, 0);
  }
  const records = [];
  const send = createTelegramSender({ sendRequest: (...args) => botMessage(...args), appendAudit: (item) => records.push(item) });
  assert.equal((await send("7", "x", undefined, { notificationId: "n", chunkIndex: -1 })).ok, true);
  assert.equal(records.length, 0);
  assert.equal((await send("7", "x")).ok, true); // Existing three-argument callers remain supported.
});

test("bounded JSONL audit survives ACK/restart, whitelists fields and rotates only one archive", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tg-audit-test-"));
  try {
    const file = path.join(directory, "telegram-deliveries.jsonl");
    const appendAudit = createTelegramDeliveryAudit({ file, maxBytes: 4096 });
    const r = rig({ notifications: [notification("proof")], send: createTelegramSender({ sendRequest: (...args) => botMessage(...args), appendAudit }) });
    await r.bridge.deliverOnce();
    await r.restart().deliverOnce();
    assert.equal(r.sent.length, 1);
    const record = JSON.parse(readFileSync(file, "utf8").trim());
    assert.equal(record.notificationId, "proof");
    assert.equal(record.chunkIndex, 0);
    assert.equal(record.receipt.messageId, 1234);
    assert.equal(record.textSha256, sha256("任务完成"));
    for (let index = 0; index < 50; index++) appendAudit({ ...record, notificationId: `n-${index}`, token: "NEVER_RETAIN", text: "NEVER_RETAIN" });
    assert.deepEqual(readdirSync(directory).sort(), ["telegram-deliveries.jsonl", "telegram-deliveries.jsonl.1"]);
    for (const name of readdirSync(directory)) {
      assert(statSync(path.join(directory, name)).size <= 4096);
      assert(!readFileSync(path.join(directory, name), "utf8").includes("NEVER_RETAIN"));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const probeRun = "01234567-89ab-4cde-8f01-234567890abc";
const requestQQ = "11234567-89ab-4cde-8f01-234567890abc";
const requestTG = "21234567-89ab-4cde-8f01-234567890abc";
function fakeSettings() {
  return validateSettings({ gui: { port: 8787, token: "FAKE_PA_SECRET" }, telegram: { token: "FAKE_TG_SECRET", allowFrom: ["100000002"] } },
    { onebot: { wsUrl: "ws://127.0.0.1:3001", token: "FAKE_WS_SECRET" }, bot: { owner: "100000001", selfId: "100000003", whitelist: ["100000001", "100000004"] } });
}
const qqMessage = (expected, extra = {}) => ({
  message_id: -123456, message_type: "private", user_id: 100000003, sender: { user_id: 100000003 },
  self_id: 100000003, time: unixTime, message: [{ type: "text", data: { text: expected } }], ...extra,
});

function liveRig(extra = {}) {
  const settings = fakeSettings(), calls = [], wsCalls = [], reports = [];
  let now = unixTime * 1000, closed = false;
  const specs = { qq: makeProbe("qq", probeRun), telegram: makeProbe("telegram", probeRun) };
  const deps = {
    runId: probeRun, now: () => now, sleep: async (ms) => { now += ms; },
    save: (rows) => reports.push(rows), actions: { history: true, getMsg: true, direct: true },
    openOneBot: async () => ({
      async call(action, params) {
        wsCalls.push({ action, params });
        if (action === "get_login_info") return { user_id: 100000003, token: "DO_NOT_LOG_TEST_SECRET" };
        if (action === "get_friend_msg_history") return { messages: [qqMessage("DO_NOT_DUMP_OTHER_CHAT", { message_id: 88 }), qqMessage(specs.qq.expected)] };
        if (action === "get_msg") return qqMessage(specs.qq.expected);
        if (action === "send_private_msg") return { message_id: 54321 };
        throw new Error("unexpected fake action");
      },
      close() { closed = true; },
    }),
    fetch: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, init, body });
      if (init.method === "POST") return json({ ok: true, request: { id: body.source.channel === "qq" ? requestQQ : requestTG, status: "queued" } }, 202);
      const channel = url.endsWith(requestQQ) ? "qq" : "telegram";
      return json({ ok: true, request: { id: channel === "qq" ? requestQQ : requestTG, source: specs[channel].source, status: "completed", reply: specs[channel].expected } });
    },
    readNotification: () => ({ found: true, acked: true, textMatches: true }),
    readMailbox: () => ({ readable: true, pending: false }),
    readTelegramEvidence: (_, context) => matchTelegramEvidence([JSON.stringify({
      notificationId: `reply:${requestTG}`, chunkIndex: 0, textSha256: specs.telegram.textSha256,
      receipt: { platform: "telegram", messageId: 321, chatId: "100000002", chatType: "private", date: unixTime },
    })], context),
    ...extra,
  };
  return { settings, calls, wsCalls, reports, specs, deps, closed: () => closed };
}

test("live probe defaults to zero network; source targets and short text are fixed", async () => {
  const r = liveRig({ openOneBot: () => { throw new Error("must not open"); }, fetch: () => { throw new Error("must not fetch"); } });
  const rows = await runDeliverySelftest(r.settings, {}, r.deps);
  assert(rows.every((row) => row.result === "dry-run-no-network"));
  assert.equal(parseOptions([]).send, false);
  assert.equal(parseOptions(["--direct-transport"]).send, false);
  assert.equal(parseOptions(["--send", "--wait-ms=1000"]).waitMs, 1000);
  assert.throws(() => parseOptions(["--recipient=7"]));
  assert.throws(() => parseOptions(["--wait-ms=0"]));
  assert.deepEqual(r.specs.qq.source, { channel: "qq", target: "private:100000001" });
  assert.deepEqual(r.specs.telegram.source, { channel: "telegram", chatId: "100000002" });
  assert(Object.values(r.specs).every((spec) => spec.text.length < 400 && spec.expected.length < 400 && !/[`|#]/.test(spec.text)));
  assert(!JSON.stringify(rows).includes("SECRET"));
});

test("configuration rejects unknown, multiple or non-owner recipients and credential-bearing WS URLs", () => {
  const pa = { telegram: { token: "FAKE", allowFrom: ["100000002"] } };
  const qq = { onebot: { wsUrl: "ws://127.0.0.1:3001", token: "FAKE" }, bot: { owner: "100000001", selfId: "100000003", whitelist: ["100000001"] } };
  for (const change of [
    (p) => { p.telegram.allowFrom = []; }, (p) => { p.telegram.allowFrom.push("7"); }, (p) => { p.telegram.allowFrom = ["7"]; },
    (_, q) => { q.bot.owner = "7"; }, (_, q) => { q.bot.whitelist = []; }, (_, q) => { q.bot.selfId = "7"; },
    (_, q) => { q.onebot.wsUrl += "?access_token=SECRET"; }, (_, q) => { q.onebot.wsUrl = "ws://example.com:3001"; },
    (p) => { p.delegations = { qqBridgeDir: "D:/other-mailbox" }; },
  ]) {
    const p = structuredClone(pa), q = structuredClone(qq); change(p, q);
    assert.throws(() => validateSettings(p, q), /SELFTEST_OPERATION_FAILED/);
  }
});

test("fake PA end-to-end probes submit exactly once per channel and require platform IDs, not ACKs", async () => {
  const r = liveRig();
  const rows = await runDeliverySelftest(r.settings, { send: true, waitMs: 1000 }, r.deps);
  assert.deepEqual(rows.map((row) => row.result), ["platform-confirmed-not-read", "platform-confirmed-not-read"]);
  assert.deepEqual(rows.map((row) => row.platformMessageId), ["-123456", "321"]);
  assert.equal(r.calls.filter((call) => call.init.method === "POST").length, 2);
  assert(r.calls.every((call) => !call.url.includes("notifications") && !call.url.includes("SECRET")));
  assert.equal(r.wsCalls.filter((call) => call.action === "send_private_msg").length, 0);
  assert.deepEqual(r.wsCalls.find((call) => call.action === "get_friend_msg_history").params, { user_id: "100000001", count: 5 });
  assert.deepEqual(r.wsCalls.find((call) => call.action === "get_msg").params, { message_id: -123456 });
  assert(r.closed());
  assert(!JSON.stringify(r.reports).includes("SECRET"));
  assert(!JSON.stringify(r.reports).includes("DO_NOT_DUMP_OTHER_CHAT"));
  assert(!JSON.stringify(r.reports).includes(probeRun));
});

test("mailbox consumption and Telegram ACK without platform receipts stay explicitly unconfirmed", async () => {
  const r = liveRig({ actions: { history: false, getMsg: false, direct: false }, readTelegramEvidence: () => [] });
  const rows = await runDeliverySelftest(r.settings, { send: true, waitMs: 2000 }, r.deps);
  assert.deepEqual(rows.map((row) => row.result), ["pa-mailbox-consumed-platform-unconfirmed", "telegram-platform-unconfirmed"]);
  assert(rows.every((row) => row.platformMessageId === null));
  assert.deepEqual(r.wsCalls.map((call) => call.action), ["get_login_info"]);
});

test("lost PA responses remain unknown and do not cause submit retries or transport fallback", async () => {
  let posts = 0;
  const r = liveRig({ fetch: async (_, init) => { if (init.method === "POST") posts++; throw new Error("DO_NOT_LOG_TEST_SECRET"); } });
  const rows = await runDeliverySelftest(r.settings, { send: true, waitMs: 1000 }, r.deps);
  assert.equal(posts, 2);
  assert(rows.every((row) => row.result === "unknown-submit" && row.platformMessageId === null));
  assert.deepEqual(r.wsCalls.map((call) => call.action), ["get_login_info"]);
});

test("wrong bot login stops all sends; explicit direct transport is separate from PA E2E", async () => {
  let sent = 0;
  const bad = liveRig({ openOneBot: async () => ({ call: async () => ({ user_id: 7 }), close() {} }), fetch: () => { sent++; throw new Error(); } });
  const refused = await runDeliverySelftest(bad.settings, { send: true }, bad.deps);
  assert(refused.every((row) => row.result === "preflight-refused-no-send"));
  assert.equal(sent, 0);
  const r = liveRig();
  const rows = await runDeliverySelftest(r.settings, { send: true, directTransport: true }, r.deps);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].result, "direct-transport-confirmed-not-pa-e2e-not-read");
  assert.equal(r.calls.length, 0);
  assert.equal(r.wsCalls.filter((call) => call.action === "send_private_msg").length, 1);
  assert.equal(r.wsCalls[1].params.user_id, "100000001");
});

test("Telegram proof requires matching notification, chunk, private recipient, actual text hash and date", () => {
  const spec = makeProbe("telegram", probeRun);
  const base = { notificationId: `reply:${requestTG}`, chunkIndex: 0, textSha256: spec.textSha256,
    receipt: { platform: "telegram", messageId: 321, chatId: "100000002", chatType: "private", date: unixTime } };
  const context = { spec, requestId: requestTG, startedAt: unixTime * 1000, now: unixTime * 1000 };
  assert.equal(matchTelegramEvidence([JSON.stringify(base)], context).length, 1);
  for (const change of [
    (v) => { v.notificationId = "reply:another"; }, (v) => { v.chunkIndex = 1; }, (v) => { v.textSha256 = sha256("not marker"); },
    (v) => { v.receipt.chatId = "7"; }, (v) => { v.receipt.chatType = "supergroup"; }, (v) => { v.receipt.date -= 100; },
    (v) => { delete v.receipt.messageId; }, (v) => { v.receipt.threadId = 42; },
  ]) {
    const value = structuredClone(base); change(value);
    assert.equal(matchTelegramEvidence([JSON.stringify(value), "{partial"], context).length, 0);
  }
});

test("QQ scoped history and get_msg reject another chat, incoming text, old dates and wrong IDs", () => {
  const expected = makeProbe("qq", probeRun).expected;
  const context = { expected, startedAt: unixTime * 1000, now: unixTime * 1000, scopedHistory: true };
  assert.equal(matchQQMessage(qqMessage(expected), context).messageId, "-123456");
  assert.equal(matchQQMessage(qqMessage(expected), { ...context, scopedHistory: false }), null);
  assert(matchQQMessage(qqMessage(expected, { target_id: 100000001, post_type: "message_sent" }), { ...context, scopedHistory: false }));
  for (const extra of [{ target_id: 7 }, { user_id: 100000001 }, { sender: { user_id: 100000001 } }, { group_id: 7 }, { message_type: "group" }, { time: unixTime - 100 }, { message_id: 0 }]) {
    assert.equal(matchQQMessage(qqMessage(expected, extra), context), null);
  }
  assert.equal(matchQQMessage(qqMessage(expected), { ...context, candidateId: 22 }), null);
  assert.equal(matchQQMessage(qqMessage("unrelated"), context), null);
});

test("evidence reports and private-state reads expose only this run's whitelisted fields", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "live-evidence-test-"));
  try {
    const writer = createReportWriter(directory, probeRun);
    writer.save([{ requestId: requestQQ, channel: "qq", recipientId: "100000001", platformMessageId: null, result: "dry-run-no-network", time: new Date().toISOString(), token: "NEVER_RETAIN", text: "OTHER_CHAT" }]);
    const output = readFileSync(writer.file, "utf8");
    assert(!output.includes("NEVER_RETAIN") && !output.includes("OTHER_CHAT"));
    assert.deepEqual(Object.keys(JSON.parse(output)[0]), ["requestId", "channel", "recipientId", "platformMessageId", "result", "time"]);
    const spec = makeProbe("qq", probeRun), settings = fakeSettings();
    settings.notificationsFile = path.join(directory, "notifications.json"); settings.mailboxFile = path.join(directory, "to-qq.jsonl");
    writeFileSync(settings.notificationsFile, JSON.stringify({ notifications: [{ id: "other", text: "OTHER_CHAT" }, { id: `reply:${requestQQ}`, source: spec.source, text: spec.expected, ackedAt: new Date().toISOString() }] }));
    assert.deepEqual(readOwnNotification(settings, spec, requestQQ), { found: true, textMatches: true, acked: true });
    writeFileSync(settings.mailboxFile, JSON.stringify({ notificationId: `reply:${requestQQ}`, type: "private", id: "100000001", text: "not returned" }) + "\n");
    assert.deepEqual(readOwnMailbox(settings, requestQQ), { readable: true, pending: true });
    writeFileSync(settings.mailboxFile, "");
    assert.deepEqual(readOwnMailbox(settings, requestQQ), { readable: true, pending: false });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("OneBot fake WS uses Bearer and echo correlation, ignores unrelated frames and never reconnects", async () => {
  const requests = [];
  let socket, connectionCount = 0;
  class FakeWebSocket extends EventEmitter {
    constructor(url, options) {
      super(); socket = this; this.readyState = 1; connectionCount++;
      assert.equal(new URL(url).search, "");
      assert.equal(options.headers.Authorization, `Bearer ${fakeSettings().wsToken}`);
      queueMicrotask(() => this.emit("open"));
    }
    send(raw, callback) { requests.push(JSON.parse(raw)); callback(); }
    terminate() { this.emit("close"); }
  }
  const events = [];
  const client = await openOneBot(fakeSettings(), (event) => events.push(event), { WebSocket: FakeWebSocket, timeoutMs: 100 });
  const first = client.call("get_login_info", {}), second = client.call("get_msg", { message_id: 2 });
  socket.emit("message", JSON.stringify({ echo: "unknown", status: "ok", retcode: 0, data: "ignored" }));
  socket.emit("message", JSON.stringify({ echo: requests[1].echo, status: "ok", retcode: 0, data: { message_id: 2 } }));
  socket.emit("message", JSON.stringify({ echo: requests[0].echo, status: "ok", retcode: 0, data: { user_id: 100000003 } }));
  assert.deepEqual(await first, { user_id: 100000003 });
  assert.deepEqual(await second, { message_id: 2 });
  assert.equal(events.length, 0);
  const missing = client.call("send_private_msg", { user_id: "100000001" });
  await assert.rejects(missing, /SELFTEST_OPERATION_FAILED/);
  assert.equal(requests.length, 3);
  client.close(); assert.equal(connectionCount, 1);
});

test("unverified installed action schemas disable reads instead of guessing history params", () => {
  assert.deepEqual(inspectInstalledActions(""), { history: false, getMsg: false, direct: false });
  assert.equal(inspectInstalledActions('GetFriendMsgHistory: "get_friend_msg_history"; actionName = re.GetFriendMsgHistory;').history, false);
});
