import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createPortProbe } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GuiServer } from "../src/server.ts";
import { ConversationQueue } from "../src/requests.ts";
import { NotificationStore } from "../src/notifications.ts";
import { DelegationManager } from "../src/delegations.ts";

// Only this script is added to the repository. Every store/config/fixture is owned
// by this fresh temporary root; never import main.ts into the test process.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "pi-agent background selftest-"));
console.log(`background-selftest 临时目录：${temporaryRoot}`);
const failures = [];
const ownedChildren = new Set();
const ownedServers = new Set();
const cleanupCallbacks = new Set();
const FAST_MS = 2000;
const HTTP_TIMEOUT_MS = 3000;
let passed = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonFile = (file) => JSON.parse(readFileSync(file, "utf8"));
const jsonLines = (file) => readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function detail(error) { return error instanceof Error ? error.stack ?? error.message : String(error); }
function recordFailure(name, error) {
  failures.push({ name, error: detail(error) });
  console.error(`FAIL ${name}\n${detail(error)}`);
}
async function check(name, operation) {
  try {
    await operation();
    passed += 1;
    console.log(`ok ${passed} ${name}`);
    return true;
  } catch (error) {
    recordFailure(name, error);
    return false;
  }
}
async function until(read, predicate, label, timeoutMs = 8000) {
  const deadline = performance.now() + timeoutMs;
  let latest;
  do {
    latest = await read();
    if (predicate(latest)) return latest;
    await sleep(15);
  } while (performance.now() < deadline);
  throw new Error(`${label} 超时；最后结果=${JSON.stringify(latest).slice(0, 3000)}`);
}
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// A real TCP HTTP client, fixed to IPv4 loopback. No browser, proxy, redirects,
// outbound URLs, global HTTP mocks, or real messaging bridges are involved.
function client(port, defaultToken, { forbidDelegationWrites = false } = {}) {
  assert(Number.isSafeInteger(port) && port > 0 && port <= 65535);
  return (route, options = {}) => {
    assert(route.startsWith("/api/"), `Only known API paths are allowed: ${route}`);
    const method = options.method ?? "GET";
    if (forbidDelegationWrites && method !== "GET" && route.startsWith("/api/delegations")) {
      throw new Error("安全限制：main fixture 绝不提交或操纵真实后台任务");
    }
    const body = options.raw !== undefined ? options.raw : options.body === undefined ? undefined : JSON.stringify(options.body);
    const token = options.token === undefined ? defaultToken : options.token;
    const headers = { connection: "close", ...(token === null ? {} : { "x-token": token }) };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port, path: route, method, headers, agent: false }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.once("error", reject);
        response.once("end", () => {
          let parsed;
          try { parsed = JSON.parse(text); } catch { /* 401/plain text errors are evidence too. */ }
          resolve({ status: response.statusCode, body: parsed, text, elapsedMs: performance.now() - started });
        });
      });
      request.once("error", reject);
      request.setTimeout(options.timeoutMs ?? HTTP_TIMEOUT_MS, () => request.destroy(new Error(`${method} ${route} 超过 ${options.timeoutMs ?? HTTP_TIMEOUT_MS}ms，未收到响应`)));
      request.end(body);
    });
  };
}
function expectStatus(response, status, label) {
  assert.equal(response.status, status, `${label}: HTTP ${response.status}, body=${response.text}`);
  if (status >= 200 && status < 300) assert.equal(response.body?.ok, true, `${label}: 缺少 ok=true，body=${response.text}`);
  return response.body;
}
async function terminalRequest(api, id, timeoutMs = 8000) {
  return until(async () => {
    const response = await api(`/api/requests/${encodeURIComponent(id)}`);
    return expectStatus(response, 200, "GET request").request;
  }, (record) => ["completed", "failed", "cancelled"].includes(record?.status), `请求 ${id} 终态`, timeoutMs);
}

