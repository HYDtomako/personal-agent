// Node 24，无依赖、全离线：只 mock fs/fetch/HTTP 超时，不启动服务、终端或模型。
// Kimi 的实际 --auto 启动参数由后台 adapter 的独立测试覆盖，不再由此扩展启动。
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { Script, runInNewContext } from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(root, "config.json");
const cwd = path.join(root, "offline-delegation-fixture");
const executionCwd = path.join(root, "offline-delegation-worktree");
const originalRead = fs.readFileSync;
const envNames = ["PI_USER_ID", "PI_API_URL", "PI_GUI_TOKEN", "PI_REQUEST_ID", "PI_REVIEW_JOB_ID"];
const originalEnv = new Map(envNames.map((name) => [name, process.env[name]]));
const owner = "delegate-selftest-owner";
const envToken = "offline-only-gui-env-token";
const configToken = "offline-only-gui-config-token";
const modelKey = "offline-only-model-key/with+encoding";
const tools = new Map();
const calls = [];
const timers = new Map();
const delays = [];
let config;
let configReadError = false;
let snapshotStatus = "queued";
let jobOverrides = {};
let output = "cached output only; backend has not started";
let handler;
let checks = 0;

function pass(message) {
  checks++;
  console.log(`ok ${checks} ${message}`);
}

function reset() {
  calls.length = 0;
  configReadError = false;
  config = {
    agent: { userId: owner },
    gui: { port: 18787, token: configToken },
    models: { providers: [{ apiKey: modelKey }] },
  };
  process.env.PI_USER_ID = owner;
  process.env.PI_API_URL = "http://127.0.0.1:19878/";
  process.env.PI_GUI_TOKEN = envToken;
  process.env.PI_REQUEST_ID = "turn-from-main-thread";
  delete process.env.PI_REVIEW_JOB_ID;
  snapshotStatus = "queued";
  jobOverrides = {};
  output = "cached output only; backend has not started";
  handler = contractResponse;
}

function delivery(extra = {}) {
  return {
    mode: "git-worktree", state: "prepared",
    identity: { targetRoot: root, targetCwd: cwd, targetBranch: "offline-target", targetHead: "a".repeat(40) },
    executionCwd, worktreePath: executionCwd, changes: [], targetUpdated: false, alreadyPresent: false,
    cleanupDone: false, committed: false, pushed: false, deployed: false, ...extra,
  };
}

function job(extra = {}) {
  return {
    id: "offline-job-id", name: "server-generated-name", worker: "kimi", status: snapshotStatus,
    cwd, executionCwd, deliveryManaged: true, deliveryHold: false, delivery: delivery(),
    createdAt: "2026-10-13T00:00:00.000Z", requestId: "turn-from-main-thread", ...jobOverrides, ...extra,
  };
}

function response(status, data) {
  return { status, ok: status >= 200 && status < 300, text: async () => typeof data === "string" ? data : JSON.stringify(data) };
}

function contractResponse(call) {
  const { url, method, body } = call;
  const base = "/api/delegations";
  if (method === "GET" && url.pathname === "/api/status") return response(200, { projectDelivery: true });
  if (method === "POST" && url.pathname.startsWith(`${base}/`) && url.pathname.endsWith("/integrate")) {
    return response(202, { ok: true, job: job({ status: "completed", delivery: delivery({ state: "applying" }) }) });
  }
  if (method === "POST" && url.pathname === base) {
    // A queued job has neither a pane nor a running CA; acceptance must still return immediately.
    return response(202, { ok: true, job: job({ worker: body.worker, name: body.name || "server-generated-name" }) });
  }
  if (method === "GET" && url.pathname === base) return response(200, { ok: true, jobs: [job()] });
  if (method === "GET" && url.pathname.endsWith("/output")) return response(200, { ok: true, job: job(), output });
  if (method === "GET" && url.pathname.startsWith(`${base}/`)) return response(200, { ok: true, job: job() });
  if (method === "POST" && /\/(reply|keys|cancel|close)$/.test(url.pathname)) return response(200, { ok: true, job: job() });
  throw new Error("Unexpected offline API route");
}

function message(result) {
  return result.content.map((item) => item.text).join("\n");
}

function noSecrets(result) {
  const serialized = JSON.stringify(result);
  for (const secret of [envToken, configToken, modelKey, encodeURIComponent(modelKey)]) assert.equal(serialized.includes(secret), false, "credential appeared in a tool result");
}

function failed(result, pattern) {
  assert.equal(result.details?.ok, false, message(result));
  assert.notEqual(result.details?.accepted, true);
  assert.doesNotMatch(message(result), /后台已接收|任务已派发/);
  if (pattern) assert.match(message(result), pattern);
  noSecrets(result);
}

async function invoke(name, params = {}) {
  const tool = tools.get(name);
  assert(tool, `Missing tool ${name}`);
  const started = performance.now();
  const result = await tool.execute("offline-selftest", params);
  assert(performance.now() - started < 1000, `${name} must not wait for a coding agent`);
  assert.equal(timers.size, 0, "HTTP deadline timer must always be cleared");
  noSecrets(result);
  return result;
}

