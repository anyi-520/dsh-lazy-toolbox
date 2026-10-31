import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { apply } from "../lib/index.js";
import { Store } from "../lib/store.js";
import { importSkillUnit } from "../lib/skills.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "fake-mcp-server.mjs");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 模拟 cordis 上下文：每个 ctx 有自己的 tools 表。 */
function makeCtx({ tools = new Map(), handlers = {}, sections = [], contexts = [], services = {} } = {}) {
  const globalTools = tools;
  const disposers = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(definition) {
        globalTools.set(definition.name, definition);
        return () => globalTools.delete(definition.name);
      },
    },
    systemPrompt: {
      getSectionOrder(name) {
        return name === "MCP_SERVERS" ? 3100 : 0;
      },
      section(section) {
        sections.push(section);
        return () => {};
      },
      context(entry) {
        contexts.push(entry);
        return () => {};
      },
    },
    on(event, fn) {
      (handlers[event] ??= []).push(fn);
      return () => {};
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === "function") disposers.push(disposer);
      return () => {};
    },
    get(name) {
      return services[name];
    },
    globalTools,
    handlers,
    sections,
    contexts,
    async dispose() {
      for (const disposer of disposers.splice(0)) await disposer();
    },
  };
  return ctx;
}

function makeAgent(id = "s1") {
  const scopeTools = new Map();
  const ctx = makeCtx({ tools: scopeTools });
  return {
    id,
    session: { id },
    ctx,
    scopeTools,
  };
}

test("apply 注册 toolbox 与目录 section", async () => {
  const dataDir = path.join(tempDir("lazy-plugin-"), "data");
  const ctx = makeCtx();
  apply(ctx, { dataDir, autoMigrate: false, autoImport: false });
  const tool = ctx.globalTools.get("toolbox");
  assert.equal(typeof tool?.execute, "function");
  assert.equal(ctx.sections.length, 1);
  assert.equal(ctx.sections[0].name, "toolbox:catalog");
  assert.equal(ctx.sections[0].text({ scope: undefined }), "", "空库时目录为空");
  assert.equal(ctx.contexts.length, 1);
  assert.equal(ctx.contexts[0].name, "toolbox:hint");
  assert.equal(ctx.contexts[0].text({ scope: undefined }), "", "空库时不提示");
  await ctx.dispose();
});

test("新会话的运行时上下文提示会提醒先 load，加载后自动消失", async () => {
  const home = tempDir("lazy-plugin-hint-");
  const dataDir = path.join(home, "data");
  const store = new Store(dataDir);
  const skillDir = path.join(home, "hint-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: hint-skill\ndescription: 提示用 skill\n---\n正文\n", "utf8");
  importSkillUnit({ store, unitPath: skillDir, kind: "dir", source: "manual" });

  const ctx = makeCtx();
  apply(ctx, { dataDir, autoMigrate: false, autoImport: false });
  const hint = ctx.contexts[0];
  const agent = makeAgent("session-hint");

  // 新会话：什么都没加载 → 有提示，且明确要求在工具列表缺失时先 load
  const before = hint.text({ scope: agent });
  assert.match(before, /不在工具定义里/);
  assert.match(before, /action: "load"/);
  assert.match(before, /1 个 skill/);

  // 换一个会话看：同样有提示（每个会话各自提醒）
  assert.match(hint.text({ scope: makeAgent("session-hint-2") }), /懒工具箱/);

  // 加载之后本会话不再提示，未加载的会话继续提示
  const toolbox = ctx.globalTools.get("toolbox");
  await toolbox.execute({ action: "load", ids: ["skill:hint-skill"] }, { agent, signal: new AbortController().signal });
  assert.equal(hint.text({ scope: agent }), "");
  assert.match(hint.text({ scope: makeAgent("session-hint-3") }), /懒工具箱/);

  // 认不出是哪个会话时按「未加载」处理，继续提醒（宁多提醒，不误判成已加载）
  assert.match(hint.text({ scope: agent.ctx }), /懒工具箱/);
  await ctx.dispose();
});

test("load 把 MCP 工具定义注入当前会话，unload 撤掉，其他会话不受影响", async () => {
  const home = tempDir("lazy-plugin-inject-");
  const dataDir = path.join(home, "data");
  const store = new Store(dataDir);

  const skillDir = path.join(home, "src-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: demo-skill\ndescription: 演示用 skill\n---\n执行步骤 A\n", "utf8");
  importSkillUnit({ store, unitPath: skillDir, kind: "dir", source: "manual" });

  store.putServer("demo", {
    summary: "测试用 MCP",
    transport: "stdio",
    command: process.execPath,
    args: [fixture],
    env: {},
  });

  const ctx = makeCtx();
  apply(ctx, { dataDir, autoMigrate: false, autoImport: false, mcpIdleMs: 0 });
  const toolbox = ctx.globalTools.get("toolbox");

  const agentA = makeAgent("session-a");
  const agentB = makeAgent("session-b");
  const exec = { agent: agentA, signal: new AbortController().signal };

  const loadText = (await toolbox.execute({ action: "load", ids: ["skill:demo-skill", "mcp:demo"] }, exec)).text;
  assert.match(loadText, /skill:demo-skill：OK/);
  assert.match(loadText, /mcp:demo：OK/);
  assert.ok(agentA.scopeTools.has("mcp__demo__echo"), "MCP 工具应注入到 agentA 作用域");
  assert.equal(agentB.scopeTools.size, 0, "不应影响其他会话");

  const section = ctx.sections[0];
  const catalogA = section.text({ scope: agentA });
  const catalogB = section.text({ scope: agentB });
  assert.match(catalogA, /skill:demo-skill/);
  assert.match(catalogA, /\[已加载\]/);
  assert.doesNotMatch(catalogB, /\[已加载\]/);

  const echo = agentA.scopeTools.get("mcp__demo__echo");
  const result = await echo.execute({ text: "hi" }, exec);
  assert.equal(result.text, "echo:hi");

  const unloadText = (await toolbox.execute({ action: "unload", all: true }, exec)).text;
  assert.match(unloadText, /已从本会话的工具定义里移除/);
  assert.equal(agentA.scopeTools.size, 0);
  await ctx.dispose();
});

