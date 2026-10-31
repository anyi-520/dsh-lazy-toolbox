import assert from "node:assert/strict";
import test from "node:test";
import {
  findMcpEntries,
  insertEntries,
  parseYamlSubset,
  removeEntries,
  splitTopLevelEntries,
} from "../lib/profile.js";
import { oneLine, parseFrontmatter } from "../lib/util.js";

const SAMPLE = `# 顶层注释
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: xc
    model: deepseek-v4.1-flash

- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: stdio
    serverName: github
    command: npx
    args:
      - "-y"
      - "@modelcontextprotocol/server-github"
    env:
      GITHUB_TOKEN: ghp_xxx
    toolCallTimeoutMs: 60000

- id: mcp-remote
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: streamable-http
    serverName: remote
    url: https://example.com/mcp
    headers:
      Authorization: Bearer abc
`;

test("splitTopLevelEntries 只认顶格数组项", () => {
  const { entries } = splitTopLevelEntries(SAMPLE);
  assert.equal(entries.length, 3);
  assert.ok(entries[0].text.startsWith("- id: agent-default-model"));
});

test("findMcpEntries 提取两种传输的配置", () => {
  const found = findMcpEntries(SAMPLE);
  assert.equal(found.length, 2);
  const github = found.find((entry) => entry.id === "mcp-github");
  assert.equal(github.config.serverName, "github");
  assert.equal(github.config.command, "npx");
  assert.deepEqual(github.config.args, ["-y", "@modelcontextprotocol/server-github"]);
  assert.equal(github.config.env.GITHUB_TOKEN, "ghp_xxx");
  const remote = found.find((entry) => entry.id === "mcp-remote");
  assert.equal(remote.config.transport, "streamable-http");
  assert.equal(remote.config.url, "https://example.com/mcp");
  assert.equal(remote.config.headers.Authorization, "Bearer abc");
});

test("removeEntries + insertEntries 可往返", () => {
  const found = findMcpEntries(SAMPLE);
  const removed = removeEntries(SAMPLE, found);
  assert.ok(!removed.includes("dsh-mcp-client"));
  const records = found.map((entry) => ({ text: entry.text, index: entry.start }));
  const restored = insertEntries(removed, records);
  assert.equal(findMcpEntries(restored).length, 2);
  assert.equal(restored.trim(), SAMPLE.trim());
});

test("parseYamlSubset 处理标量 / 列表 / 映射", () => {
  const parsed = parseYamlSubset([
    "  transport: stdio",
    "  serverName: demo",
    "  args:",
    "    - one",
    "    - two",
    "  env:",
    "    A: 1",
    "  flow: [x, y]",
  ]);
  assert.equal(parsed.transport, "stdio");
  assert.deepEqual(parsed.args, ["one", "two"]);
  assert.deepEqual(parsed.env, { A: "1" });
  assert.deepEqual(parsed.flow, ["x", "y"]);
});

test("parseFrontmatter 处理普通与折叠描述", () => {
  const plain = parseFrontmatter("---\nname: demo\ndescription: 做一件事\n---\n正文\n");
  assert.equal(plain.data.name, "demo");
  assert.equal(plain.data.description, "做一件事");
  assert.equal(plain.body, "正文");
  const folded = parseFrontmatter("---\nname: demo\ndescription: >\n  第一行\n  第二行\n---\nbody");
  assert.equal(folded.data.description, "第一行 第二行");
});

test("oneLine 取第一句并截断", () => {
  assert.equal(oneLine("做一件事。顺便还有第二句"), "做一件事");
  assert.ok(oneLine("x".repeat(200), 20).length <= 20);

  const source = "Reverse engineer native, managed, Electron/JavaScript, packaged, firmware, and browser targets with REA, and build agent environments from a live instance or a capture.";
  for (const max of [60, 96]) {
    const out = oneLine(source, max);
    assert.ok(out.length <= max, `${out} 超过 ${max}`);
    assert.ok(out.endsWith("…"), out);
    assert.doesNotMatch(out, /\s…$/, `截断后不应留下悬空空格：${out}`);
    const last = out.slice(0, -1).split(" ").pop();
    assert.ok(source.includes(`${last} `) || source.startsWith(`${last} `), `最后一段应是完整单词："${last}"`);
  }

  const chinese = oneLine("把本机安装的 skill 与 MCP 服务整体搬进插件库并按需加载，用完再卸载。", 20);
  assert.ok(chinese.length <= 20, chinese);
  assert.ok(chinese.endsWith("…"), chinese);
});
