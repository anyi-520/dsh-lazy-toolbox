/**
 * MCP 服务管理：按需连接、列出工具、把工具改写成 DSH 可注册的工具定义、懒关闭。
 *
 * 工具命名沿用 DSH 的约定 `mcp__<server>__<rawName>`，所以迁移前后的名字完全一致，
 * 模型不需要重新学习。
 */
import { createHash } from "node:crypto";
import { McpConnection, renderMcpContent } from "./mcp-client.js";
import { sanitizeSchema } from "./schema.js";
import { errorMessage, oneLine } from "./util.js";

const MAX_PUBLIC_NAME = 64;
const INVALID = /[^A-Za-z0-9_-]/g;

export { sanitizeSchema };

/** DSH 风格的 MCP 公开工具名。 */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID, "_");
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME) return normalized;
  const hash = createHash("sha256").update(`${serverName}\0${rawName}`).digest("hex").slice(0, 12);
  return `${normalized.slice(0, MAX_PUBLIC_NAME - 13)}_${hash}`;
}

/** 一句话描述：优先 description 的第一句，退化到标题/工具名。 */
export function toolSummary(tool) {
  return oneLine(tool.description || tool.title || tool.name, 80) || tool.name;
}

export class McpManager {
  constructor({ store, logger, idleMs = 60000, log = null }) {
    this.store = store;
    this.logger = logger;
    this.log = log;
    this.idleMs = idleMs;
    this.connections = new Map();
    this.refs = new Map();
    this.idleTimers = new Map();
  }

  serverConfig(name) {
    const entry = this.store.getServer(name);
    if (!entry) throw new Error(`MCP 服务 "${name}" 不在懒工具箱里`);
    return entry;
  }

  async connection(name, signal) {
    const existing = this.connections.get(name);
    if (existing) return existing;
    const config = this.serverConfig(name);
    const connection = new McpConnection({
      transport: config.transport === "streamable-http" ? "streamable-http" : "stdio",
      command: config.command ?? "",
      args: Array.isArray(config.args) ? config.args : [],
      env: config.env ?? {},
      cwd: config.cwd ?? "",
      url: config.url ?? "",
      headers: config.headers ?? {},
      toolCallTimeoutMs: config.toolCallTimeoutMs,
    });
    const pending = connection.connect(signal).then(
      () => connection,
      async (error) => {
        this.connections.delete(name);
        await connection.close().catch(() => {});
        throw new Error(`连接 MCP 服务 "${name}" 失败：${errorMessage(error)}`);
      },
    );
    this.connections.set(name, pending);
    try {
      const connected = await pending;
      this.log?.info?.("mcp.connect", {
        server: name,
        transport: config.transport === "streamable-http" ? "streamable-http" : "stdio",
        command: config.command || config.url || "",
      });
      return connected;
    } catch (error) {
      this.connections.delete(name);
      this.log?.error?.("mcp.connect", { server: name, ok: false, error });
      throw error;
    }
  }

  async listTools(name, signal) {
    const connection = await this.connection(name, signal);
    const tools = await connection.refreshTools(signal);
    return tools;
  }

  retain(name) {
    this.refs.set(name, (this.refs.get(name) ?? 0) + 1);
    const timer = this.idleTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(name);
    }
  }

  release(name) {
    const next = (this.refs.get(name) ?? 1) - 1;
    if (next > 0) {
      this.refs.set(name, next);
      return;
    }
    this.refs.delete(name);
    if (this.idleMs <= 0) {
      void this.closeServer(name);
      return;
    }
    const timer = setTimeout(() => {
      this.idleTimers.delete(name);
      void this.closeServer(name);
    }, this.idleMs);
    if (typeof timer.unref === "function") timer.unref();
    this.idleTimers.set(name, timer);
  }

  async callTool(name, rawName, args, exec) {
    const connection = await this.connection(name, exec?.signal);
    const result = await connection.callTool(rawName, args, exec?.signal);
    const text = renderMcpContent(result.content);
    if (result.isError) throw new Error(text);
    return { text, structuredContent: result.structuredContent };
  }

  async closeServer(name) {
    const pending = this.connections.get(name);
    this.connections.delete(name);
    this.refs.delete(name);
    const timer = this.idleTimers.get(name);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(name);
    if (!pending) return;
    try {
      const connection = await pending;
      await connection.close();
      this.log?.info?.("mcp.close", { server: name });
    } catch {
      /* ignore */
    }
  }

  async closeAll() {
    for (const name of [...this.connections.keys()]) await this.closeServer(name);
  }
}

/** 把一个 MCP 工具包装成 DSH ToolRuntime 定义。 */
export function buildMcpToolDefinition({ manager, serverName, tool }) {
  const publicName = publicToolName(serverName, tool.name);
  const summary = toolSummary(tool);
  return {
    name: publicName,
    description: tool.description || `${serverName} · ${tool.name}`,
    parameters: sanitizeSchema(tool.inputSchema),
    output: {
      schema: {
        type: "object",
        properties: {
          text: { type: "string", description: "工具返回的文本内容" },
        },
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: "text", text: String(value?.text ?? "") }];
      },
    },
    async execute(args, exec) {
      const result = await manager.callTool(serverName, tool.name, args, exec);
      return { text: result.text };
    },
  };
}