test("回合结束自动卸载", async () => {
  const home = tempDir("lazy-plugin-turnend-");
  const dataDir = path.join(home, "data");
  const store = new Store(dataDir);
  store.putServer("demo", {
    summary: "测试用 MCP",
    transport: "stdio",
    command: process.execPath,
    args: [fixture],
  });
  const ctx = makeCtx();
  apply(ctx, { dataDir, autoMigrate: false, autoImport: false, mcpIdleMs: 0, autoUnloadOnTurnEnd: true });
  const toolbox = ctx.globalTools.get("toolbox");
  const agent = makeAgent("s-turn");
  const exec = { agent, signal: new AbortController().signal };
  await toolbox.execute({ action: "load", ids: ["mcp:demo"] }, exec);
  assert.ok(agent.scopeTools.size > 0);
  for (const handler of ctx.handlers["session/event"] ?? []) handler({ id: "s-turn" }, { type: "turn/end" });
  assert.equal(agent.scopeTools.size, 0);
  await ctx.dispose();
});

test("add_mcp 会连接验证并写回工具数", async () => {
  const home = tempDir("lazy-plugin-addmcp-");
  const dataDir = path.join(home, "data");
  const store = new Store(dataDir);
  const ctx = makeCtx();
  apply(ctx, { dataDir, autoMigrate: false, autoImport: false, mcpIdleMs: 0 });
  const toolbox = ctx.globalTools.get("toolbox");
  const agent = makeAgent("s-add");
  const exec = { agent, signal: new AbortController().signal };
  const text = (await toolbox.execute({
    action: "add_mcp",
    name: "fake",
    summary: "假 MCP 服务",
    command: process.execPath,
    args: [fixture],
  }, exec)).text;
  assert.match(text, /已接入 MCP 服务/);
  const server = new Store(dataDir).getServer("fake");
  assert.equal(server.toolCount, 2);
  assert.equal(server.summary, "假 MCP 服务");
  await ctx.dispose();
});

test("status 输出不泄漏调用参数与正文", async () => {
  const home = tempDir("lazy-plugin-status-");
  const dataDir = path.join(home, "data");
  const store = new Store(dataDir);
  const skillDir = path.join(home, "sk");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: quiet-skill\ndescription: 安静地做事\n---\n秘密正文\n", "utf8");
  importSkillUnit({ store, unitPath: skillDir, kind: "dir", source: "manual" });

  const ctx = makeCtx();
  apply(ctx, { dataDir, autoMigrate: false, autoImport: false });
  const toolbox = ctx.globalTools.get("toolbox");
  const agent = makeAgent("s-status");
  const exec = { agent, signal: new AbortController().signal };
  const text = (await toolbox.execute({ action: "status" }, exec)).text;
  assert.match(text, /skill:quiet-skill — 安静地做事/);
  assert.doesNotMatch(text, /秘密正文/);
  await ctx.dispose();
});

test("list 不带 ids 只给目录，不重复 status 的统计行", async () => {
  const home = tempDir("lazy-plugin-catalog-");
  const dataDir = path.join(home, "data");
  const store = new Store(dataDir);
  const skillDir = path.join(home, "sk");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: lister\ndescription: 列目录用\n---\n正文\n", "utf8");
  importSkillUnit({ store, unitPath: skillDir, kind: "dir", source: "manual" });

  const ctx = makeCtx();
  apply(ctx, { dataDir, autoMigrate: false, autoImport: false });
  const toolbox = ctx.globalTools.get("toolbox");
  const agent = makeAgent("s-catalog");
  const exec = { agent, signal: new AbortController().signal };
  const text = (await toolbox.execute({ action: "list" }, exec)).text;
  assert.match(text, /^# 目录/);
  assert.match(text, /skill:lister — 列目录用/);
  assert.doesNotMatch(text, /数据目录：/);
  await ctx.dispose();
});

test("写操作失败时返回可读结果而不是抛出", async () => {
  const dataDir = path.join(tempDir("lazy-plugin-guard-"), "data");
  const ctx = makeCtx();
  apply(ctx, { dataDir, autoMigrate: false, autoImport: false });
  const toolbox = ctx.globalTools.get("toolbox");
  const agent = makeAgent("s-guard");
  const exec = { agent, signal: new AbortController().signal };
  const text = (await toolbox.execute({ action: "add_skill", path: "D:/definitely/not/here" }, exec)).text;
  assert.match(text, /^# add_skill 失败/);
  assert.match(text, /路径不存在/);
  await ctx.dispose();
});
