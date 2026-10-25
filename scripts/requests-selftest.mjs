import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { ConversationQueue } from "../src/requests.ts";
import { NotificationStore } from "../src/notifications.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-requests-"));
const queues = new Set();
let passed = 0;
const watchdog = setTimeout(() => {
  console.error("FAIL 自测超时：可能存在等待未释放或调度死锁");
  process.exit(1);
}, 30_000);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function file(name) { return path.join(root, `${name}.json`); }
function read(name) { return JSON.parse(fs.readFileSync(name, "utf8")); }
function storedRequest(name, id) { return read(name).requests.find((record) => record.id === id); }
function queue(name, options = {}) {
  const instance = new ConversationQueue({ file: file(name), execute: async () => ({ reply: "ok" }), ...options });
  queues.add(instance);
  return instance;
}
async function until(predicate, message = "等待条件超时", timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function check(name, test) {
  const previous = new Set(queues);
  try {
    await test();
    passed += 1;
    console.log(`ok ${passed} ${name}`);
  } finally {
    for (const instance of queues) if (!previous.has(instance)) instance.stop();
  }
}
function failRenamesTo(target) {
  const original = fs.renameSync;
  mock.method(fs, "renameSync", (source, destination) => {
    if (path.resolve(String(destination)) === path.resolve(target)) throw Object.assign(new Error("selftest atomic rename failure"), { code: "EIO" });
    return original(source, destination);
  });
  syncBuiltinESMExports();
  return () => { mock.restoreAll(); syncBuiltinESMExports(); };
}

try {
  await check("提交同步持久化且先于 worker 返回，所有公开边界深拷贝", async () => {
    const worker = deferred();
    let calls = 0, accepted = 0;
    const input = { text: "first", uploadPaths: ["upload.txt"], source: { channel: "telegram", chatId: "42", threadId: 7 } };
    const q = queue("accept", {
      execute: async (request) => {
        calls += 1;
        assert.equal(storedRequest(file("accept"), request.id).status, "running");
        request.text = "worker mutation";
        request.uploadPaths.push("worker.txt");
        return worker.promise;
      },
      onAccepted: (request) => {
        accepted += 1;
        assert.equal(storedRequest(file("accept"), request.id).status, "queued");
        request.source.chatId = "100";
      },
    });
    q.start();
    const record = q.submit(input);
    assert.equal(record.status, "queued");
    assert.equal(typeof record.then, "undefined");
    assert.equal(calls, 0, "submit 不应同步运行执行器");
    assert.equal(accepted, 1);
    assert.equal(storedRequest(file("accept"), record.id).status, "queued");
    input.text = "input mutation";
    input.uploadPaths.push("input.txt");
    input.source.chatId = "101";
    record.source.chatId = "102";
    record.uploadPaths.push("return.txt");
    const fetched = q.get(record.id);
    fetched.uploadPaths.push("get.txt");
    const listed = q.list();
    listed[0].text = "list mutation";
    const waitingA = q.wait(record.id), waitingB = q.wait(record.id);
    await until(() => calls === 1);
    assert.equal(q.get(record.id).text, "first");
    assert.deepEqual(q.get(record.id).uploadPaths, ["upload.txt"]);
    assert.equal(q.get(record.id).source.chatId, "42");
    const result = { reply: "done", meta: { nested: { count: 1 } } };
    worker.resolve(result);
    const [doneA, doneB] = await Promise.all([waitingA, waitingB]);
    assert.equal(doneA.status, "completed");
    result.meta.nested.count = 20;
    doneA.meta.nested.count = 30;
    assert.equal(doneB.meta.nested.count, 1);
    assert.equal(q.get(record.id).meta.nested.count, 1);
    assert.equal((await q.wait(record.id)).reply, "done");
    assert.equal(q.get("missing"), undefined);
    await assert.rejects(q.wait("missing"), /不存在/);
    assert.deepEqual(q.list(0), []);
    assert.throws(() => q.list(-1), /limit/);
    assert.equal(q.get(record.id).settledAt, undefined, "无回执处理器时不伪造 settledAt");
  });

  await check("全部来源严格串行，stop/start 不重复执行且不提前释放运行锁", async () => {
    const gates = [deferred(), deferred(), deferred()];
    const calls = [];
    let active = 0, maximum = 0;
    const q = queue("serial", {
      execute: async (request) => {
        const index = calls.length;
        calls.push(request.id);
        maximum = Math.max(maximum, ++active);
        try { return await gates[index].promise; } finally { active -= 1; }
      },
    });
    const a = q.submit({ text: "gui" });
    const b = q.submit({ text: "telegram", source: { channel: "telegram", chatId: "-123" } });
    const c = q.submit({ text: "qq", source: { channel: "qq", target: "private:12" } });
    q.start(); q.start();
    await until(() => calls.length === 1);
    q.stop(); q.start(); q.stop(); q.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [a.id]);
    q.stop();
    gates[0].resolve({ reply: "a" });
    await q.wait(a.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(q.get(b.id).status, "queued");
    assert.equal(calls.length, 1);
    q.start(); q.start();
    await until(() => calls.length === 2);
    gates[1].resolve({ reply: "b" });
    await q.wait(b.id);
    await until(() => calls.length === 3);
    gates[2].resolve({ reply: "c" });
    await q.wait(c.id);
    assert.deepEqual(calls, [a.id, b.id, c.id]);
    assert.equal(maximum, 1);
    assert.deepEqual(q.list(2).map((record) => record.id), [c.id, b.id]);
    q.stop();
    const paused = q.submit({ text: "saved while stopped" });
    q.start(); q.stop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(q.get(paused.id).status, "queued");
    assert.equal(calls.length, 3);
  });

  await check("输入/队列容量校验，幂等重试不重复回调、不重复运行、跨重启有效", async () => {
    let accepted = 0, runs = 0;
    const q = queue("idempotency", { maxQueue: 2, onAccepted: () => { accepted += 1; }, execute: async () => { runs += 1; return { reply: "ok" }; } });
    for (const input of [null, {}, { text: 1 }, { text: " " }, { text: "a".repeat(200001) }, { text: "x", uploadPaths: null }, { text: "x", uploadPaths: [""] }, { text: "x", uploadPaths: new Array(1) }, { text: "x", uploadPaths: Array(65).fill("x") }, { text: "x", source: null }, { text: "x", source: { channel: "mail" } }, { text: "x", source: { channel: "telegram", chatId: "bad" } }, { text: "x", idempotencyKey: " " }]) {
      assert.throws(() => q.submit(input));
    }
    assert.equal(q.list().length, 0);
    const payload = { text: "same", source: { channel: "gui" }, idempotencyKey: "request-key" };
    const a = q.submit(payload);
    const b = q.submit({ text: "", uploadPaths: ["attachment.pdf"] });
    assert.equal(q.submit({ ...payload, uploadPaths: [] }).id, a.id, "满队列时依然允许同请求重试");
    assert.equal(accepted, 2);
    assert.throws(() => q.submit({ text: "overflow" }), /已满/);
    for (const changes of [{ text: "different" }, { uploadPaths: ["different.txt"] }, { source: { channel: "qq", target: "group:8" } }]) {
      assert.throws(() => q.submit({ ...payload, ...changes }), /冲突/);
    }
    q.start();
    await Promise.all([q.wait(a.id), q.wait(b.id)]);
    assert.equal(runs, 2);
    q.stop();
    let replayed = 0;
    const reopened = queue("idempotency", { onAccepted: () => { throw new Error("不应再次接收"); }, execute: async () => { replayed += 1; return { reply: "wrong" }; } });
    reopened.start();
    const retried = reopened.submit(payload);
    assert.equal(retried.id, a.id);
    assert.equal(retried.status, "completed");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(replayed, 0);
    assert.throws(() => queue("bad-limit", { maxQueue: 0 }), /maxQueue/);
  });

  await check("慢 onSettled 不占执行锁；先保存终态，回执成功后才保存 settledAt", async () => {
    const gate = deferred();
    const settled = [], executed = [];
    const q = queue("settlement", {
      execute: async (record) => { executed.push(record.id); return { reply: record.text, meta: { nested: { ok: true } } }; },
      onSettled: async (record) => {
        assert.equal(storedRequest(file("settlement"), record.id).status, "completed");
        assert.equal(storedRequest(file("settlement"), record.id).settledAt, undefined);
        settled.push(record.id);
        record.meta.nested.ok = false;
        if (record.text === "slow") await gate.promise;
      },
    });
    const a = q.submit({ text: "slow" });
    const b = q.submit({ text: "fast" });
    q.start();
    await Promise.all([q.wait(a.id), q.wait(b.id)]);
    await until(() => settled.length === 2 && Boolean(q.get(b.id).settledAt));
    assert.deepEqual(executed, [a.id, b.id]);
    assert.equal(q.get(a.id).settledAt, undefined);
    assert.equal(q.get(a.id).meta.nested.ok, true);
    gate.resolve();
    await until(() => Boolean(q.get(a.id).settledAt));
    assert(q.get(b.id).settledAt);
    assert(storedRequest(file("settlement"), a.id).settledAt);
  });

  await check("重启恢复 queued，历史 running 标记中断而不重跑，未回执终态补回执", async () => {
    const interruptedWorker = deferred();
    const old = queue("crash-live", { execute: async () => interruptedWorker.promise });
    const running = old.submit({ text: "already started", idempotencyKey: "interrupted" });
    const queued = old.submit({ text: "not started" });
    old.start();
    await until(() => old.get(running.id).status === "running");
    old.stop();
    // 独立副本模拟崩溃时的磁盘快照；绝不让两个活实例同时持有同一文件。
    fs.copyFileSync(file("crash-live"), file("crash-recovered"));
    const executed = [], settled = [];
    const recovered = queue("crash-recovered", {
      execute: async (request) => { executed.push(request.id); return { reply: "recovered queued" }; },
      onAccepted: () => { assert.fail("恢复记录不应再次触发 onAccepted"); },
      onSettled: (request) => { settled.push(request.id); },
    });
    const failed = await recovered.wait(running.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /PA重启导致本轮中断；已派发后台任务将独立恢复/);
    assert(failed.startedAt && failed.finishedAt);
    assert.equal(storedRequest(file("crash-recovered"), running.id).status, "failed");
    recovered.start();
    await recovered.wait(queued.id);
    await until(() => recovered.list().every((record) => record.settledAt));
    assert.deepEqual(executed, [queued.id]);
    assert.deepEqual(new Set(settled), new Set([running.id, queued.id]));
    assert.equal(recovered.submit({ text: "already started", idempotencyKey: "interrupted" }).id, running.id);
    recovered.stop();
    const again = queue("crash-recovered", { onSettled: () => { assert.fail("已回执项不应再次回执"); } });
    again.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(again.get(running.id).status, "failed");
  });

  await check("执行异常/显式错误/非法结果均形成可读失败，不阻塞后续请求", async () => {
    const q = queue("failures", {
      execute: async (request) => {
        if (request.text === "throw") throw new Error("fake worker failure");
        if (request.text === "string") throw "string rejection";
        if (request.text === "undefined") throw undefined;
        if (request.text === "error") return { reply: "partial", meta: { stage: 2 }, error: "provider unavailable" };
        if (request.text === "invalid") return { reply: 3 };
        if (request.text === "bigint") return { reply: "ok", meta: { invalid: 1n } };
        return { reply: "healthy" };
      },
    });
    const requests = ["throw", "string", "undefined", "error", "invalid", "bigint", "healthy"].map((text) => q.submit({ text }));
    q.start();
    const results = await Promise.all(requests.map((record) => q.wait(record.id)));
    for (const record of results.slice(0, -1)) {
      assert.equal(record.status, "failed");
      assert(record.error.trim());
      assert(record.finishedAt);
    }
    assert.match(results[0].error, /fake worker failure/);
    assert.match(results[1].error, /string rejection/);
    assert.match(results[2].error, /未知错误/);
    assert.equal(results[3].reply, "partial");
    assert.deepEqual(results[3].meta, { stage: 2 });
    assert.match(results[4].error, /reply/);
    assert.equal(results.at(-1).status, "completed");
  });

  await check("取消仅影响 queued，先持久化再解除 wait，运行中的请求不被重跑或中断", async () => {
    const gate = deferred();
    const executed = [], settled = [];
    const q = queue("cancel", {
      execute: async (record) => { executed.push(record.id); return gate.promise; },
      onSettled: (record) => { settled.push(record.id); },
    });
    const a = q.submit({ text: "running" });
    const b = q.submit({ text: "cancel b" });
    const c = q.submit({ text: "cancel c" });
    const waits = [q.wait(b.id), q.wait(c.id)];
    q.start();
    await until(() => q.get(a.id).status === "running");
    assert.equal(q.cancelQueued("用户开启新会话"), 2);
    assert.equal(q.cancelQueued(), 0);
    for (const record of await Promise.all(waits)) {
      assert.equal(record.status, "cancelled");
      assert.equal(record.error, "用户开启新会话");
      assert.equal(storedRequest(file("cancel"), record.id).status, "cancelled");
    }
    assert.equal(q.get(a.id).status, "running");
    gate.resolve({ reply: "running survived" });
    await q.wait(a.id);
    await until(() => q.list().every((record) => record.settledAt));
    assert.deepEqual(executed, [a.id]);
    assert.equal(new Set(settled).size, 3);
  });

  await check("回执失败自动重试，日志/接收回调抛错不改变已接收结果", async () => {
    let attempts = 0;
    const q = queue("retry", {
      onAccepted: async () => { throw new Error("accepted hook failure"); },
      log: () => { throw new Error("logger failure"); },
      onSettled: () => { attempts += 1; if (attempts === 1) throw new Error("temporary receipt failure"); },
    });
    const record = q.submit({ text: "retry receipt" });
    q.start();
    assert.equal((await q.wait(record.id)).status, "completed");
    await until(() => attempts === 1);
    assert.equal(q.get(record.id).settledAt, undefined);
    await until(() => Boolean(q.get(record.id).settledAt));
    assert.equal(attempts, 2);
    q.start(); q.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 2);
  });

  await check("outbox 与终态回执的崩溃窗口通过 request.id 幂等恢复", async () => {
    const outbox = new NotificationStore({ file: file("receipt-outbox") });
    const suspended = deferred();
    let notified = false;
    const old = queue("receipt-live", { onSettled: async (request) => {
      outbox.put({ id: request.id, source: request.source, text: request.reply, kind: "reply" });
      notified = true;
      await suspended.promise;
    } });
    const record = old.submit({ text: "notify once", source: { channel: "telegram", chatId: "42" } });
    old.start();
    await old.wait(record.id);
    await until(() => notified);
    old.stop();
    assert.equal(old.get(record.id).settledAt, undefined);
    fs.copyFileSync(file("receipt-live"), file("receipt-restart"));
    fs.copyFileSync(file("receipt-outbox"), file("receipt-outbox-restart"));
    const reopenedOutbox = new NotificationStore({ file: file("receipt-outbox-restart") });
    let executions = 0, receipts = 0;
    const restarted = queue("receipt-restart", {
      execute: async () => { executions += 1; return { reply: "wrong" }; },
      onSettled: (request) => {
        receipts += 1;
        reopenedOutbox.put({ id: request.id, source: request.source, text: request.reply, kind: "reply" });
      },
    });
    restarted.start();
    await until(() => Boolean(restarted.get(record.id).settledAt));
    assert.equal(executions, 0);
    assert.equal(receipts, 1);
    assert.equal(reopenedOutbox.pending("telegram").length, 1);
    assert.equal(reopenedOutbox.pending()[0].id, record.id);
  });

  await check("通知持久化、按来源 FIFO 查询、深拷贝、重启保留和确认幂等", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const options = { file: file("notifications"), now: () => now };
    const store = new NotificationStore(options);
    const input = { id: "notification-a", source: { channel: "telegram", chatId: "42" }, text: "a", kind: "reply" };
    const a = store.put(input);
    assert.equal(read(options.file).notifications.length, 1);
    input.source.chatId = "50";
    a.source.chatId = "51";
    store.get(a.id).source.chatId = "52";
    store.pending()[0].source.chatId = "53";
    assert.equal(store.get(a.id).source.chatId, "42");
    assert.equal(store.put({ ...input, source: { channel: "telegram", chatId: "42" } }).id, a.id);
    assert.throws(() => store.put({ ...input, text: "different" }), /冲突/);
    const b = store.put({ id: "notification-b", source: { channel: "qq", target: "group:9" }, text: "b", kind: "job" });
    const c = store.put({ id: "notification-c", source: { channel: "telegram", chatId: "42", threadId: 7 }, text: "c", kind: "attention" });
    assert.deepEqual(store.pending("telegram", 1).map((record) => record.id), [a.id]);
    assert.deepEqual(store.pending().map((record) => record.id), [a.id, b.id, c.id]);
    assert.deepEqual(store.pending(undefined, 0), []);
    assert.throws(() => store.pending("invalid"), /channel/);
    assert.throws(() => store.pending(undefined, -1), /limit/);
    assert.throws(() => store.put({ ...input, id: "", source: { channel: "gui" } }), /id/);
    assert.throws(() => store.put({ ...input, kind: "invalid" }), /kind/);
    assert.equal(store.ack("missing"), false);
    now += 1000;
    assert.equal(store.ack(a.id), true);
    const confirmed = store.get(a.id), saved = fs.readFileSync(options.file, "utf8");
    now += 1000;
    assert.equal(store.ack(a.id), true);
    assert.equal(store.get(a.id).ackedAt, confirmed.ackedAt);
    assert.equal(fs.readFileSync(options.file, "utf8"), saved);
    const reopened = new NotificationStore(options);
    assert.deepEqual(reopened.pending().map((record) => record.id), [b.id, c.id]);
    assert.equal(reopened.ack(a.id), true);
    assert.equal(reopened.put({ id: a.id, source: { channel: "telegram", chatId: "42" }, text: "a", kind: "reply" }).ackedAt, confirmed.ackedAt);
    assert.equal(reopened.pending("telegram").length, 1);
    for (let index = 0; index < 25; index += 1) reopened.put({ id: `extra-${index}`, source: { channel: "gui" }, text: String(index), kind: "job" });
    assert.equal(reopened.pending().length, 20);
    assert.equal(new NotificationStore(options).pending(undefined, 100).length, 27);
  });

  await check("历史压缩保留近期终态、未回执项和永久幂等键", async () => {
    const ancient = "2020-01-01T00:00:00.000Z";
    const current = "2026-10-13T00:00:00.000Z";
    const base = { text: "historical", uploadPaths: [], source: { channel: "gui" }, status: "completed", createdAt: ancient, startedAt: ancient, finishedAt: ancient, reply: "saved", settledAt: ancient };
    const pending = { ...base, id: "unsettled" };
    delete pending.settledAt;
    const historical = [pending, { ...base, id: "keyed", idempotencyKey: "forever" }, { ...base, id: "recent", finishedAt: current, settledAt: current }, ...Array.from({ length: 1005 }, (_, index) => ({ ...base, id: `old-${index}` }))];
    fs.writeFileSync(file("retention"), JSON.stringify({ version: 1, requests: historical }));
    const q = queue("retention", { now: () => Date.parse(current) });
    q.submit({ text: "trigger safe compaction" });
    assert(q.get("unsettled"));
    assert(q.get("keyed"));
    assert(q.get("recent"));
    assert.equal(q.get("old-0"), undefined);
    assert(q.get("old-1004"));
    assert.equal(q.submit({ text: "historical", idempotencyKey: "forever" }).id, "keyed");
    const disk = read(file("retention"));
    assert.equal(disk.requests.length, 1004);
    assert.equal(disk.requests.find((record) => record.id === "unsettled").settledAt, undefined);
  });

  await check("空文件/坏 JSON/非法状态/重复 id 或幂等键均 fail closed，绝不覆写", async () => {
    const request = { id: "r", text: "x", uploadPaths: [], source: { channel: "gui" }, status: "queued", createdAt: "2026-01-01T00:00:00.000Z" };
    const notification = { id: "n", text: "x", source: { channel: "gui" }, kind: "reply", createdAt: request.createdAt };
    const requestCases = ["", "{broken", "null", "[]", JSON.stringify({ version: 2, requests: [] }), JSON.stringify({ version: 1, requests: [request, request] }), JSON.stringify({ version: 1, requests: [{ ...request, status: "running" }] }), JSON.stringify({ version: 1, requests: [{ ...request, status: "completed" }] }), JSON.stringify({ version: 1, requests: [{ ...request, source: { channel: "telegram", chatId: "invalid" } }] }), JSON.stringify({ version: 1, requests: [{ ...request, idempotencyKey: "same" }, { ...request, id: "r2", idempotencyKey: "same" }] })];
    const notificationCases = ["", "{broken", "null", "[]", JSON.stringify({ version: 2, notifications: [] }), JSON.stringify({ version: 1, notifications: [notification, notification] }), JSON.stringify({ version: 1, notifications: [{ ...notification, kind: "invalid" }] }), JSON.stringify({ version: 1, notifications: [{ ...notification, ackedAt: "broken" }] }), JSON.stringify({ version: 1, notifications: [{ ...notification, source: null }] })];
    for (const [kind, cases] of [["request", requestCases], ["notification", notificationCases]]) {
      for (const [index, content] of cases.entries()) {
        const target = file(`corrupt-${kind}-${index}`);
        fs.writeFileSync(target, content);
        assert.throws(() => kind === "request" ? queue("unused", { file: target }) : new NotificationStore({ file: target }), /拒绝覆盖/);
        assert.equal(fs.readFileSync(target, "utf8"), content);
      }
    }
  });

  await check("原子写失败不发布未落盘记录/确认；执行结果落盘失败后停止调度", async () => {
    const q = queue("write-submit");
    const first = q.submit({ text: "already durable" });
    const original = fs.readFileSync(file("write-submit"), "utf8");
    let restore = failRenamesTo(file("write-submit"));
    try {
      assert.throws(() => q.submit({ text: "not durable" }), /停止调度/);
      assert.deepEqual(q.list().map((record) => record.id), [first.id]);
      assert.equal(fs.readFileSync(file("write-submit"), "utf8"), original);
      assert.throws(() => q.start(), /停止调度/);
    } finally { restore(); }

    const outbox = new NotificationStore({ file: file("write-ack") });
    outbox.put({ id: "ack", source: { channel: "gui" }, text: "keep pending", kind: "reply" });
    const beforeAck = fs.readFileSync(file("write-ack"), "utf8");
    restore = failRenamesTo(file("write-ack"));
    try {
      assert.throws(() => outbox.ack("ack"), /rename failure/);
      assert.equal(outbox.pending().length, 1);
      assert.equal(outbox.get("ack").ackedAt, undefined);
      assert.equal(fs.readFileSync(file("write-ack"), "utf8"), beforeAck);
      assert.throws(() => outbox.put({ id: "lost", source: { channel: "gui" }, text: "not saved", kind: "reply" }), /rename failure/);
      assert.equal(outbox.get("lost"), undefined);
    } finally { restore(); }
    assert.equal(outbox.ack("ack"), true);

    const gate = deferred();
    let executions = 0, receipts = 0;
    const terminal = queue("write-terminal", {
      execute: async () => { executions += 1; return gate.promise; },
      onSettled: () => { receipts += 1; },
    });
    const a = terminal.submit({ text: "already running" });
    const b = terminal.submit({ text: "must remain queued" });
    terminal.start();
    await until(() => terminal.get(a.id).status === "running");
    const beforeTerminal = fs.readFileSync(file("write-terminal"), "utf8");
    const rejectedWait = assert.rejects(terminal.wait(a.id), /停止调度/);
    restore = failRenamesTo(file("write-terminal"));
    try {
      gate.resolve({ reply: "cannot persist this completion" });
      await rejectedWait;
      assert.equal(fs.readFileSync(file("write-terminal"), "utf8"), beforeTerminal);
      assert.equal(terminal.get(a.id).status, "running");
      assert.equal(terminal.get(b.id).status, "queued");
      assert.equal(executions, 1);
      assert.equal(receipts, 0);
      assert.throws(() => terminal.start(), /停止调度/);
    } finally { restore(); }
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith(".tmp")), false);
  });

  console.log(`PASS ${passed} 组持久请求队列 / 通知存储自测（仅 fake workers 与临时文件，无 HTTP/模型/真实消息）`);
} finally {
  clearTimeout(watchdog);
  for (const instance of queues) instance.stop();
  mock.restoreAll();
  syncBuiltinESMExports();
  fs.rmSync(root, { recursive: true, force: true });
}
