/**
 * 一个极小的 MCP 客户端（JSON-RPC 2.0）。
 *
 * 支持两种传输：
 *   - stdio：换行分隔的 JSON-RPC，spawn 子进程
 *   - streamable-http：POST + SSE/JSON 响应
 *
 * 只实现懒工具箱需要的 request 流程：initialize / tools/list / tools/call，
 * 另有 ping 用于探活。故意不依赖 @modelcontextprotocol/sdk，装插件不需要额外依赖。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { errorMessage } from "./util.js";

const DEFAULT_TIMEOUT_MS = 120000;
const PROTOCOL_VERSION = "2025-06-18";

function withTimeout(promise, timeoutMs, label, signal) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  const abort = new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(new Error(`${label} aborted`));
    else signal.addEventListener("abort", () => reject(new Error(`${label} aborted`)), { once: true });
  });
  return Promise.race([promise, timeout, abort]).finally(() => clearTimeout(timer));
}

// ------------------------------------------------------------------ stdio

function scanPath(command, envPath) {
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  const dirs = String(envPath || "").split(path.delimiter).filter(Boolean);
  const candidates = path.extname(command) ? [command] : [command, ...exts.map((ext) => `${command}${ext.toLowerCase()}`)];
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* keep looking */
      }
    }
  }
  return "";
}

function quoteCmdArg(value) {
  const text = String(value);
  if (text.length === 0) return "\"\"";
  if (!/[\s"&|<>^()%!]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

class StdioTransport {
  constructor(config) {
    this.config = config;
    this.child = undefined;
    this.buffer = "";
    this.stderr = "";
    this.handlers = new Set();
    this.closed = false;
  }

  async start() {
    const config = this.config;
    const env = { ...process.env, ...(config.env ?? {}) };
    const args = Array.isArray(config.args) ? config.args.map(String) : [];
    const cwd = config.cwd ? path.resolve(config.cwd) : process.cwd();
    const resolved = scanPath(config.command, env.PATH || env.Path || process.env.PATH || "");
    let command = resolved || config.command;
    let spawnArgs = args;
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
      const line = [quoteCmdArg(command), ...args.map(quoteCmdArg)].join(" ");
      spawnArgs = ["/d", "/s", "/c", line];
      command = process.env.ComSpec || "cmd.exe";
    }
    this.child = spawn(command, spawnArgs, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      if (!this.closed) this.fail(new Error(`MCP server exited (code=${code ?? "?"}, signal=${signal ?? "?"}) ${this.stderrTail()}`));
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
  }

  stderrTail() {
    const text = this.stderr.trim();
    return text ? `stderr: ${text.slice(-600)}` : "";
  }

  consume(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // 不是协议帧（有些服务会往 stdout 打日志），忽略
        continue;
      }
      for (const handler of this.handlers) handler(message);
    }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.handlers) handler({ __transportError: errorMessage(error) });
  }

  onMessage(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send(message) {
    if (!this.child || this.closed) throw new Error("MCP stdio transport is not connected");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close() {
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve();
      }, 1500);
      if (typeof timer.unref === "function") timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    });
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      try {
        stream?.destroy();
      } catch {
        /* ignore */
      }
    }
  }
}

// -------------------------------------------------------------------- http

class HttpTransport {
  constructor(config) {
    this.config = config;
    this.sessionId = "";
    this.handlers = new Set();
  }

