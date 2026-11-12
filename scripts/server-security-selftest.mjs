import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GuiServer } from "../src/server.ts";
import { redactText, StreamingRedactor } from "../src/redact.ts";

const SECRET = "configured-gui-password";
const ESCAPED_SECRET = 'credential-with-"quotes"\\and\na-newline';
const secrets = [SECRET, ESCAPED_SECRET, "含空格的 私人密钥🔑"];
const redact = (text) => redactText(text, secrets);

test("streaming and complete redaction agree across overlapping secrets, word boundaries and varied chunks", () => {
  const configured = ["short", "short-long-secret", ...secrets];
  const sanitize = (text) => redactText(text, configured);
  assert.equal(sanitize("short-long-secret"), "[密钥已隐藏]");
  const samples = [
    "普通内容 without credentials。",
    `short-long-secret ${secrets.join(" / ")}。`,
    "notBearer abcdefghijklmnop / xsk-123456789012 / sk-123456789012。",
    "BEARER\r\n abcdefghijklmnop / https://abc.maas.aliyuncs.com:8080/v1。",
    "sk-123456789012_ / tvly-123456789012- / 123456789:abcdefghijklmnopqrstuv/",
  ];
  for (const text of samples) {
    for (let size = 1; size <= text.length; size++) {
      const stream = new StreamingRedactor(sanitize, configured);
      let output = "";
      for (let index = 0; index < text.length; index += size) output += stream.push(text.slice(index, index + size));
      output += stream.end();
      assert.equal(output, sanitize(text), `chunk size ${size}`);
      assert.equal(stream.end(), "", "a repeated flush is empty");
    }
  }
});