const dispatchParams = { task: "offline contract task", cwd };

function preflightAndPost(route = "/api/delegations") {
  assert.deepEqual(calls.map((call) => [call.method, call.url.pathname]), [["GET", "/api/status"], ["POST", route]]);
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[0].headers.get("x-token"), calls[1].headers.get("x-token"));
  return calls[1];
}

function sourceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert(from >= 0 && to > from, `Missing source section: ${start}`);
  return source.slice(from, to);
}

try {
  reset();
  mock.method(fs, "readFileSync", (file, ...args) => {
    const filename = file instanceof URL ? fileURLToPath(file) : file;
    if (typeof filename === "string" && path.resolve(filename) === configPath) {
      if (configReadError) throw new Error(`mock config read failure ${modelKey}`);
      return JSON.stringify(config);
    }
    return originalRead(file, ...args);
  });
  mock.method(fs, "existsSync", (file) => typeof file === "string" && path.resolve(file) === cwd);
  // Only request-deadline timers are allowed; tests can fire the callback explicitly, never sleep.
  mock.method(globalThis, "setTimeout", (callback, ms) => {
    assert.equal(ms, 10_000, "The extension must only schedule its short HTTP deadline");
    const handle = {};
    timers.set(handle, callback);
    delays.push(ms);
    return handle;
  });
  mock.method(globalThis, "clearTimeout", (handle) => timers.delete(handle));
  mock.method(globalThis, "fetch", async (input, options) => {
    assert(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, "error", "Do not forward x-token through redirects");
    const headers = new Headers(options.headers);
    assert.equal(headers.get("accept"), "application/json");
    const call = {
      url: new URL(String(input)), method: options.method, headers,
      body: options.body === undefined ? undefined : JSON.parse(options.body), signal: options.signal,
    };
    if (call.body !== undefined) assert.equal(headers.get("content-type"), "application/json");
    calls.push(call);
    return handler(call);
  });
  syncBuiltinESMExports();

  const { default: register } = await import("../workspace/.pi/extensions/delegate-tools.ts");
  register({ registerTool: (tool) => {
    assert(!tools.has(tool.name));
    tools.set(tool.name, tool);
  } });
  assert.deepEqual([...tools.keys()].sort(), ["agent_cancel", "agent_close", "agent_dispatch", "agent_integrate", "agent_keys", "agent_read", "agent_reply", "agent_status", "agent_wait"]);
  const schema = tools.get("agent_dispatch").parameters;
  assert.equal(schema.additionalProperties, false);
  assert.equal("source" in schema.properties, false);
  assert.equal("requestId" in schema.properties, false);
  assert.equal(schema.properties.timeout_minutes.default, 60);
  assert.equal(schema.properties.timeout_minutes.maximum, 240);
  assert.deepEqual(schema.properties.isolation.enum, ["direct", "worktree"]);
  assert.match(schema.properties.wait_ms.description, /忽略/);
  assert.deepEqual(tools.get("agent_integrate").parameters.required, ["target"]);
  assert.equal(tools.get("agent_integrate").parameters.additionalProperties, false);
  pass("工具名称兼容并包含 agent_integrate，来源字段不暴露给模型");

  let result = await invoke("agent_dispatch", { ...dispatchParams, wait_ms: 600_000, source: { channel: "forged" }, requestId: "model-forged-request" });
  assert.equal(result.details?.accepted, true);
  assert.equal(result.details?.job_id, "offline-job-id");
  assert.equal(result.details?.status, "queued");
  assert.match(message(result), /后台已接收.*offline-job-id/);
  assert.match(message(result), /不代表执行成功/);
  assert.match(message(result), /普通聊天可继续/);
  assert.match(message(result), /不要本轮反复查询/);
  const dispatched = preflightAndPost();
  assert.equal(dispatched.url.href, "http://127.0.0.1:19878/api/delegations");
  assert.equal(dispatched.headers.get("x-token"), envToken);
  assert.deepEqual(dispatched.body, { ...dispatchParams, worker: "kimi", timeoutMs: 3_600_000, requestId: "turn-from-main-thread" });
  assert.equal(result.details.cwd, cwd);
  assert.equal(result.details.executionCwd, executionCwd);
  assert.notEqual(result.details.cwd, result.details.executionCwd);
  assert.deepEqual(result.details.delivery.identity, delivery().identity);
  assert.equal(result.details.delivery.changeCount, 0);
  pass("先 GET feature 再 POST；未启动 CA 也立即返回 ID，cwd 保持原目录、executionCwd 为隔离树");

  for (const [worker, expected] of [["kimi", "kimi"], [" KIMI ", "kimi"], ["claude", "claude"], ["codex", "codex"]]) {
    reset();
    result = await invoke("agent_dispatch", { ...dispatchParams, worker, name: " task-name ", wait_ms: 0 });
    assert.equal(result.details?.accepted, true);
    const submitted = preflightAndPost();
    assert.equal(submitted.body.worker, expected);
    assert.equal(submitted.body.name, "task-name");
  }
  reset();
  delete process.env.PI_REQUEST_ID;
  await invoke("agent_dispatch", { ...dispatchParams, requestId: "forged", source: "qq:forged" });
  const noSource = preflightAndPost();
  assert.equal("source" in noSource.body, false);
  assert.equal("requestId" in noSource.body, false);
  pass("执行器规范化且不创建工作区；环境未注入时不接受模型伪造渠道");

  for (const minutes of [0.5, 1, 90, 240]) {
    reset();
    result = await invoke("agent_dispatch", { ...dispatchParams, timeout_minutes: minutes, wait_ms: Number.POSITIVE_INFINITY });
    assert.equal(result.details?.accepted, true);
    const submitted = preflightAndPost();
    assert.equal(submitted.body.timeoutMs, minutes * 60_000);
    assert.equal("wait_ms" in submitted.body, false);
  }
  for (const minutes of [0, -1, 240.01, NaN, Infinity, "60", null, 1e-99]) {
    reset();
    failed(await invoke("agent_dispatch", { ...dispatchParams, timeout_minutes: minutes }), /timeout_minutes/);
    assert.equal(calls.length, 0);
  }
  pass("CA deadline 分钟转毫秒并校验边界；wait_ms 完全忽略");

  for (const params of [{ ...dispatchParams, task: " " }, { ...dispatchParams, cwd: "relative-dir" }, { ...dispatchParams, cwd: path.join(root, "missing-fixture") }, { ...dispatchParams, worker: "kimi;invalid" }]) {
    reset();
    failed(await invoke("agent_dispatch", params));
    assert.equal(calls.length, 0);
  }
  for (const name of ["agent_status", "agent_read", "agent_wait", "agent_integrate", "agent_reply", "agent_keys", "agent_cancel", "agent_close"]) {
    reset();
    failed(await invoke(name, { target: "..", text: "test", keys: "enter" }), /target/);
    assert.equal(calls.length, 0);
  }
  pass("无效任务/目录/执行器与路径跳转 target 不发请求");

  const parametersFor = {
    agent_dispatch: dispatchParams,
    agent_status: { target: "offline-job-id" }, agent_read: { target: "offline-job-id" }, agent_wait: { target: "offline-job-id" },
    agent_reply: { target: "offline-job-id", text: "follow up" }, agent_keys: { target: "offline-job-id", keys: "enter" },
    agent_cancel: { target: "offline-job-id" }, agent_close: { target: "offline-job-id" },
    agent_integrate: { target: "offline-job-id" },
  };
  for (const [name, params] of Object.entries(parametersFor)) {
    reset();
    process.env.PI_USER_ID = "not-the-owner";
    failed(await invoke(name, params), /身份不匹配/);
    assert.equal(calls.length, 0);
  }
  reset();
  delete process.env.PI_USER_ID;
  failed(await invoke("agent_dispatch", dispatchParams), /身份不匹配/);
  config.agent.userId = "";
  failed(await invoke("agent_dispatch", dispatchParams), /agent.userId/);
  configReadError = true;
  failed(await invoke("agent_dispatch", dispatchParams), /读取配置失败/);
  assert.equal(calls.length, 0);
  pass("所有工具保留 owner 校验；无 owner/坏配置拒绝且不泄漏读取错误中的 key");

  for (const reviewId of ["review-job", ""]) {
    for (const name of ["agent_dispatch", "agent_integrate", "agent_reply", "agent_keys", "agent_cancel", "agent_close"]) {
      reset();
      process.env.PI_REVIEW_JOB_ID = reviewId;
      failed(await invoke(name, parametersFor[name]), /后台验收上下文禁止/);
      assert.equal(calls.length, 0);
    }
  }
  for (const name of ["agent_status", "agent_read", "agent_wait"]) {
    reset();
    process.env.PI_REVIEW_JOB_ID = "review-job";
    result = await invoke(name, parametersFor[name]);
    assert.equal(result.details?.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
  }
  pass("验收上下文禁止所有变更（含 agent_integrate）/递归派发，允许状态和缓存查询");

  for (const name of ["agent_dispatch", "agent_integrate"]) {
    for (const payload of [{}, { projectDelivery: false }, { projectDelivery: "true" }, { projectDelivery: 1 }, { features: { projectDelivery: true } }]) {
      reset();
      handler = () => response(200, payload);
      failed(await invoke(name, parametersFor[name]), /未加载自动交付版本/);
      assert.deepEqual(calls.map((call) => [call.method, call.url.pathname]), [["GET", "/api/status"]]);
    }
    for (const [status, payload] of [
      [503, { error: "offline service unavailable" }], [200, "not JSON"],
      [200, { ok: false, projectDelivery: true }], [202, { projectDelivery: true }],
    ]) {
      reset();
      handler = () => response(status, payload);
      failed(await invoke(name, parametersFor[name]), /无法确认.*自动交付版本/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, "GET", "Failed feature preflight must never POST");
    }
  }
  pass("dispatch/integrate 严格要求 projectDelivery===true；缺 flag、假值、坏响应及非 200 不 POST");

  for (const name of ["agent_status", "agent_read", "agent_wait"]) {
    reset();
    handler = (call) => {
      assert.notEqual(call.url.pathname, "/api/status", "Read-only snapshots must work with legacy services");
      return contractResponse(call);
    };
    result = await invoke(name, parametersFor[name]);
    assert.equal(result.details.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
  }
  pass("status/read/wait 不做 feature 门控，旧服务历史任务仍可读");

  reset();
  const integrateTarget = "delivery/job ?#中文";
  result = await invoke("agent_integrate", { target: integrateTarget });
  assert.equal(result.details.accepted, true);
  assert.equal(result.details.status, "completed");
  assert.equal(result.details.delivery.state, "applying");
  assert.deepEqual(preflightAndPost(`/api/delegations/${encodeURIComponent(integrateTarget)}/integrate`).body, { requestId: "turn-from-main-thread" });
  assert.match(message(result), /不重跑 CA/);
  assert.match(message(result), /尚不代表原项目交付成功/);
  assert.match(message(result), /不要循环查询/);
  for (const code of ["delivery_not_eligible", "delivery_conflict", "target_busy"]) {
    reset();
    handler = (call) => call.url.pathname === "/api/status" ? contractResponse(call) : response(409, { ok: false, error: { code, message: "retain delivery hold" } });
    failed(await invoke("agent_integrate", { target: integrateTarget }), new RegExp(`HTTP 409.*${code}`));
    preflightAndPost(`/api/delegations/${encodeURIComponent(integrateTarget)}/integrate`);
  }
  pass("integrate 只短请求 GET+POST/202，编码 target；不重跑 CA、不轮询、不掩盖交付拒绝");

  reset();
  delete process.env.PI_API_URL;
  delete process.env.PI_GUI_TOKEN;
  result = await invoke("agent_status");
  assert.equal(result.details?.ok, true);
  assert.equal(calls[0].url.origin, "http://127.0.0.1:18787");
  assert.equal(calls[0].headers.get("x-token"), configToken);
  assert.equal(calls[0].body, undefined);
  process.env.PI_API_URL = " ";
  process.env.PI_GUI_TOKEN = " ";
  calls.length = 0;
  await invoke("agent_status");
  assert.equal(calls[0].url.origin, "http://127.0.0.1:18787");
  assert.equal(calls[0].headers.get("x-token"), configToken);
  delete config.gui.token;
  calls.length = 0;
  failed(await invoke("agent_dispatch", dispatchParams), /认证未配置/);
  assert.equal(calls.length, 0);
  config.gui.token = configToken;
  config.gui.port = 0;
  failed(await invoke("agent_status"), /地址无效/);
  assert.equal(calls.length, 0);
  process.env.PI_API_URL = `http://user:${envToken}@127.0.0.1:8787/`;
  failed(await invoke("agent_status"), /地址无效/);
  assert.equal(calls.length, 0);
  pass("API URL/token 优先环境变量，fallback loopback/gui 配置；缺认证/坏地址安全拒绝");

  const target = "name/pane ?#中文";
  reset();
  result = await invoke("agent_wait", { target, until: "completed", timeout_ms: 14_400_000 });
  assert.equal(result.details?.status, "queued");
  assert.match(message(result), /仅查询一次快照/);
  assert.match(message(result), /已忽略，不等待/);
  assert.doesNotMatch(message(result), /已达目标状态/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url.pathname, `/api/delegations/${encodeURIComponent(target)}`);
  assert.equal(calls[0].url.search, "");
  pass("兼容 wait 不等目标状态、不轮询，单次编码 target 的 GET 即返回");

  for (const [lines, expected] of [[undefined, 60], [500, 200], [1, 10], [NaN, 60], [Infinity, 60], [12.7, 13]]) {
    reset();
    snapshotStatus = "completed";
    output = "cached final diff and test report";
    result = await invoke("agent_read", { target, lines });
    assert.match(message(result), /CA 已报告完成，待独立验收/);
    assert.match(message(result), /cached final diff and test report/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.pathname, `/api/delegations/${encodeURIComponent(target)}/output`);
    assert.equal(calls[0].url.search, `?lines=${expected}`);
  }
  reset();
  output = "";
  result = await invoke("agent_read", { target });
  assert.match(message(result), /暂无缓存输出，不代表完成/);
  pass("read 只读缓存快照、限制行数；completed 仍须独立验收");

  const meanings = new Map([
    ["queued", /队列已接收/], ["starting", /启动中/], ["running", /执行中/],
    ["needs_attention", /需要关注/], ["idle", /不代表成功完成/], ["completed", /待独立验收/],
    ["failed", /执行失败/], ["timed_out", /执行超时/], ["cancelled", /任务已取消/], ["closed", /资源已关闭/],
  ]);
  for (const [status, expected] of meanings) {
    reset();
    snapshotStatus = status;
    result = await invoke("agent_status", { target });
    assert.equal(result.details?.status, status);
    assert.match(message(result), expected);
  }
  reset();
  handler = () => response(200, { ok: true, jobs: [] });
  result = await invoke("agent_status");
  assert.match(message(result), /没有受管后台任务/);
  reset();
  handler = () => response(200, { ok: true, jobs: [job({ status: "queued" }), job({ id: "failed-job", status: "failed" })] });
  result = await invoke("agent_status");
  assert.equal(result.details?.jobs.length, 2);
  assert.match(message(result), /队列已接收/);
  assert.match(message(result), /执行失败/);
  pass("列表/终态/needs_attention 文案区分接收、关注、失败与待验收完成");

  const deliveryMeanings = new Map([
    ["preparing", /准备交付环境中/], ["prepared", /交付环境已准备/],
    ["changes_ready", /变更已就绪，待验收\/回写/], ["applying", /回写原项目中/],
    ["applied", /已回写，待原目标复验/], ["verified", /原目标复验通过，待清理/],
    ["cleaned", /原目标.*(?:验收|复验通过).*清理/], ["blocked", /交付受阻，需要处理/],
    ["rolled_back", /已回滚，未完成交付/], ["partial", /部分回写，未完成交付/], ["failed", /交付失败/],
  ]);
  for (const [state, expected] of deliveryMeanings) {
    reset();
    jobOverrides = {
      status: "completed", notifiedAt: "2026-10-13T00:02:00.000Z",
      delivery: delivery({
        state, changes: [{ path: "offline.js", diff: "private-diff-body" }],
        targetUpdated: ["applied", "verified", "cleaned", "partial", "rolled_back"].includes(state), cleanupDone: state === "cleaned",
        executionReview: { verdict: "passed", snapshot: "private-execution-review" },
        targetReview: { verdict: ["verified", "cleaned"].includes(state) ? "passed" : "failed", snapshot: "private-target-review" },
      }),
    };
    result = await invoke("agent_status", { target });
    assert.match(message(result), expected);
    assert.match(message(result), /CA 执行已结束/);
    assert.match(message(result), /目标分支=offline-target/);
    assert.match(message(result), /未提交 \/ 未推送 \/ 未部署/);
    assert.equal(result.details.cwd, cwd);
    assert.equal(result.details.executionCwd, executionCwd);
    const summary = result.details.delivery;
    assert.equal(summary.mode, "git-worktree");
    assert.equal(summary.state, state);
    assert.deepEqual(summary.identity, delivery().identity);
    assert.equal(summary.worktreePath, executionCwd);
    assert.equal(summary.changeCount, 1);
    assert.equal(summary.cleanupDone, state === "cleaned");
    assert.equal(summary.targetUpdated, jobOverrides.delivery.targetUpdated);
    for (const key of ["alreadyPresent", "committed", "pushed", "deployed"]) assert.equal(summary[key], false);
    for (const key of ["changes", "executionReview", "targetReview"]) assert.equal(key in summary, false);
    assert.doesNotMatch(JSON.stringify(result), /private-(?:diff-body|execution-review|target-review)/);
  }
  pass("11 种交付状态及目标身份/执行路径合同；只投影摘要，CA completed/隔离验收不冒充原目标交付");

  reset();
  jobOverrides = { status: "completed", notifiedAt: 1, delivery: delivery({ state: "cleaned", alreadyPresent: true, cleanupDone: true }) };
  result = await invoke("agent_status", { target });
  assert.match(message(result), /已包含本次变更/);
  assert.equal(result.details.delivery.targetUpdated, false);
  assert.equal(result.details.delivery.alreadyPresent, true);
  for (const cleanupDone of [false, true]) {
    jobOverrides = { executionCwd: cwd, delivery: delivery({ mode: "in-place", executionCwd: cwd, worktreePath: undefined, cleanupDone }) };
    result = await invoke("agent_status", { target });
    assert.equal(result.details.executionCwd, cwd);
    assert.equal(result.details.delivery.mode, "in-place");
    assert.equal(result.details.delivery.worktreePath, undefined);
    assert.match(message(result), cleanupDone ? /清理已完成（无临时树）/ : /清理未完成（原地修改，无临时树）/);
  }
  jobOverrides = { status: "completed", notifiedAt: 1, delivery: undefined, deliveryManaged: false, executionCwd: undefined };
  result = await invoke("agent_status", { target });
  assert.equal(result.details.deliveryMode, "legacy");
  assert.match(message(result), /未提供交付记录.*无法据此确认原项目已更新/);
  pass("已包含变更、非 Git 原地模式/清理标志和 legacy 不混同，也不虚报提交推送部署");

  for (const [name, status] of [["agent_cancel", "cancelled"], ["agent_close", "closed"]]) {
    reset();
    jobOverrides = { status, deliveryHold: true, delivery: delivery({ state: "blocked", error: "target branch changed", conflicts: [{ path: "private-conflict-body" }] }) };
    result = await invoke(name, { target });
    assert.equal(result.details.deliveryHold, true);
    assert.equal(result.details.delivery.state, "blocked");
    assert.equal(result.details.delivery.conflictCount, 1);
    assert.match(message(result), /需要处理.*取消\/关闭任务不会解除原项目占用/);
    assert.match(message(result), /target branch changed/);
    assert.doesNotMatch(JSON.stringify(result), /private-conflict-body/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
  }
  pass("取消/关闭回执保留 deliveryHold/冲突摘要，不宣称解除原项目占用");

  for (const [name, params, operation, expectedBody] of [
    ["agent_reply", { target, text: " follow up ", wait_ms: 999999 }, "reply", { text: "follow up" }],
    ["agent_keys", { target, keys: " down enter ", text: " raw text " }, "keys", { keys: "down enter", text: " raw text " }],
    ["agent_keys", { target, text: "text only" }, "keys", { keys: "", text: "text only" }],
    ["agent_cancel", { target }, "cancel", {}], ["agent_close", { target }, "close", {}],
  ]) {
    reset();
    snapshotStatus = "running";
    result = await invoke(name, params);
    assert.equal(result.details?.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url.pathname, `/api/delegations/${encodeURIComponent(target)}/${operation}`);
    assert.deepEqual(calls[0].body, expectedBody);
    assert.doesNotMatch(message(result), /本轮结束状态|进程已终止|已关闭「/);
  }
  reset();
  handler = () => response(409, { ok: false, error: { code: "terminal_job", message: "terminal jobs cannot be revived" } });
  failed(await invoke("agent_reply", { target, text: "continue" }), /HTTP 409.*terminal_job/);
  assert.equal(calls.length, 1);
  reset();
  handler = () => response(404, { ok: false, error: "not a managed job" });
  failed(await invoke("agent_keys", { target: "unrelated-pane", keys: "enter" }), /HTTP 404.*not a managed job/);
  assert.equal(calls.length, 1);
  pass("reply/keys/cancel/close 只提交管理 API；终态与无关 pane 错误如实返回");

  for (const name of ["agent_dispatch", "agent_integrate"]) {
    for (const [status, payload, pattern] of [
      [503, { ok: false, error: { code: "SERVICE_DOWN", message: `x-token=${envToken} config=${configToken}`, cause: { message: modelKey } } }, /HTTP 503.*SERVICE_DOWN/],
      [401, `unauthorized ${envToken} ${modelKey}`, /HTTP 401/],
      [202, { ok: false, error: "rejected" }, /HTTP 202.*rejected/],
      [200, { ok: true, job: job() }, /HTTP 200.*要求 HTTP 202/],
      [202, { ok: true }, /HTTP 202.*id\/status/],
      [202, { ok: true, job: job({ id: "" }) }, /HTTP 202.*id\/status/],
      [202, `not JSON ${modelKey}`, /HTTP 202.*非 JSON/],
    ]) {
      reset();
      handler = (call) => call.url.pathname === "/api/status" ? contractResponse(call) : response(status, payload);
      failed(await invoke(name, parametersFor[name]), pattern);
      preflightAndPost(name === "agent_dispatch" ? "/api/delegations" : "/api/delegations/offline-job-id/integrate");
    }
  }
  pass("dispatch/integrate 的 POST 必须 202 和合法 job；HTTP/协议失败不虚报、不重发、不泄漏凭据");

  for (const name of ["agent_dispatch", "agent_integrate"]) {
    for (const failPost of [false, true]) {
      reset();
      handler = (call) => {
        if (failPost && call.method === "GET") return contractResponse(call);
        throw new TypeError(`fetch failed ${envToken}`, { cause: Object.assign(new Error(`connection refused ${modelKey}`), { code: "ECONNREFUSED" }) });
      };
      failed(await invoke(name, parametersFor[name]), /HTTP 请求失败.*cause=.*ECONNREFUSED/);
      assert.equal(calls.length, failPost ? 2 : 1);
    }
  }
  pass("预检和 POST 网络错误保留 cause/错误码，凭据脱敏、不补发");

  for (const name of ["agent_dispatch", "agent_integrate"]) {
    for (const failPost of [false, true]) {
      for (const duringBody of [false, true]) {
        reset();
        handler = (call) => {
          if (failPost && call.method === "GET") return contractResponse(call);
          const aborted = new Promise((_resolve, reject) => {
            call.signal.addEventListener("abort", () => reject(new Error(`abort ${modelKey}`, { cause: new Error("deadline reached") })), { once: true });
            assert.equal(timers.size, 1);
            queueMicrotask(() => [...timers.values()][0]());
          });
          return duringBody ? { status: failPost ? 202 : 200, ok: true, text: () => aborted } : aborted;
        };
        failed(await invoke(name, parametersFor[name]), /HTTP(?: 200| 202)? timeout（10000 ms）.*cause=deadline reached/);
        assert.equal(calls.at(-1).signal.aborted, true);
        assert.equal(calls.length, failPost ? 2 : 1);
      }
    }
  }
  pass("10 秒 HTTP deadline 覆盖预检及 POST 的连接/响应体，无长等待或重试");

  reset();
  output = `token=${envToken}\nmodel ${modelKey}\nencoded ${encodeURIComponent(modelKey)}`;
  result = await invoke("agent_read", { target });
  assert.match(message(result), /REDACTED/);
  handler = () => response(200, { ok: true, job: job({ name: envToken, cwd: modelKey, apiKey: modelKey, rawConfig: config }) });
  result = await invoke("agent_status", { target });
  assert.match(message(result), /REDACTED/);
  assert.equal("rawConfig" in result.details, false);
  assert.equal("apiKey" in result.details, false);
  handler = () => response(200, { ok: true, job: job({
    executionCwd: envToken,
    delivery: delivery({
      identity: { targetRoot: modelKey, targetCwd: modelKey, targetBranch: configToken, targetHead: modelKey },
      worktreePath: modelKey, error: `token=${envToken}; ${encodeURIComponent(modelKey)}`,
      changes: [{ diff: modelKey }], executionReview: { snapshot: modelKey }, targetReview: { snapshot: configToken },
    }),
  }) });
  result = await invoke("agent_status", { target });
  assert.match(message(result), /REDACTED/);
  assert.equal(result.details.delivery.identity.targetCwd, "[REDACTED]");
  assert.equal(result.details.executionCwd, "[REDACTED]");
  pass("成功快照/交付身份/错误与 details 也脱敏，不返回原始配置、diff 或验收快照");

  // 只编译前端脚本、隔离测试纯函数和 HTTP mock；不启动页面、浏览器或服务。
  const html = originalRead(path.join(root, "public", "index.html"), "utf8");
  const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  assert(inlineScripts.length > 0);
  for (const script of inlineScripts) new Script(script, { filename: "public/index.html" });
  const frontend = inlineScripts.find((script) => script.includes("function integrateDelegation("));
  assert(frontend, "Missing frontend integration controls");
  const frontendApi = sourceBetween(frontend, "const TOKEN =", "const list =");
  const frontendHelpers = sourceBetween(frontend, "const activeDelegationStates =", "function delegationTime(");
  const frontendIntegrate = sourceBetween(frontend, "async function integrateDelegation(", "async function loadDelegationOutput(");
  const uiCalls = [];
  const uiTimers = new Set();
  const confirmations = [];
  const notice = { textContent: "", classList: { add() {}, remove() {} } };
  let allowConfirm = true;
  let featurePayload = { projectDelivery: true };
  let integrateStatus = 202;
  reset();
  const uiJob = job({ id: "ui/job ?#中文", status: "completed", notifiedAt: 1, deliveryHold: true, delivery: delivery({ state: "blocked" }) });
  const uiAcceptedJob = { ...uiJob, notifiedAt: undefined, delivery: delivery({ state: "applying" }) };
  const ui = runInNewContext(frontendApi + frontendHelpers + frontendIntegrate + `\n({
    state: delegationState, deliveryText: delegationDeliveryText, canIntegrate: canIntegrateDelegation,
    needsAttention: delegationNeedsAttention, outstanding: delegationOutstanding, integrate: integrateDelegation,
    setJobs: (jobs) => { delegationJobs = jobs; }, getJobs: () => delegationJobs,
    pending: () => integratingDelegations.size,
  })`, {
    location: { search: "" }, URLSearchParams, AbortController,
    delegationsNotice: notice, renderDelegations() {},
    confirm: (text) => { confirmations.push(text); return allowConfirm; },
    setTimeout: (_callback, ms) => { assert.equal(ms, 12000); const handle = {}; uiTimers.add(handle); return handle; },
    clearTimeout: (handle) => uiTimers.delete(handle),
    fetch: async (input, options) => {
      const url = new URL(input, "http://offline.invalid");
      const method = options?.method || "GET";
      assert(options.signal instanceof AbortSignal);
      uiCalls.push({ method, path: url.pathname, body: options.body });
      if (method === "GET" && url.pathname === "/api/status") return { ok: true, status: 200, json: async () => featurePayload };
      assert.equal(method, "POST");
      assert.equal(url.pathname, `/api/delegations/${encodeURIComponent(uiJob.id)}/integrate`);
      return { ok: true, status: integrateStatus, json: async () => ({ ok: true, job: uiAcceptedJob }) };
    },
  });
  for (const [state, expected] of deliveryMeanings) {
    const fixture = job({ status: "completed", delivery: delivery({ state, cleanupDone: state === "cleaned", executionReview: { verdict: "passed" } }) });
    const text = ui.deliveryText(fixture);
    assert.match(text, expected);
    assert(text.includes(`目标路径：${cwd}`));
    assert(text.includes(`执行路径：${executionCwd}`));
    assert.match(text, /目标分支：offline-target/);
    assert.match(text, /未提交 \/ 未推送 \/ 未部署/);
    assert.match(text, /只有原目标复验通过才算已交付/);
    assert.equal(ui.state(fixture).tone === "finished", ["verified", "cleaned"].includes(state));
    assert.equal(ui.canIntegrate({ ...fixture, notifiedAt: 1 }), state !== "cleaned");
    assert.equal(ui.canIntegrate(fixture), false, "CA completion alone must not enable retry");
  }
  for (const status of ["cancelled", "closed"]) {
    const held = { ...uiJob, status };
    assert.equal(ui.needsAttention(held), true);
    assert.equal(ui.outstanding(held), true);
    assert.equal(ui.state(held).tone, "attention");
    assert.equal(ui.canIntegrate(held), false);
    assert.match(ui.deliveryText(held), /取消\/关闭任务不会解除原项目占用/);
  }
  const legacy = job({ status: "completed", notifiedAt: 1, delivery: undefined });
  assert.equal(ui.canIntegrate(legacy), false);
  assert.notEqual(ui.state(legacy).tone, "finished");
  assert.match(ui.deliveryText(legacy), /旧任务无交付记录，不能确认原项目已更新/);
  assert.match(ui.deliveryText(job({ executionCwd: cwd, delivery: delivery({ mode: "in-place", cleanupDone: true }) })), /原地模式，无临时树/);
  pass("前端脚本语法通过；中文交付状态、原/执行路径、重试资格和终态 deliveryHold 文案正确");

  ui.setJobs([uiJob]);
  allowConfirm = false;
  await ui.integrate(uiJob.id);
  assert.equal(uiCalls.length, 0);
  assert.match(confirmations[0], /不重跑 CA.*不提交、不推送、不部署.*不重启/);
  allowConfirm = true;
  for (featurePayload of [{}, { projectDelivery: false }, { projectDelivery: "true" }]) {
    uiCalls.length = 0;
    await ui.integrate(uiJob.id);
    assert.deepEqual(uiCalls, [{ method: "GET", path: "/api/status", body: undefined }]);
    assert.match(notice.textContent, /未加载自动交付版本/);
    assert.equal(ui.getJobs()[0].deliveryHold, true);
    assert.equal(ui.pending(), 0);
    assert.equal(uiTimers.size, 0);
  }
  featurePayload = { projectDelivery: true };
  for (integrateStatus of [200, 202]) {
    uiCalls.length = 0;
    await ui.integrate(uiJob.id);
    assert.deepEqual(uiCalls, [
      { method: "GET", path: "/api/status", body: undefined },
      { method: "POST", path: `/api/delegations/${encodeURIComponent(uiJob.id)}/integrate`, body: '{"manual":true}' },
    ]);
    assert.match(notice.textContent, integrateStatus === 202 ? /已接收重试交付.*接收不代表交付成功/ : /应为 202/);
    assert.equal(ui.getJobs()[0].deliveryHold, true, "A receipt must not clear deliveryHold locally");
    assert.equal(ui.pending(), 0);
    assert.equal(uiTimers.size, 0);
  }
  assert.match(frontend, /sendBtn\.disabled = submitting \|\| \(!ta\.value\.trim\(\) && pending\.length === 0\)/);
  assert.doesNotMatch(sourceBetween(frontend, "function renderDelegations(", "async function loadDelegations("), /setBusy\(|sendBtn\.disabled|ta\.disabled|submitting\s*=/);
  assert.doesNotMatch(frontendIntegrate, /setBusy\(|sendBtn\.disabled|ta\.disabled|submitting\s*=/);
  pass("前端离线重试确认→feature GET→integrate POST/202；不重跑 CA、不解除 hold、不锁聊天");

  const extensionSource = originalRead(path.join(root, "workspace", ".pi", "extensions", "delegate-tools.ts"), "utf8");
  const system = originalRead(path.join(root, "workspace", ".pi", "SYSTEM.md"), "utf8");
  assert.doesNotMatch(extensionSource, /node:child_process|\bspawn\s*\(|\bexec(?:File|Sync)?\s*\(|ensureServer|readPane|\bsleep\s*\(/);
  assert.match(extensionSource, /--auto/);
  assert.match(system, /--auto.*完全自动/);
  assert.match(system, /300 秒/);
  assert.match(system, /15 分钟无进展/);
  assert.match(system, /240 分钟（4 小时）/);
  assert.match(system, /不要每次派活用键盘重新切模型/);
  assert.match(system, /不要再手动 qq_send 重复回执/);
  assert.match(system, /旧文件信箱 fallback/);
  assert.match(system, /projectDelivery === true/);
  assert.match(system, /默认 `isolation=direct`.*job\.cwd.*原项目/);
  assert.match(system, /只有胡同学明确要求隔离.*isolation=worktree/);
  assert.match(system, /不论哪种模式.*禁止自行 `git commit\/push\/merge\/stash\/reset`/);
  assert.match(system, /direct 模式下改动已经在原项目/);
  assert.match(system, /禁止 agent_dispatch\/agent_integrate\/reply\/keys\/cancel\/close/);
  assert.match(system, /deliveryHold 只属于 worktree 交付；direct 模式不会产生它/);
  assert.match(system, /MCP.*不.*权限升级/);
  assert.match(system, /默认不提交、不推送、不部署\/发布，也不重启业务服务/);
  assert.doesNotMatch(system, /600 秒|默认 90 秒|每次派活时先切过去/);
  assert(delays.length > 0 && delays.every((ms) => ms === 10_000));
  pass("SYSTEM 保留完全自动/时限/模型/MCP/QQ 边界，明确隔离→回写复验→清理与默认不发布重启");
  console.log(`PASS ${checks} groups; all HTTP/fs fixtures are offline. Actual Kimi --auto launch assertions belong to the background adapter self-test.`);
} finally {
  mock.restoreAll();
  syncBuiltinESMExports();
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
