import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import path from "node:path";
import type { ConversationInput } from "./requests.ts";
import { normalizeSource, type ReplySource } from "./protocol.ts";

interface DelegationAPI {
  submit: (input: Record<string, unknown>) => unknown;
  list: () => unknown[];
  get: (target: string) => unknown;
  read: (target: string, lines: number) => string;
  reply: (target: string, text: string) => Promise<unknown>;
  keys: (target: string, keys: string, text?: string) => Promise<unknown>;
  cancel: (target: string) => Promise<unknown>;
  close: (target: string) => Promise<unknown>;
  integrate?: (target: string, context?: { requestId?: string; requestText?: string; manual?: boolean }) => unknown;
}

/**
 * 本地 GUI 服务：一个页面 + 一个事件流，没有构建步骤、没有前端依赖。
 *
 * 默认只监听 127.0.0.1（只在本机可达）。要让它能从手机/局域网访问，
 * 把 gui.host 改成 0.0.0.0 并**必须**同时设 gui.token——否则同网段任何人都能
 * 对着一个有 shell 权限的 agent 说话。
 */

export interface ServerDeps {
  /** pi 的工作目录（静态文件与产出的图片只允许从这里读） */
  workspace: string;
  /** 页面所在目录（public/） */
  publicDir: string;
  /** 附件落地目录 */
  uploadDir: string;
  host: string;
  port: number;
  token?: string;
  log: (...args: unknown[]) => void;
  /** 收到用户消息：由主程序接过去跑 pi，过程中通过 broadcast 推进度 */
  onMessage: (input: { text: string; uploadPaths: string[] }) => void;
  /** 外部入口（TG bridge 等）发来的消息：同步等待回复文本返回 */
  onExternal: (input: { text: string }) => Promise<string>;
  onAbort: () => void;
  /** 新对话：清空当前会话与显示记录 */
  onReset: () => void;
  /** 给页面初始化用的状态 */
  status: () => Record<string, unknown>;
  /** 对话记录（页面加载时拉取） */
  history: (n: number) => unknown;
  submitRequest?: (input: ConversationInput) => { id: string; status: string };
  requestStatus?: (id: string) => unknown;
  delegations?: DelegationAPI;
  notifications?: {
    pending: (channel: ReplySource["channel"], limit: number) => unknown[];
    ack: (id: string) => boolean;
  };
  redact?: (text: string) => string;
}

const MAX_BODY = 64 * 1024 * 1024; // 上传上限 64MB

export class GuiServer {
  private readonly clients = new Set<ServerResponse>();
  private readonly deps: ServerDeps;
  private http?: Server;

  constructor(deps: ServerDeps) {
    this.deps = deps;
  }