/** Implements the actual HerdrAdapterLike boundary without creating a process. */
class FakeHerdrAdapter {
  constructor(now) {
    this.now = now;
    this.workspaces = new Map();
    this.agents = new Map();
    this.outputs = new Map();
    this.readAt = new Map();
    this.calls = [];
  }
  async ensureServer() { this.calls.push({ method: "ensureServer" }); }
  async createWorkspace(input) {
    const index = this.workspaces.size + 1;
    const workspace = { workspaceId: `fake-workspace-${index}`, paneId: `fake-pane-${index}`, cwd: input.cwd, closed: false };
    assert(inside(temporaryRoot, workspace.cwd), "fake CA cwd 必须属于测试临时目录");
    this.workspaces.set(workspace.workspaceId, workspace);
    this.calls.push({ method: "createWorkspace", ...input, ...workspace });
    return { workspaceId: workspace.workspaceId, paneId: workspace.paneId };
  }
  async startAgent(input) {
    const workspace = [...this.workspaces.values()].find((item) => item.paneId === input.paneId && !item.closed);
    assert(workspace, "startAgent 必须指向自己的 fake workspace");
    this.agents.set(input.name, {
      name: input.name, agent: input.worker, agent_status: "working", pane_id: input.paneId,
      workspace_id: workspace.workspaceId, terminal_id: `terminal-${input.paneId}`,
      agent_session: { kind: "fake", value: `session-${input.paneId}` },
      launch_pending: false, interactive_ready: true,
    });
    this.outputs.set(input.paneId, `fake CA ${input.name} started`);
    this.calls.push({ method: "startAgent", ...input });
  }
  async prompt(name, text) {
    const agent = this.agents.get(name);
    assert(agent, "prompt 必须指向已创建的 fake agent");
    this.calls.push({ method: "prompt", name, text });
    this.outputs.set(agent.pane_id, `fake CA ${name}: progress at ${this.now()}`);
  }
  async listAgents() { return structuredClone([...this.agents.values()]); }
  async readPane(paneId, lines) {
    assert(this.outputs.has(paneId), "不能读取其他 pane");
    this.readAt.set(paneId, this.now());
    return this.outputs.get(paneId).split("\n").slice(-lines).join("\n");
  }
  async sendText(paneId, text) { this.calls.push({ method: "sendText", paneId, text }); }
  async sendKeys(paneId, keys) { this.calls.push({ method: "sendKeys", paneId, keys: [...keys] }); }
  async closeWorkspace(workspaceId) {
    const workspace = this.workspaces.get(workspaceId);
    assert(workspace, `拒绝关闭未知工作区 ${workspaceId}`);
    if (workspace.closed) return;
    this.calls.push({ method: "closeWorkspace", workspaceId });
    workspace.closed = true;
    for (const [name, agent] of this.agents) if (agent.workspace_id === workspaceId) this.agents.delete(name);
  }
  progress(paneId, text) { this.outputs.set(paneId, text); }
  closedIds() { return this.calls.filter((call) => call.method === "closeWorkspace").map((call) => call.workspaceId); }
}