async function fixture(t, extra = {}) {
  const temporaryParent = path.resolve(tmpdir());
  const root = mkdtempSync(path.join(temporaryParent, "pa-server-security-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "workspace-other");
  mkdirSync(workspace);
  mkdirSync(outside);
  writeFileSync(path.join(workspace, "正常文件.txt"), "workspace content");
  writeFileSync(path.join(outside, "private.txt"), "outside sentinel");
  const server = new GuiServer({
    workspace, publicDir: root, uploadDir: path.join(workspace, "attachments"),
    host: "127.0.0.1", port: 0, log: () => {}, redact, redactSecrets: secrets,
    onMessage: () => {}, onExternal: async () => "", onAbort: () => {}, onReset: () => {},
    status: () => ({ nested: { secret: SECRET, escaped: ESCAPED_SECRET }, busy: 0 }),
    history: () => [], ...extra,
  });
  t.after(async () => {
    await server.close();
    assert.equal(path.dirname(root), temporaryParent);
    assert(path.basename(root).startsWith("pa-server-security-"));
    rmSync(root, { recursive: true, force: true });
  });
  await server.listen();
  const base = `http://127.0.0.1:${server.port}`;
  const getFile = (name) => fetch(`${base}/api/file?p=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(3000) });
  return { root, workspace, outside, server, base, getFile };
}

async function events(t, base) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const received = [];
  let pending = "";
  let error;
  const pump = (async () => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        let boundary;
        while ((boundary = pending.indexOf("\n\n")) !== -1) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const name = frame.match(/^event: (.+)$/m)?.[1];
          const data = frame.match(/^data: (.*)$/m)?.[1];
          if (name && data !== undefined) received.push({ event: name, data: JSON.parse(data) });
        }
      }
    } catch (caught) { if (!controller.signal.aborted) error = caught; }
  })();
  t.after(async () => { controller.abort(); await pump; });
  async function until(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate(received)) {
      if (error) throw error;
      assert(Date.now() < deadline, `SSE timeout: ${JSON.stringify(received)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return received;
  }
  await until((rows) => rows.some((row) => row.event === "status"));
  return { received, until };
}

test("JSON, initial SSE status and every broadcast redact string values and keys without breaking JSON", { timeout: 10000 }, async (t) => {
  const { server, base } = await fixture(t);
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.deepEqual(status, { nested: { secret: "[密钥已隐藏]", escaped: "[密钥已隐藏]" }, busy: 0 });
  const sse = await events(t, base);
  assert.deepEqual(sse.received[0].data, status);
  const names = ["user", "tool_start", "tool_end", "done", "notification", "delegations", "status"];
  for (const event of names) {
    server.broadcast(event, { text: SECRET, nested: { [ESCAPED_SECRET]: [ESCAPED_SECRET, 42, false, null] } });
  }
  await sse.until((rows) => rows.length === names.length + 1);
  for (const row of sse.received.slice(1)) {
    assert.equal(row.data.text, "[密钥已隐藏]");
    assert.deepEqual(row.data.nested, { "[密钥已隐藏]": ["[密钥已隐藏]", 42, false, null] });
  }
});

test("split deltas redact configured secrets and fallback credential patterns, including every possible split", { timeout: 15000 }, async (t) => {
  const { server, base } = await fixture(t);
  const sse = await events(t, base);
  const samples = [
    ...secrets,
    "sk-notConfigured_123456789",
    "tvly-notConfigured_123456789",
    "Bearer nonConfigured.token-123",
    "bearer\t\n nonConfigured.token-123",
    "https://api.telegram.org/bot123456789:abcdefghijklmnopqrstuvwxyz_123456/getMe",
    "https://instance-123.cn-beijing.maas.aliyuncs.com/v1",
  ];
  const expected = new Map();
  for (const sample of samples) {
    for (let split = 1; split < sample.length; split++) {
      const requestId = `split-${expected.size}`;
      const text = `前文 ${sample} 后文。`;
      expected.set(requestId, redact(text));
      server.broadcast("delta", { requestId, text: `前文 ${sample.slice(0, split)}` });
      server.broadcast("delta", { requestId, text: `${sample.slice(split)} 后文。` });
      server.broadcast("busy", { requestId, busy: false });
    }
  }
  server.broadcast("marker", { done: true });
  await sse.until((rows) => rows.some((row) => row.event === "marker"));
  for (const [requestId, wanted] of expected) {
    const text = sse.received.filter((row) => row.event === "delta" && row.data.requestId === requestId).map((row) => row.data.text).join("");
    assert.equal(text, wanted, requestId);
  }
  const wire = JSON.stringify(sse.received);
  for (const secret of secrets) assert(!wire.includes(secret), "configured secret must never appear on SSE");
});

test("character-at-a-time streaming retains word boundaries and hides complete credentials", { timeout: 10000 }, async (t) => {
  const { server, base } = await fixture(t);
  const sse = await events(t, base);
  const text = `中文正常输出。 ${SECRET} ${ESCAPED_SECRET} sk-123456789012 Bearer abcdefghijklmnop 123456:abcdefghijklmnopqrst / instance.maas.aliyuncs.com。`;
  for (const character of text) server.broadcast("delta", { requestId: "characters", text: character });
  server.broadcast("done", { meta: { requestId: "characters" }, text: "finished" });
  await sse.until((rows) => rows.some((row) => row.event === "done"));
  const deltas = sse.received.filter((row) => row.event === "delta");
  assert.equal(deltas.map((row) => row.data.text).join(""), redact(text));
  assert(deltas.some((row) => row.data.text.includes("中")), "ordinary Chinese remains streamed");
});

test("stream buffers are isolated by request, survive unrelated events and flush before terminal events", { timeout: 10000 }, async (t) => {
  const { server, base } = await fixture(t);
  const sse = await events(t, base);
  server.broadcast("delta", { requestId: "first", text: "答复 configured-" });
  server.broadcast("delta", { requestId: "second", text: "另一个请求 abc" });
  server.broadcast("notification", { text: "unrelated background notification" });
  server.broadcast("tool_start", { requestId: "first", detail: SECRET });
  server.broadcast("delta", { requestId: "first", text: "gui-password" });
  server.broadcast("busy", { requestId: "first", busy: false });
  server.broadcast("done", { meta: { requestId: "first" }, text: SECRET });
  server.broadcast("done", { meta: { requestId: "second" }, text: "finished" });
  await sse.until((rows) => rows.filter((row) => row.event === "done").length === 2);
  for (const [id, expected] of [["first", "答复 [密钥已隐藏]"], ["second", "另一个请求 abc"]]) {
    const matching = sse.received.filter((row) => row.event === "delta" && row.data.requestId === id);
    assert.equal(matching.map((row) => row.data.text).join(""), expected);
    const finalDelta = sse.received.indexOf(matching.at(-1));
    const terminal = sse.received.findIndex((row) => row.event === "done" && row.data.meta?.requestId === id);
    assert(finalDelta < terminal);
  }
});

test("reset discards pending text, and legacy deltas without request IDs still finish", { timeout: 10000 }, async (t) => {
  const { server, base } = await fixture(t);
  const sse = await events(t, base);
  server.broadcast("delta", { requestId: "old", text: "configured-" });
  server.broadcast("reset", {});
  server.broadcast("busy", { requestId: "old", busy: false });
  server.broadcast("delta", { text: "普通内容 last-word" });
  server.broadcast("done", { text: "finished" });
  await sse.until((rows) => rows.some((row) => row.event === "done"));
  assert(!sse.received.some((row) => row.event === "delta" && row.data.requestId === "old"));
  assert.equal(sse.received.filter((row) => row.event === "delta").map((row) => row.data.text).join(""), "普通内容 last-word");
});

test("unconfigured servers preserve ordinary SSE behavior", { timeout: 10000 }, async (t) => {
  const { server, base } = await fixture(t, { redact: undefined, redactSecrets: undefined });
  const sse = await events(t, base);
  server.broadcast("delta", { text: "immediate" });
  await sse.until((rows) => rows.some((row) => row.event === "delta"));
  assert.equal(sse.received.find((row) => row.event === "delta").data.text, "immediate");
});

test("workspace files remain readable while traversal, sibling prefixes, missing paths and directories return 404", { timeout: 10000 }, async (t) => {
  const { workspace, outside, getFile } = await fixture(t);
  for (const name of ["正常文件.txt", path.join(workspace, "正常文件.txt")]) {
    const response = await getFile(name);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "workspace content");
    assert.match(response.headers.get("content-type"), /text\/plain/);
  }
  writeFileSync(path.join(workspace, "..合法文件.txt"), "valid dot prefix");
  assert.equal((await getFile("..合法文件.txt")).status, 200);
  for (const name of ["../workspace-other/private.txt", path.join(outside, "private.txt"), "missing.txt", ".", "正常文件.txt\0"]) {
    const response = await getFile(name);
    assert.equal(response.status, 404, JSON.stringify(name));
    assert.equal(await response.text(), "文件不存在");
  }
});

test("directory junctions/symlinks cannot escape workspace, while links staying inside still work", { timeout: 10000 }, async (t) => {
  const { workspace, outside, getFile } = await fixture(t);
  const type = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(outside, path.join(workspace, "external-link"), type);
  mkdirSync(path.join(workspace, "nested"));
  symlinkSync(outside, path.join(workspace, "nested", "external-link"), type);
  for (const name of ["external-link/private.txt", "nested/external-link/private.txt"]) {
    const response = await getFile(name);
    assert.equal(response.status, 404, name);
    assert.equal(await response.text(), "文件不存在");
  }
  mkdirSync(path.join(workspace, "internal"));
  writeFileSync(path.join(workspace, "internal", "inside.txt"), "internal link content");
  symlinkSync(path.join(workspace, "internal"), path.join(workspace, "internal-link"), type);
  const internal = await getFile("internal-link/inside.txt");
  assert.equal(internal.status, 200);
  assert.equal(await internal.text(), "internal link content");
  symlinkSync(path.join(outside, "not-created"), path.join(workspace, "broken-link"), type);
  assert.equal((await getFile("broken-link/private.txt")).status, 404);
});

test("a workspace configured through a directory junction/symlink uses its real root", { timeout: 10000 }, async (t) => {
  const { root, workspace, outside } = await fixture(t);
  const alias = path.join(root, "workspace-alias");
  symlinkSync(workspace, alias, process.platform === "win32" ? "junction" : "dir");
  symlinkSync(outside, path.join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
  const aliased = new GuiServer({
    workspace: alias, publicDir: root, uploadDir: alias, host: "127.0.0.1", port: 0,
    log: () => {}, onMessage: () => {}, onExternal: async () => "", onAbort: () => {}, onReset: () => {}, status: () => ({}), history: () => [],
  });
  t.after(() => aliased.close());
  await aliased.listen();
  const get = (name) => fetch(`http://127.0.0.1:${aliased.port}/api/file?p=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(3000) });
  assert.equal(await (await get("正常文件.txt")).text(), "workspace content");
  assert.equal((await get("escape/private.txt")).status, 404);
});

test("file symlinks outside workspace are denied, and internal file symlinks are readable", { timeout: 10000 }, async (t) => {
  const { workspace, outside, getFile } = await fixture(t);
  try {
    symlinkSync(path.join(outside, "private.txt"), path.join(workspace, "external-file.txt"), "file");
    symlinkSync(path.join(workspace, "正常文件.txt"), path.join(workspace, "internal-file.txt"), "file");
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip("Windows file symlink privilege unavailable; directory junction tests remain required");
      return;
    }
    throw error;
  }
  const external = await getFile("external-file.txt");
  assert.equal(external.status, 404);
  assert.equal(await external.text(), "文件不存在");
  const internal = await getFile("internal-file.txt");
  assert.equal(internal.status, 200);
  assert.equal(await internal.text(), "workspace content");
});
