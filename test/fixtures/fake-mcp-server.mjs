// 一个最小的 MCP stdio 服务，用于测试 JSON-RPC 客户端。
// 支持 initialize / tools/list / tools/call / ping。
let buffer = "";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const TOOLS = [
  {
    name: "echo",
    title: "Echo",
    description: "回显输入文本。测试用。",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "要回显的文本" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "sum",
    description: "把两个数字相加。",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
];

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.method === undefined) continue;
    if (message.id === undefined) continue; // 通知
    switch (message.method) {
      case "initialize":
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-mcp", version: "1.0.0" },
          },
        });
        break;
      case "ping":
        send({ jsonrpc: "2.0", id: message.id, result: {} });
        break;
      case "tools/list":
        send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
        break;
      case "tools/call": {
        const name = message.params?.name;
        const args = message.params?.arguments ?? {};
        if (name === "echo") {
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: `echo:${args.text ?? ""}` }] },
          });
        } else if (name === "sum") {
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }] },
          });
        } else {
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `unknown tool ${name}` } });
        }
        break;
      }
      default:
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${message.method}` } });
    }
  }
});