async function componentHttpTests() {
  const root = path.join(temporaryRoot, "http-components");
  const projectA = path.join(root, "project-a"), projectB = path.join(root, "project-b");
  for (const directory of [projectA, projectB, path.join(root, "public")]) mkdirSync(directory, { recursive: true });
  let clock = Date.parse("2026-10-13T00:00:00.000Z");
  const now = () => clock;
  const source = { channel: "telegram", chatId: "-1001234567890", threadId: 73 };
  const token = `selftest-${randomUUID()}`;
  const logs = [];
  const adapter = new FakeHerdrAdapter(now);
  const outboxFile = path.join(root, "notifications.json");
  const notifications = new NotificationStore({ file: outboxFile, now });
  const paGate = deferred();
  const executions = [], accepted = [], events = [];
  let active = 0, maximumActive = 0;
  let primaryRequest, primaryJob;
  const manager = new DelegationManager({
    file: path.join(root, "delegations.json"), resultsDir: path.join(root, "results"), adapter,
    now, maxConcurrent: 2, timeoutMs: 3_600_000, idleWarningMs: 900_000, pollIntervalMs: 20,
    log: (...args) => logs.push(args.map(String).join(" ")),
    onEvent: async (job, event) => {
      events.push({ id: job.id, event, source: structuredClone(job.source) });
      const stamp = event === "attention" ? String(job.attentionAt ?? job.lastProgressAt ?? job.createdAt) : "terminal";
      const id = `job:${job.id}:${event}:${stamp}`;
      notifications.put({ id, source: job.source, text: job.report?.summary ?? job.message ?? job.status, kind: event === "attention" ? "attention" : "job" });
      if (job.source.channel === "gui") notifications.ack(id);
    },
  });
  const queue = new ConversationQueue({
    file: path.join(root, "requests.json"), now,
    log: (...args) => logs.push(args.map(String).join(" ")),
    onAccepted: (request) => { accepted.push(request.id); },
    execute: async (request) => {
      executions.push(request.id);
      maximumActive = Math.max(maximumActive, ++active);
      try {
        if (request.text === "selftest:delegate-only") {
          primaryJob = manager.submit({ task: "Fake CA only: keep running until this test writes its report", cwd: projectA, name: "background-selftest-a" }, { requestId: request.id, source: request.source });
          await paGate.promise;
          return { reply: `已交给后台 ${primaryJob.id}；可以继续聊天`, meta: { jobId: primaryJob.id } };
        }
        return { reply: `fake ordinary reply: ${request.text}` };
      } finally { active -= 1; }
    },
    onSettled: async (request) => {
      const id = `reply:${request.id}`;
      notifications.put({ id, source: request.source, text: request.reply || request.error || "empty", kind: "reply" });
      if (request.source.channel === "gui") notifications.ack(id);
    },
  });
  const stop = () => { paGate.resolve(); queue.stop(); manager.stop(); };
  cleanupCallbacks.add(stop);
  const server = new GuiServer({
    workspace: root, publicDir: path.join(root, "public"), uploadDir: path.join(root, "uploads"),
    host: "127.0.0.1", port: 0, token, log: (...args) => logs.push(args.map(String).join(" ")),
    onMessage: () => { assert.fail("有 submitRequest 时不应走旧 onMessage 分支"); },
    onExternal: async ({ text }) => (await queue.wait(queue.submit({ text }).id)).reply ?? "",
    onAbort: () => { queue.cancelQueued(); }, onReset: () => { queue.cancelQueued(); },
    status: () => ({ backgroundDelegations: true, backgroundJobs: manager.list().filter((job) => job.status === "running").length }),
    history: () => [], submitRequest: (input) => queue.submit(input), requestStatus: (id) => queue.get(id),
    notifications: { pending: (channel, limit) => notifications.pending(channel, limit), ack: (id) => notifications.ack(id) },
    delegations: {
      submit: (input) => {
        const requestId = input.requestId === undefined ? undefined : String(input.requestId);
        const parent = requestId ? queue.get(requestId) : undefined;
        if (requestId && !parent) throw new Error("找不到来源请求");
        return manager.submit({ task: String(input.task ?? ""), cwd: String(input.cwd ?? ""), ...(input.name === undefined ? {} : { name: String(input.name) }) }, { requestId, source: parent?.source ?? { channel: "gui" } });
      },
      list: () => manager.list(), get: (id) => manager.get(id), read: (id, lines) => manager.read(id, lines),
      reply: (id, text) => manager.reply(id, text), keys: (id, keys, text) => manager.keys(id, keys, text),
      cancel: (id) => manager.cancel(id), close: (id) => manager.close(id),
    },
  });
  ownedServers.add(server);
  try {
    await server.listen();
    manager.start(); queue.start();
    const api = client(server.port, token);
    const dispatched = await check("真实 HTTP 202 先返回；PA 结束后 CA 超过 601 秒仍 running，第二条聊天不受阻", async () => {
      const response = await api("/api/requests", { method: "POST", body: { text: "selftest:delegate-only", source, idempotencyKey: "primary-http-request" } });
      const body = expectStatus(response, 202, "POST /api/requests");
      assert(response.elapsedMs < FAST_MS, `202 等待了 ${response.elapsedMs.toFixed(1)}ms`);
      primaryRequest = body.request;
      assert(primaryRequest?.id);
      assert(!["completed", "failed"].includes(queue.get(primaryRequest.id).status), "202 不能等待 PA worker 结束");
      await until(() => primaryJob && manager.get(primaryJob.id), (job) => job?.status === "running", "CA 启动");
      paGate.resolve();
      const result = await terminalRequest(api, primaryRequest.id);
      assert.equal(result.status, "completed", JSON.stringify(result));
      assert.equal(result.meta.jobId, primaryJob.id);
      assert.equal(manager.get(primaryJob.id).status, "running");
      assert.deepEqual(manager.get(primaryJob.id).source, source);
      assert.equal(manager.get(primaryJob.id).requestId, primaryRequest.id);

      clock += 601_001; // Simulated CA lifetime, NOT a 601-second wall-clock sleep.
      const running = manager.get(primaryJob.id);
      adapter.progress(running.paneId, `fake progress after 601.001 seconds\nlong-running-output-${primaryJob.id}`);
      await until(() => manager.get(primaryJob.id), (job) => adapter.readAt.get(job.paneId) === clock && Date.parse(job.lastProgressAt) === clock, "超过 601 秒后的实际 supervisor poll");
      assert(clock - Date.parse(running.startedAt) > 601_000);
      assert(Date.parse(running.deadlineAt) > clock);
      assert.equal(manager.get(primaryJob.id).status, "running");
      assert.deepEqual(adapter.closedIds(), []);

      const started = performance.now();
      const second = expectStatus(await api("/api/requests", { method: "POST", body: { text: "普通聊天，不等待后台任务" } }), 202, "第二条聊天").request;
      const secondResult = await terminalRequest(api, second.id, FAST_MS);
      const elapsed = performance.now() - started;
      assert.equal(secondResult.status, "completed", JSON.stringify(secondResult));
      assert.match(secondResult.reply, /普通聊天/);
      assert(elapsed < FAST_MS, `第二条聊天耗时 ${elapsed.toFixed(1)}ms`);
      assert.equal(manager.get(primaryJob.id).status, "running");
      assert.equal(maximumActive, 1);
      assert.equal(adapter.calls.filter((call) => call.method === "prompt").length, 1, "没有重派 CA");
      console.log(`   CA模拟时长=601.001s；接收=${response.elapsedMs.toFixed(1)}ms；第二轮完成=${elapsed.toFixed(1)}ms`);
    });
    paGate.resolve(); // Never leave subsequent cases blocked by a failed assertion.

    if (dispatched) {
      await check("delegations list/status/output/cancel 契约正确；取消仅关闭目标 CA", async () => {
        const listed = expectStatus(await api("/api/delegations"), 200, "GET jobs").jobs;
        assert.equal(listed.length, 1);
        const status = expectStatus(await api(`/api/delegations/${primaryJob.id}`), 200, "GET job status").job;
        assert.equal(status.status, "running");
        const output = expectStatus(await api(`/api/delegations/${primaryJob.id}/output?lines=10`), 200, "GET job output");
        assert.match(output.output, new RegExp(`long-running-output-${primaryJob.id}`));
        assert.equal(output.job.id, primaryJob.id);
        const target = expectStatus(await api("/api/delegations", { method: "POST", body: { task: "Only this fake job may be cancelled", cwd: projectB, name: "background-selftest-b" } }), 202, "POST fake delegation").job;
        const targetRunning = await until(() => manager.get(target.id), (job) => job.status === "running", "第二个 fake CA 启动");
        const before = adapter.closedIds();
        const cancelled = expectStatus(await api(`/api/delegations/${target.id}/cancel`, { method: "POST" }), 200, "POST cancel").job;
        assert.equal(cancelled.status, "cancelled");
        assert(cancelled.closedAt, "cancel 必须完成目标 workspace 的关闭");
        assert.deepEqual(adapter.closedIds().slice(before.length), [targetRunning.workspaceId]);
        assert.equal(manager.get(primaryJob.id).status, "running", "不能取消其他 CA");
        assert.equal(adapter.workspaces.get(status.workspaceId).closed, false);
        assert.equal(expectStatus(await api(`/api/delegations/${target.id}`), 200, "GET cancelled job").job.status, "cancelled");
        expectStatus(await api(`/api/delegations/${target.id}/cancel`, { method: "POST" }), 200, "重复 cancel");
        assert.equal(adapter.closedIds().filter((id) => id === targetRunning.workspaceId).length, 1);
        for (const route of ["/api/delegations/not-found", "/api/delegations/not-found/output", "/api/delegations/not-found/cancel"]) {
          assert.equal((await api(route, { method: route.endsWith("cancel") ? "POST" : "GET" })).status, 404);
        }
      });

      await check("CA 报告完成后保留原 Telegram chatId/threadId，通知重启保留且 HTTP ACK 幂等", async () => {
        const job = manager.get(primaryJob.id);
        assert.equal(job.status, "running");
        assert(inside(root, job.reportPath));
        writeFileSync(job.reportPath, JSON.stringify({ jobId: job.id, status: "completed", summary: "fake structured report completed", tests: ["fixture only"], changedFiles: [] }));
        const completed = await until(() => manager.get(job.id), (record) => record.status === "completed" && record.notifiedAt, "完成报告与终态回执");
        assert.equal(completed.report.summary, "fake structured report completed");
        assert.equal(events.filter((event) => event.id === job.id && event.event === "terminal").length, 1);
        assert.deepEqual(completed.source, source);
        assert.equal(expectStatus(await api(`/api/delegations/${job.id}`), 200, "GET completed job").job.status, "completed");
        const notificationId = `job:${job.id}:terminal:terminal`;
        const pending = expectStatus(await api("/api/notifications?channel=telegram"), 200, "GET Telegram notifications").notifications;
        const notification = pending.find((record) => record.id === notificationId);
        assert(notification, JSON.stringify(pending));
        assert.equal(notification.kind, "job");
        assert.equal(notification.text, "fake structured report completed");
        assert.deepEqual(notification.source, source);
        assert(pending.some((record) => record.id === `reply:${primaryRequest.id}`), "PA 最终回复也进入同一 outbox");
        assert(!expectStatus(await api("/api/notifications?channel=gui"), 200, "GET GUI notifications").notifications.some((record) => record.id === notificationId));
        const snapshotFile = path.join(root, "outbox-restart-snapshot.json");
        copyFileSync(outboxFile, snapshotFile);
        assert.deepEqual(new NotificationStore({ file: snapshotFile, now }).get(notificationId).source, source);
        const ackRoute = `/api/notifications/${encodeURIComponent(notificationId)}/ack`;
        expectStatus(await api(ackRoute, { method: "POST" }), 200, "ACK first");
        const ackedAt = notifications.get(notificationId).ackedAt;
        clock += 1000;
        expectStatus(await api(ackRoute, { method: "POST" }), 200, "ACK retry");
        assert.equal(notifications.get(notificationId).ackedAt, ackedAt);
        assert(!expectStatus(await api("/api/notifications?channel=telegram"), 200, "GET after ACK").notifications.some((record) => record.id === notificationId));
        assert(jsonFile(outboxFile).notifications.find((record) => record.id === notificationId).ackedAt);
        assert.equal((await api("/api/notifications/not-found/ack", { method: "POST" })).status, 404);
      });
    }

    await check("未认证/错误 token 一律 401，不接收请求、不取消任务", async () => {
      const beforeRequests = accepted.length, beforeJobs = manager.list(), beforeClosed = adapter.closedIds();
      const routes = [
        ["/api/status", "GET"], ["/api/requests", "POST"], ["/api/delegations", "GET"],
        ["/api/notifications?channel=telegram", "GET"], ["/api/notifications/any/ack", "POST"],
        [`/api/delegations/${primaryJob?.id ?? "none"}/cancel`, "POST"],
      ];
      for (const [route, method] of routes) {
        for (const badToken of [null, "wrong-selftest-token"]) {
          const response = await api(route, { method, token: badToken, ...(method === "POST" ? { body: { text: "must not be accepted" } } : {}) });
          assert.equal(response.status, 401, `${method} ${route}: ${response.text}`);
        }
      }
      assert.equal(accepted.length, beforeRequests);
      assert.deepEqual(manager.list().map((job) => [job.id, job.status]), beforeJobs.map((job) => [job.id, job.status]));
      assert.deepEqual(adapter.closedIds(), beforeClosed);
    });

    // Invalid JSON, wrong root shape and wrong field types are separate cases.
    // A 202 with silently coerced text/default-gui is a genuine contract failure;
    // do not weaken these expectations to make an implementation pass.
    const invalidBodies = [
      ["malformed JSON", { raw: "{broken" }], ["empty JSON body", { raw: "" }],
      ["null body", { body: null }], ["array body", { body: [] }], ["string body", { body: "bad" }],
      ["empty text", { body: { text: " " } }], ["numeric text", { body: { text: 42 } }],
      ["object text", { body: { text: { invalid: true } } }],
      ["non-string upload", { body: { text: "invalid upload member", uploads: [42] } }],
      ["non-array uploads", { body: { text: "invalid upload array", uploads: "a.txt" } }],
      ["non-string idempotencyKey", { body: { text: "invalid key", idempotencyKey: { key: 1 } } }],
    ];
    const invalidSources = [
      ["null", null], ["number", 42], ["string", "telegram"], ["array", []], ["missing channel", {}],
      ["unknown channel", { channel: "email" }], ["invalid chatId", { channel: "telegram", chatId: "not-a-chat" }],
      ["invalid threadId", { channel: "telegram", chatId: "42", threadId: -1 }],
      ["invalid QQ target", { channel: "qq", target: "not-a-target" }],
    ];
    invalidBodies.push(...invalidSources.map(([label, invalidSource]) => [`source ${label}`, { body: { text: `invalid source ${label}`, source: invalidSource } }]));
    for (const [label, payload] of invalidBodies) {
      await check(`非法请求不入队：${label}`, async () => {
        const before = accepted.length;
        const response = await api("/api/requests", { method: "POST", ...payload });
        assert(response.status === 400 && accepted.length === before,
          `POST /api/requests ${label}: expected HTTP 400 / accepted delta 0; actual HTTP ${response.status} / accepted delta ${accepted.length - before}; payload=${payload.raw ?? JSON.stringify(payload.body)}; response=${response.text}`);
      });
    }

    await check("旧 POST /api/send 保持 202 + requestId/status，并经同一队列完成", async () => {
      const response = await api("/api/send", { method: "POST", body: { text: "legacy ordinary chat", uploads: [] } });
      const body = expectStatus(response, 202, "POST /api/send");
      assert(body.requestId && typeof body.requestId === "string");
      assert(["queued", "running"].includes(body.status), JSON.stringify(body));
      assert(response.elapsedMs < FAST_MS);
      const result = await terminalRequest(api, body.requestId);
      assert.equal(result.status, "completed", JSON.stringify(result));
      assert.match(result.reply, /legacy ordinary chat/);
      assert.equal(executions.filter((id) => id === body.requestId).length, 1);
    });
    if (logs.length) console.log(`   组件日志 ${logs.length} 条（全部为临时实例）`);
  } finally {
    stop();
    cleanupCallbacks.delete(stop);
    // Drain any already-completing PA callback before deleting its stores.
    await until(() => active, (count) => count === 0, "fake PA 清理", 3000);
    await server.close();
    ownedServers.delete(server);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function freePort() {
  const probe = createPortProbe();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}
function isolatedEnvironment(root) {
  const env = {};
  // Whitelist OS necessities, never inherit API keys, proxy settings, NODE_OPTIONS,
  // real HOME/APPDATA, PI_* identity, or model-provider configuration.
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(systemroot|windir|systemdrive|comspec|os|processor_architecture|number_of_processors)$/i.test(key)) env[key] = value;
  }
  const home = path.join(root, "home"), temp = path.join(root, "tmp");
  const appData = path.join(home, "AppData", "Roaming"), localAppData = path.join(home, "AppData", "Local");
  for (const directory of [home, temp, appData, localAppData]) mkdirSync(directory, { recursive: true });
  return { ...env, PATH: path.dirname(process.execPath), HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData, TMP: temp, TEMP: temp, TMPDIR: temp, NODE_OPTIONS: "", NO_COLOR: "1" };
}
function startFixture(entry, guard, root) {
  assert(inside(temporaryRoot, entry));
  const child = spawn(process.execPath, ["--import", pathToFileURL(guard).href, entry], {
    cwd: root, env: isolatedEnvironment(root), windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
  });
  const fixture = { child, output: "", exited: false, result: undefined, done: undefined };
  const collect = (chunk) => { fixture.output = (fixture.output + chunk.toString()).slice(-24000); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  fixture.done = new Promise((resolve) => {
    child.once("error", (error) => { fixture.result = { error: error.message }; fixture.output += `\nspawn: ${error.message}`; });
    child.once("close", (code, signal) => { fixture.exited = true; fixture.result ??= { code, signal }; resolve(fixture.result); });
  });
  ownedChildren.add(fixture);
  console.log(`   已创建自己的 main fixture PID=${child.pid}，入口=${entry}`);
  return fixture;
}
async function stopFixture(fixture) {
  if (!fixture.exited && fixture.child.pid) fixture.child.kill(); // ONLY this ChildProcess handle; never taskkill/global app stop.
  await until(() => fixture.exited, Boolean, `fixture PID ${fixture.child.pid} 退出`, 5000);
  await fixture.done;
  ownedChildren.delete(fixture);
}

async function mainFixtureTests() {
  const root = path.join(temporaryRoot, "actual-main-fixture");
  for (const directory of ["src", "app", "workspace", "public"]) mkdirSync(path.join(root, directory), { recursive: true });
  for (const entry of readdirSync(path.join(projectRoot, "src"), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) copyFileSync(path.join(projectRoot, "src", entry.name), path.join(root, "src", entry.name));
  }
  copyFileSync(path.join(projectRoot, "app", "runtime.mjs"), path.join(root, "app", "runtime.mjs"));
  const fakePi = path.join(root, "fake-pi.mjs");
  const callsFile = path.join(root, "fake-pi-calls.jsonl");
  writeFileSync(fakePi, `import { appendFileSync } from "node:fs";
const id = process.env.PI_REQUEST_ID;
if (!id) throw new Error("fakePi requires PI_REQUEST_ID; this fixture only permits ordinary PA requests");
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ requestId: id, cwd: process.cwd(), args: process.argv.slice(2), pid: process.pid }) + "\\n");
const text = "fakePi echoed PI_REQUEST_ID=" + id;
process.stdout.write(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text }] }] }) + "\\n");
`);
  // Keep production files byte-for-byte unchanged. A test-only import guard
  // refuses every subprocess except our exact fakePi, including an accidental
  // default-herdr launch if startup behaviour changes in a future revision.
  const guard = path.join(root, "fixture-process-guard.mjs");
  writeFileSync(guard, `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
const fakePi = ${JSON.stringify(fakePi)};
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = childProcess[name];
  childProcess[name] = function (...args) {
    if (name !== "spawn" || args[0] !== process.execPath || !Array.isArray(args[1]) || typeof args[1][0] !== "string" || path.resolve(args[1][0]) !== fakePi) {
      throw new Error("FIXTURE_SAFETY_BLOCKED: forbidden child process " + name + " " + String(args[0]));
    }
    return Reflect.apply(original, this, args);
  };
}
syncBuiltinESMExports();
`);
  const port = await freePort();
  const token = `fixture-only-${randomUUID()}`;
  writeFileSync(path.join(root, "config.json"), JSON.stringify({
    agent: { userId: "background-selftest-user", workspace: "workspace", maxConcurrent: 1, timeoutMs: 10_000 },
    gui: { host: "127.0.0.1", port, token }, telegram: { enabled: false }, tasks: [],
    pi: { command: process.execPath, args: [fakePi], thinking: "", models: {} },
    delegations: { pollIntervalMs: 50, qqBridgeDir: path.join(root, "fake-qq", "memory", "bridge") },
  }, null, 2));
  const fixture = startFixture(path.join(root, "src", "main.ts"), guard, root);
  const api = client(port, token, { forbidDelegationWrites: true });
  try {
    const ready = await check("真实 main.ts 临时副本隔离启动，backgroundDelegations=true 且后台 jobs 初始为空", async () => {
      let latest = "尚未监听";
      const status = await until(async () => {
        if (fixture.exited) throw new Error(`main fixture 提前退出 ${JSON.stringify(fixture.result)}\n${fixture.output}`);
        try {
          const response = await api("/api/status", { timeoutMs: 500 });
          latest = `${response.status}: ${response.text}`;
          if (response.status !== 200) return undefined;
          return response.body;
        } catch (error) { latest = String(error); return undefined; }
      }, (value) => value?.backgroundDelegations === true, `main ready (${latest})`, 15_000);
      assert.equal(status.pid, fixture.child.pid, "只认自己创建的 fixture PID，不能误测真实服务");
      assert.equal(path.resolve(status.workspace), path.join(root, "workspace"));
      assert.equal(status.userId, "background-selftest-user");
      assert.equal(status.backgroundJobs, 0);
      assert.deepEqual(expectStatus(await api("/api/delegations"), 200, "fixture initial jobs").jobs, []);
      assert.equal((await api("/api/status", { token: null })).status, 401);
      assert(!existsSync(callsFile), "启动本身不应运行 pi 或模型");
      console.log(`   main fixture PID=${fixture.child.pid}；HTTP 127.0.0.1:${port}；子进程仅允许 fakePi`);
    });
    if (!ready) { console.error(`main fixture 日志\n${fixture.output || "（无输出）"}`); return; }

    await check("真实 main 串接 request → PiRunner(JSONL/PI_REQUEST_ID) → outbox/chatstore，未启动任何 CA", async () => {
      const source = { channel: "telegram", chatId: "-1009876543210", threadId: 17 };
      const input = { text: "隔离烟测普通聊天：你好，请回复这条消息。", source, idempotencyKey: "fixture-normal-chat" };
      const response = await api("/api/requests", { method: "POST", body: input });
      const accepted = expectStatus(response, 202, "fixture POST request").request;
      assert(response.elapsedMs < FAST_MS, `真实 main 接收用了 ${response.elapsedMs.toFixed(1)}ms`);
      const completed = await terminalRequest(api, accepted.id);
      const expectedReply = `fakePi echoed PI_REQUEST_ID=${accepted.id}`;
      assert.equal(completed.status, "completed", JSON.stringify(completed));
      assert.equal(completed.reply, expectedReply, "真实 runner 必须读懂 fakePi 的 agent_end JSONL");
      assert.deepEqual(completed.source, source);
      await until(async () => expectStatus(await api(`/api/requests/${accepted.id}`), 200, "fixture settled request").request, (record) => Boolean(record.settledAt), "真实 main settledAt");

      const notificationId = `reply:${accepted.id}`;
      const notifications = expectStatus(await api("/api/notifications?channel=telegram"), 200, "fixture GET notifications").notifications;
      assert.equal(notifications.length, 1, JSON.stringify(notifications));
      assert.deepEqual(notifications[0].source, source);
      assert.equal(notifications[0].id, notificationId);
      assert.equal(notifications[0].text, expectedReply);
      assert.equal(notifications[0].kind, "reply");
      const historyResponse = await api("/api/history");
      assert.equal(historyResponse.status, 200, historyResponse.text);
      assert(Array.isArray(historyResponse.body));
      const history = historyResponse.body;
      assert.equal(history.length, 2, JSON.stringify(history));
      assert.equal(history.find((record) => record.id === `user:${accepted.id}`)?.text, input.text);
      assert.equal(history.find((record) => record.id === notificationId)?.text, expectedReply);
      for (const record of history) assert.equal(record.meta.requestId, accepted.id);

      const retried = expectStatus(await api("/api/requests", { method: "POST", body: input }), 202, "fixture idempotent POST").request;
      assert.equal(retried.id, accepted.id);
      assert.equal(retried.status, "completed");
      const invocations = jsonLines(callsFile);
      assert.equal(invocations.length, 1, "幂等重试不能再次 spawn fakePi");
      assert.equal(invocations[0].requestId, accepted.id);
      assert.equal(path.resolve(invocations[0].cwd), path.join(root, "workspace"));
      const sessionIndex = invocations[0].args.indexOf("--session");
      assert(sessionIndex >= 0 && inside(root, invocations[0].args[sessionIndex + 1]), "会话只能写入 fixture root");
      assert.equal(jsonLines(path.join(root, "memory", "chat.jsonl")).length, 2);
      const diskRequest = jsonFile(path.join(root, "memory", "requests.json")).requests.find((record) => record.id === accepted.id);
      assert.equal(diskRequest.reply, expectedReply);
      assert(diskRequest.settledAt);
      assert.deepEqual(jsonFile(path.join(root, "memory", "notifications.json")).notifications.find((record) => record.id === notificationId).source, source);

      const ackPath = `/api/notifications/${encodeURIComponent(notificationId)}/ack`;
      expectStatus(await api(ackPath, { method: "POST" }), 200, "fixture ACK");
      const firstAck = jsonFile(path.join(root, "memory", "notifications.json")).notifications.find((record) => record.id === notificationId).ackedAt;
      expectStatus(await api(ackPath, { method: "POST" }), 200, "fixture ACK retry");
      assert.equal(jsonFile(path.join(root, "memory", "notifications.json")).notifications.find((record) => record.id === notificationId).ackedAt, firstAck);
      assert.deepEqual(expectStatus(await api("/api/notifications?channel=telegram"), 200, "fixture after ACK").notifications, []);
      assert.deepEqual(expectStatus(await api("/api/delegations"), 200, "fixture final jobs").jobs, []);
      const finalStatus = await api("/api/status");
      assert.equal(finalStatus.body.backgroundJobs, 0);
      assert.equal(finalStatus.body.busy, 0);
      assert(!fixture.output.includes("FIXTURE_SAFETY_BLOCKED"), fixture.output);
      console.log(`   普通聊天 request=${accepted.id}；fakePi=1 次；chatstore=2 条；outbox=1 条；CA=0`);
    });
    if (failures.some((failure) => failure.name.startsWith("真实 main 串接"))) console.error(`main fixture 日志\n${fixture.output}`);
  } finally {
    await stopFixture(fixture);
  }
}

try {
  try { await componentHttpTests(); } catch (error) { recordFailure("HTTP 组件测试初始化/清理", error); }
  // Continue into the real main smoke even when a specific HTTP contract fails.
  try { await mainFixtureTests(); } catch (error) { recordFailure("main fixture 初始化/清理", error); }
} finally {
  for (const stop of cleanupCallbacks) { try { stop(); } catch (error) { recordFailure("停止临时组件", error); } }
  for (const server of ownedServers) { try { await server.close(); } catch (error) { recordFailure("关闭临时 HTTP", error); } }
  for (const fixture of [...ownedChildren]) { try { await stopFixture(fixture); } catch (error) { recordFailure("停止自己创建的 fixture 子进程", error); } }
  try {
    if (ownedChildren.size) throw new Error(`fixture 尚未退出，保留其临时目录以免删除活动文件：${temporaryRoot}`);
    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) { recordFailure("仅清理本次 mkdtemp 目录", error); }
}

if (failures.length) {
  console.error(`\nFAIL background-selftest: ${passed} passed, ${failures.length} failed. 未修改生产代码；失败名称如下。`);
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure.name}`));
  process.exitCode = 1;
} else {
  console.log(`\nPASS background-selftest: ${passed} tests；真实本地 HTTP + 隔离 main，未启动真实 herdr/模型/QQ/TG。`);
}