  /** 推给所有打开的页面（SSE）。 */
  broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  listen(): Promise<void> {
    const server = this.http = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.deps.log("[gui] 请求异常:", err instanceof Error ? err.message : err);
        if (!res.headersSent) this.json(res, { ok: false, error: err instanceof Error ? err.message : "内部错误" }, 500);
        else res.end();
      });
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.deps.port, this.deps.host, () => {
        server.off("error", reject);
        this.deps.log(`[gui] 已启动 http://${this.deps.host}:${this.deps.port}`);
        resolve();
      });
    });
  }

  get port(): number {
    const address = this.http?.address();
    return address && typeof address === "object" ? address.port : this.deps.port;
  }

  close(): Promise<void> {
    for (const response of this.clients) response.end();
    this.clients.clear();
    return new Promise((resolve, reject) => {
      if (!this.http?.listening) return resolve();
      this.http.close((error) => error ? reject(error) : resolve());
      this.http.closeIdleConnections();
    });
  }

  private authed(req: IncomingMessage, url: URL): boolean {
    const token = this.deps.token;
    if (!token) return true;
    const given = url.searchParams.get("token") ?? String(req.headers["x-token"] ?? "");
    return given === token;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const p = url.pathname;

    if (req.method !== "GET" && req.method !== "HEAD" && req.headers.origin && req.headers.origin !== url.origin) {
      return this.json(res, { ok: false, error: "拒绝跨站修改请求" }, 403);
    }
    if (!this.authed(req, url)) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      res.end("需要 token（在地址后加 ?token=…）");
      return;
    }

    if (p === "/" || p === "/index.html") return this.serveFile(res, path.join(this.deps.publicDir, "index.html"), "text/html; charset=utf-8");
    if (p === "/api/status") return this.json(res, this.deps.status());

    if (p === "/api/events") return this.sse(req, res);

    if (p === "/api/history") {
      const n = Number(url.searchParams.get("n") ?? 300);
      return this.json(res, this.deps.history(Number.isFinite(n) && n > 0 ? n : 300));
    }

    if (p === "/api/requests" || p.startsWith("/api/requests/") || p === "/api/delegations" || p.startsWith("/api/delegations/") || p === "/api/notifications" || p.startsWith("/api/notifications/")) {
      try {
        return await this.backgroundApi(req, res, url);
      } catch (error) {
        return this.json(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    if (p === "/api/upload" && req.method === "POST") return this.upload(req, res, url);
    if (p === "/api/send" && req.method === "POST") return this.send(req, res);
    if (p === "/api/external" && req.method === "POST") return this.external(req, res);
    if (p === "/api/abort" && req.method === "POST") {
      this.deps.onAbort();
      return this.json(res, { ok: true });
    }
    if (p === "/api/reset" && req.method === "POST") {
      this.deps.onReset();
      return this.json(res, { ok: true });
    }
    if (p === "/api/file") return this.serveWorkspaceFile(res, url);

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("未找到");
  }

  /** 外部入口（TG bridge）：收到消息后交给主程序，等处理完把回复文本同步返回。 */
  private async external(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    let payload: { text?: string };
    try {
      payload = JSON.parse(body.toString("utf8")) as typeof payload;
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("请求体不是合法 JSON");
      return;
    }
    const text = String(payload.text ?? "").trim();
    if (!text) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("消息为空");
      return;
    }
    const reply = await this.deps.onExternal({ text });
    this.json(res, { ok: true, reply });
  }

  private json(res: ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    const body = JSON.stringify(data);
    res.end(this.deps.redact ? this.deps.redact(body) : body);
  }

  private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const body = await this.readBody(req);
    if (!body.length) return {};
    let value: unknown;
    try { value = JSON.parse(body.toString("utf8")); } catch { throw new Error("请求体不是合法 JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须为对象");
    return value as Record<string, unknown>;
  }

  private conversationInput(body: Record<string, unknown>): ConversationInput {
    if (body.text !== undefined && typeof body.text !== "string") throw new Error("text 必须是字符串");
    if (body.uploads !== undefined && (!Array.isArray(body.uploads) || body.uploads.some((item) => typeof item !== "string"))) throw new Error("uploads 必须是字符串数组");
    if (body.idempotencyKey !== undefined && typeof body.idempotencyKey !== "string") throw new Error("idempotencyKey 必须是字符串");
    const text = (body.text as string | undefined ?? "").trim();
    const uploadPaths = body.uploads as string[] | undefined ?? [];
    if (!text && !uploadPaths.length) throw new Error("消息为空");
    return { text, uploadPaths, ...(body.source === undefined ? {} : { source: normalizeSource(body.source) }), ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey as string }) };
  }

  private async backgroundApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split("/").filter(Boolean);
    const family = parts[1];
    const target = parts[2] ? decodeURIComponent(parts[2]) : "";
    const action = parts[3] ?? "";
    const unavailable = () => this.json(res, { ok: false, error: "此服务未启用后台任务接口" }, 503);
    const missing = () => this.json(res, { ok: false, error: "没有找到对应记录或接口" }, 404);
    if (parts.length > 4) return missing();

    if (family === "requests") {
      if (!this.deps.submitRequest || !this.deps.requestStatus) return unavailable();
      if (req.method === "POST" && !target) {
        const request = this.deps.submitRequest(this.conversationInput(await this.readJson(req)));
        return this.json(res, { ok: true, request }, 202);
      }
      if (req.method === "GET" && target && !action) {
        const request = this.deps.requestStatus(target);
        return request ? this.json(res, { ok: true, request }) : missing();
      }
      return missing();
    }

    if (family === "notifications") {
      if (!this.deps.notifications) return unavailable();
      if (req.method === "GET" && !target) {
        const channel = url.searchParams.get("channel") ?? "gui";
        if (!["gui", "qq", "telegram"].includes(channel)) throw new Error("通知渠道无效");
        const limit = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get("limit"))) || 20));
        return this.json(res, { ok: true, notifications: this.deps.notifications.pending(channel as ReplySource["channel"], limit) });
      }
      if (req.method === "POST" && target && action === "ack") {
        return this.deps.notifications.ack(target) ? this.json(res, { ok: true }) : missing();
      }
      return missing();
    }

    const jobs = this.deps.delegations;
    if (!jobs) return unavailable();
    if (!target && req.method === "GET") return this.json(res, { ok: true, jobs: jobs.list() });
    if (!target && req.method === "POST") return this.json(res, { ok: true, job: jobs.submit(await this.readJson(req)) }, 202);
    const job = jobs.get(target);
    if (!job) return missing();
    if (req.method === "GET" && !action) return this.json(res, { ok: true, job });
    if (req.method === "GET" && action === "output") {
      const lines = Math.min(200, Math.max(10, Number(url.searchParams.get("lines")) || 80));
      return this.json(res, { ok: true, job, output: jobs.read(target, lines) });
    }
    if (req.method !== "POST") return missing();
    if (action === "cancel") return this.json(res, { ok: true, job: await jobs.cancel(target) });
    if (action === "close") return this.json(res, { ok: true, job: await jobs.close(target) });
    if (action === "integrate") {
      if (!jobs.integrate) return unavailable();
      const body = await this.readJson(req);
      const context = {
        requestId: typeof body.requestId === "string" ? body.requestId : undefined,
        requestText: typeof body.requestText === "string" ? body.requestText : undefined,
        manual: body.manual === true,
      };
      return this.json(res, { ok: true, job: jobs.integrate(target, context) }, 202);
    }
    const body = await this.readJson(req);
    if (action === "reply") {
      const text = String(body.text ?? "").trim();
      if (!text) throw new Error("消息为空");
      return this.json(res, { ok: true, job: await jobs.reply(target, text) });
    }
    if (action === "keys") {
      const keys = String(body.keys ?? "").trim();
      const text = body.text === undefined ? undefined : String(body.text);
      if (!keys && !text) throw new Error("keys 和 text 至少需要一个");
      await jobs.keys(target, keys, text);
      return this.json(res, { ok: true, job: jobs.get(target) });
    }
    return missing();
  }

  private serveFile(res: ServerResponse, file: string, type: string): void {
    if (!existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("文件不存在");
      return;
    }
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  }

  /** 只允许读 workspace 内的文件（agent 的产出、上传的图片）。 */
  private serveWorkspaceFile(res: ServerResponse, url: URL): void {
    const rel = url.searchParams.get("p") ?? "";
    const abs = path.resolve(this.deps.workspace, rel);
    const rootWithSep = this.deps.workspace.endsWith(path.sep) ? this.deps.workspace : this.deps.workspace + path.sep;
    if (!abs.startsWith(rootWithSep) || !existsSync(abs) || !statSync(abs).isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("文件不存在");
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const type =
      ext === ".png" ? "image/png"
      : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
      : ext === ".gif" ? "image/gif"
      : ext === ".webp" ? "image/webp"
      : ext === ".svg" ? "image/svg+xml"
      : ext === ".pdf" ? "application/pdf"
      : ext === ".json" ? "application/json"
      : ext === ".md" || ext === ".txt" ? "text/plain; charset=utf-8"
      : "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    createReadStream(abs).pipe(res);
  }

  private sse(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(`event: status\ndata: ${JSON.stringify(this.deps.status())}\n\n`);
    this.clients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* 断开由 close 处理 */
      }
    }, 20_000);
    ping.unref();
    req.on("close", () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  private readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error("请求体过大"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  /** 上传：body 是原始字节，文件名放在 query 里（省掉 multipart 解析）。 */
  private async upload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const raw = url.searchParams.get("name") ?? "upload.bin";
    const name = path.basename(raw).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").slice(0, 120) || "upload.bin";
    const buf = await this.readBody(req);
    if (buf.length === 0) return this.json(res, { ok: false, error: "空文件" });
    mkdirSync(this.deps.uploadDir, { recursive: true });
    const file = path.join(this.deps.uploadDir, `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${name}`);
    writeFileSync(file, buf);
    this.deps.log(`[gui] 收到上传：${name}（${Math.round(buf.length / 1024)}KB）`);
    return this.json(res, { ok: true, path: file, name });
  }

  private async send(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let input: ConversationInput;
    try { input = this.conversationInput(await this.readJson(req)); }
    catch (error) { return this.json(res, { ok: false, error: error instanceof Error ? error.message : "请求无效" }, 400); }
    if (this.deps.submitRequest) {
      const request = this.deps.submitRequest(input);
      return this.json(res, { ok: true, requestId: request.id, status: request.status }, 202);
    }
    this.json(res, { ok: true });
    this.deps.onMessage({ text: input.text, uploadPaths: input.uploadPaths ?? [] });
  }
}
