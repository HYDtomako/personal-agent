/**
 * Telegram → POST /api/requests (202 immediately) → persistent notification outbox.
 * The receive loop never waits for PA/CA work or Telegram sends. A separate loop
 * sends notifications and ACKs them, persisting per-chunk delivery receipts.
 * External networking remains curl + config.telegram.proxy, with ASCII URL data.
 * Start: node tg-bridge.mjs（在项目根目录）
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireInstance } from "./app/runtime.mjs";
import {
  HTTP_TIMEOUT_MS, TelegramBridgeError, classifyError, createTelegramClient,
  createTelegramBridge, telegramSendBody, createTelegramSender, createTelegramDeliveryAudit,
} from "./app/telegram-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(here, "config.json");
// Migrate the existing {offset} file in place; receipts and local replies must
// share its atomic commit, so /start cannot be lost by advancing offset first.
const OFFSET_PATH = path.join(here, "workspace", "tg-offset.json");

function loadCfg() {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const t = cfg.telegram ?? {};
  return {
    token: String(t.token ?? "").trim(),
    apiBase: String(t.apiBase ?? "https://api.telegram.org").replace(/\/+$/, ""),
    proxy: String(t.proxy ?? "socks5h://127.0.0.1:10808"),
    allowFrom: (t.allowFrom ?? []).map(String),
    pollTimeoutSec: Number(t.pollTimeoutSec ?? 30),
    guiPort: Number(cfg.gui?.port ?? 8787),
    guiToken: String(cfg.gui?.token ?? "").trim(),
    enabled: t.enabled !== false,
  };
}

const cfg = loadCfg();
const secrets = [cfg.token, cfg.guiToken].filter(Boolean);
const log = (...parts) => {
  let text = parts.map(String).join(" ");
  for (const secret of secrets) text = text.split(secret).join("[redacted]");
  console.log(new Date().toISOString(), "[tg]", text);
};

if (!cfg.enabled) {
  log("telegram.enabled=false，退出。");
  process.exit(0);
}
if (!cfg.token) {
  log("config.json 里 telegram.token 为空，先填上 bot token 再启动。");
  process.exit(1);
}

const instance = await acquireInstance(here, "telegram");
if (!instance) {
  log("Telegram 桥接已在运行，不重复启动。");
  process.exit(0);
}

const store = {
  load() {
    try {
      return JSON.parse(readFileSync(OFFSET_PATH, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { offset: 0 };
      // Do not reset corrupt/unreadable receipts: doing so could resend messages.
      throw new TelegramBridgeError("store", "STATE_READ_FAILED");
    }
  },
  save(state) {
    mkdirSync(path.dirname(OFFSET_PATH), { recursive: true });
    const temporary = `${OFFSET_PATH}.${process.pid}.tmp`;
    let fd;
    try {
      fd = openSync(temporary, "w", 0o600);
      writeFileSync(fd, JSON.stringify(state), "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      // Same-directory rename keeps either the previous or the new full snapshot.
      renameSync(temporary, OFFSET_PATH);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  },
};

/** curl's URL/stderr may contain the bot token, so only expose classified codes. */
function curl(args, input, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", ["-sS", "--connect-timeout", "15", "-m", String(timeoutMs / 1000), "--write-out", "\n%{http_code}", ...args], { windowsHide: true });
    let out = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new DOMException("curl deadline", "TimeoutError"));
    }, timeoutMs + 1000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => { out += data; });
    child.stderr.resume(); // Drain without logging URLs, credentials or raw responses.
    // Feeding an ASCII-encoded form through stdin also avoids Windows' 32K
    // command-line limit for long Chinese chunks (percent encoding expands them).
    child.stdin.on("error", (error) => finish(error));
    child.stdin.end(input ?? "", "ascii");
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 28) return finish(new DOMException("curl timeout", "TimeoutError"));
      if (code !== 0) {
        const error = new Error("curl failed");
        error.code = code === 7 ? "ECONNREFUSED" : code === 6 ? "ENOTFOUND" : `CURL_EXIT_${code ?? "UNKNOWN"}`;
        return finish(error);
      }
      const separator = out.lastIndexOf("\n");
      const status = Number(out.slice(separator + 1));
      if (separator < 0 || !Number.isInteger(status) || status < 100) return finish(new TelegramBridgeError("protocol", "CURL_INVALID_HTTP_STATUS"));
      if (status < 200 || status >= 300) return finish(new TelegramBridgeError("http", "TELEGRAM_HTTP_ERROR", status));
      finish(null, out.slice(0, separator));
    });
  });
}

function telegramResult(out) {
  let data;
  try { data = JSON.parse(out); } catch { throw new TelegramBridgeError("protocol", "TELEGRAM_INVALID_JSON"); }
  if (data?.ok !== true) {
    if (Number.isInteger(data?.error_code)) throw new TelegramBridgeError("http", "TELEGRAM_API_ERROR", data.error_code);
    throw new TelegramBridgeError("protocol", "TELEGRAM_NOT_OK");
  }
  return data.result;
}

async function getUpdates(offset) {
  // Telegram 的长轮询需预留代理建连时间；它不占用本机 PA 请求或通知投递循环。
  const wait = Math.min(50, Math.max(0, Math.floor(cfg.pollTimeoutSec) || 0));
  const url = `${cfg.apiBase}/bot${cfg.token}/getUpdates?timeout=${wait}&offset=${offset}&allowed_updates=%5B%22message%22%5D`;
  const result = telegramResult(await curl(["-x", cfg.proxy, url], undefined, (wait + 15) * 1000));
  if (!Array.isArray(result)) throw new TelegramBridgeError("protocol", "TELEGRAM_INVALID_UPDATES");
  return result;
}

/** One chunk per call; the existing journal alone owns retry/ACK progress.
 * Audit keeps platform IDs after ACK/restart (two bounded files, no message bodies).
 * A failed audit append is logged but never reclassifies a successful send as failure.
 */
const sendMessage = createTelegramSender({
  log,
  appendAudit: createTelegramDeliveryAudit({ file: path.join(here, "memory", "telegram-deliveries.jsonl") }),
  async sendRequest(chatId, text, messageThreadId) {
    // Encode Chinese in Node before handing the ASCII form body to Windows curl.
    const body = telegramSendBody(chatId, text, messageThreadId);
    return telegramResult(await curl([
      "-x", cfg.proxy,
      "-H", "content-type: application/x-www-form-urlencoded",
      "--data-binary", "@-",
      `${cfg.apiBase}/bot${cfg.token}/sendMessage`,
    ], body));
  },
});

async function main() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const bridge = createTelegramBridge({
      api: createTelegramClient({ baseUrl: `http://127.0.0.1:${cfg.guiPort}`, token: cfg.guiToken }),
      getUpdates,
      send: sendMessage,
      store,
      allowFrom: cfg.allowFrom,
      log,
    });
    log(`启动异步 TG 桥接：guiPort=${cfg.guiPort} 白名单=${cfg.allowFrom.length ? `${cfg.allowFrom.length} 人` : "（空，仅回显 id）"}；本机 API 单次超时 ${HTTP_TIMEOUT_MS / 1000}s，Telegram 长轮询独立运行。`);
    // Neither loop waits for the other. No /api/external or request-status polling.
    await bridge.run({ signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await instance.release();
  }
}

main().catch((error) => {
  log("桥接退出：", classifyError(error).message);
  process.exitCode = 1;
});