  onMessage(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  headers() {
    const base = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.config.headers ?? {}),
    };
    if (this.sessionId) base["mcp-session-id"] = this.sessionId;
    return base;
  }

  async post(message, signal) {
    const response = await fetch(this.config.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(message),
      signal,
    });
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    if (!response.ok && response.status !== 202) {
      throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 400)}`);
    }
    const frames = [];
    if (contentType.includes("text/event-stream")) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data) continue;
        try {
          frames.push(JSON.parse(data));
        } catch {
          /* skip malformed frame */
        }
      }
    } else if (text.trim()) {
      try {
        frames.push(JSON.parse(text));
      } catch {
        throw new Error(`MCP HTTP returned non-JSON body: ${text.slice(0, 200)}`);
      }
    }
    return frames;
  }

  send() {
    throw new Error("MCP HTTP transport is request/response only");
  }

  async close() {
    if (!this.sessionId) return;
    try {
      await fetch(this.config.url, { method: "DELETE", headers: this.headers() });
    } catch {
      /* ignore */
    }
    this.sessionId = "";
  }
}

// --------------------------------------------------------------- connection

export class McpConnection {
  constructor(config) {
    this.config = config;
    this.timeoutMs = Number(config.toolCallTimeoutMs) > 0 ? Number(config.toolCallTimeoutMs) : DEFAULT_TIMEOUT_MS;
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.serverInfo = {};
    this.capabilities = {};
    this.transport = config.transport === "streamable-http" ? new HttpTransport(config) : new StdioTransport(config);
    this.unsubscribe = this.transport.onMessage((message) => this.onMessage(message));
    this.closed = false;
  }

  onMessage(message) {
    if (message && message.__transportError) {
      this.rejectAll(new Error(message.__transportError));
      return;
    }
    if (message && typeof message.id === "number" && Object.hasOwn(message, "method")) {
      // 服务端发起的请求（sampling / roots / elicitation）：明确拒绝，别让服务端挂住
      try {
        this.transport.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `method ${message.method} is not supported by dsh-lazy-toolbox` },
        });
      } catch {
        /* ignore */
      }
      return;
    }
    if (!message || message.id === undefined) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message || "MCP request failed"));
    else entry.resolve(message.result);
  }

  rejectAll(error) {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  request(method, params, signal) {
    if (this.closed) return Promise.reject(new Error("MCP connection is closed"));
    const id = this.nextId;
    this.nextId += 1;
    const message = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    const run = async () => {
      if (this.transport instanceof HttpTransport) {
        const frames = await this.transport.post(message, signal);
        for (const frame of frames) this.onMessage(frame);
        const settled = this.pending.has(id);
        return { settled };
      }
      this.transport.send(message);
      return { settled: false };
    };
    return withTimeout(
      run().then(() => promise),
      this.timeoutMs,
      `MCP ${method}`,
      signal,
    ).catch((error) => {
      this.pending.delete(id);
      throw error;
    });
  }

  notify(method, params, signal) {
    const message = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
    if (this.transport instanceof HttpTransport) return this.transport.post(message, signal).then(() => undefined);
    this.transport.send(message);
    return Promise.resolve();
  }

  async connect(signal) {
    if (!(this.transport instanceof HttpTransport)) await this.transport.start();
    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "dsh-lazy-toolbox", version: "0.1.0" },
    }, signal);
    this.serverInfo = result?.serverInfo ?? {};
    this.capabilities = result?.capabilities ?? {};
    await this.notify("notifications/initialized", undefined, signal);
    await this.refreshTools(signal);
    return this;
  }

  async refreshTools(signal) {
    if (this.capabilities.tools === undefined && this.serverInfo === undefined) {
      this.tools = [];
      return this.tools;
    }
    const result = await this.request("tools/list", {}, signal);
    const list = Array.isArray(result?.tools) ? result.tools : [];
    this.tools = list.map((tool) => ({
      name: String(tool.name ?? ""),
      title: typeof tool.title === "string" ? tool.title : "",
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    }));
    return this.tools;
  }

  async callTool(rawName, args, signal) {
    const result = await this.request("tools/call", {
      name: rawName,
      arguments: args && typeof args === "object" ? args : {},
    }, signal);
    return {
      content: Array.isArray(result?.content) ? result.content : [],
      structuredContent: result?.structuredContent,
      isError: result?.isError === true,
    };
  }

  async ping(signal) {
    return this.request("ping", {}, signal);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error("MCP connection closed"));
    this.unsubscribe?.();
    await this.transport.close();
  }
}

/** 把 MCP 结果里的 content 数组压成模型可读文本。 */
export function renderMcpContent(content) {
  const parts = [];
  for (const block of content ?? []) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") parts.push(block.text);
        break;
      case "image":
        parts.push(`[图片结果：${block.mimeType ?? "未知类型"}；懒工具箱不解析图片内容]`);
        break;
      case "audio":
        parts.push(`[音频结果：${block.mimeType ?? "未知类型"}]`);
        break;
      case "resource_link":
        parts.push(`资源：${block.name ?? "?"} (${block.uri ?? "?"})`);
        break;
      case "resource":
        parts.push(`[内嵌资源：${block.resource?.uri ?? "?"}]`);
        break;
      default:
        parts.push(`[不支持的 MCP 内容块：${block.type ?? "unknown"}]`);
    }
  }
  return parts.length > 0 ? parts.join("\n") : "（该工具没有返回可展示内容）";
}
