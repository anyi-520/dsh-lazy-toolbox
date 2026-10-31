import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { McpConnection, renderMcpContent } from "../lib/mcp-client.js";
import { buildMcpToolDefinition, publicToolName, sanitizeSchema } from "../lib/mcp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "fake-mcp-server.mjs");

function newConnection() {
  return new McpConnection({
    transport: "stdio",
    command: process.execPath,
    args: [fixture],
    env: {},
    cwd: here,
    toolCallTimeoutMs: 10000,
  });
}

test("stdio 连接、列工具、调工具", async () => {
  const connection = newConnection();
  try {
    await connection.connect();
    assert.equal(connection.serverInfo.name, "fake-mcp");
    const tools = connection.tools;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["echo", "sum"]);
    const result = await connection.callTool("echo", { text: "你好" });
    assert.equal(renderMcpContent(result.content), "echo:你好");
    const sum = await connection.callTool("sum", { a: 2, b: 3 });
    assert.equal(renderMcpContent(sum.content), "5");
    await assert.rejects(() => connection.callTool("nope", {}), /unknown tool/);
  } finally {
    await connection.close();
  }
});

test("工具名与 schema 规范化", () => {
  assert.equal(publicToolName("github", "search_repos"), "mcp__github__search_repos");
  const long = publicToolName("server", "x".repeat(80));
  assert.ok(long.length <= 64);

  const sanitized = sanitizeSchema({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      q: { type: "string", description: "query", default: "x", examples: ["a"] },
      nested: { $ref: "#/definitions/x" },
    },
    required: ["q"],
    additionalProperties: true,
  });
  assert.equal(sanitized.$schema, undefined);
  assert.deepEqual(sanitized.properties.q, { type: "string", description: "query", default: "x", examples: ["a"] });
  assert.deepEqual(sanitized.properties.nested, {});
  assert.deepEqual(sanitized.required, ["q"]);
  assert.equal(sanitized.additionalProperties, true);
});

test("工具定义形状符合 DSH ToolRuntime 契约", () => {
  const definition = buildMcpToolDefinition({
    manager: { callTool: async () => ({ text: "ok" }) },
    serverName: "demo",
    tool: {
      name: "echo",
      description: "回显",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  });
  assert.equal(definition.name, "mcp__demo__echo");
  assert.equal(typeof definition.execute, "function");
  assert.equal(typeof definition.output.render, "function");
  assert.equal(definition.parameters.type, "object");
});
