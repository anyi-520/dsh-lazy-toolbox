# 示例：一个最小 MCP 服务

`fake-mcp-server.mjs` 是测试用的 stdio MCP 服务（`initialize` / `ping` / `tools/list` / `tools/call`），
暴露 `echo` 与 `sum` 两个工具。可以直接拿它验证插件链路：

```bash
# 1) 登记并验证
dsh-lazy-toolbox add-mcp demo --command node \
  --args "D:/path/to/dsh-lazy-toolbox/test/fixtures/fake-mcp-server.mjs" --verify

# 2) 看目录
dsh-lazy-toolbox status
dsh-lazy-toolbox list

# 3) 在对话里：toolbox { action: "load", ids: ["mcp:demo"] }
#    之后就能调用 mcp__demo__echo / mcp__demo__sum
```

等价于 `toolbox` 工具的：

```jsonc
{ "action": "add_mcp", "name": "demo", "summary": "演示用回声与求和",
  "command": "node", "args": ["D:/path/to/test/fixtures/fake-mcp-server.mjs"] }
```

## 自己写一个

stdin 逐行读 JSON-RPC，stdout 逐行写回即可：

```js
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});
```

`initialize` 回 `protocolVersion: "2025-06-18"` 与 `capabilities.tools`，然后处理 `tools/list` 与 `tools/call`。
