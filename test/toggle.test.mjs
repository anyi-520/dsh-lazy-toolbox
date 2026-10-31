import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { apply } from "../lib/index.js";
import { Store } from "../lib/store.js";
import { importSkillUnit } from "../lib/skills.js";
import { inventoryForUi, setEnabledById } from "../lib/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "fake-mcp-server.mjs");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 模拟 cordis 上下文：能注册工具、收 HTTP 路由。 */
function makeCtx({ routes = [] } = {}) {
  const tools = new Map();
  const sections = [];
  const contexts = [];
  const disposers = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
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
    webServer: {
      register(route) {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
    on() {
      return () => {};
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === "function") disposers.push(disposer);
      return () => {};
    },
    get() {
      return undefined;
    },
    globalTools: tools,
    sections,
    contexts,
    async dispose() {
      for (const disposer of disposers.splice(0)) await disposer();
    },
  };
  return ctx;
}

/** 造一个假响应，收集 status / headers / body。 */
function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    end(chunk) {
      this.body = chunk ?? "";
    },
  };
}

/** 用内存里的 JSON 体模拟 POST 请求（够 readJsonBody 的 for await 用）。 */
function makeRequest({ method = "GET", body } = {}) {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
  return {
    method,
    async *[Symbol.asyncIterator]() {
      if (payload.length > 0) yield payload;
    },
  };
}

function seed(home) {
  const store = new Store(path.join(home, "data"));
  const skillDir = path.join(home, "toggle-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: toggle-skill\ndescription: 开关测试用 skill\n---\n步骤\n",
    "utf8",
  );
  importSkillUnit({ store, unitPath: skillDir, kind: "dir", source: "manual" });
  store.putServer("demo", {
    summary: "开关测试用 MCP",
    transport: "stdio",
    command: process.execPath,
    args: [fixture],
    env: {},
    toolCount: 1,
  });
  return store;
}

test("store 记住开关状态，重开也还在", () => {
  const home = tempDir("lazy-toggle-store-");
  const dataDir = path.join(home, "data");
  const store = seed(home);

  assert.equal(store.isDisabled("skill", "toggle-skill"), false);
  assert.equal(store.setDisabled("skill", "toggle-skill", true), true);
  assert.equal(store.isDisabled("skill", "toggle-skill"), true);
  assert.equal(store.setDisabled("skill", "toggle-skill", true), false, "重复关不算变化");

  const reopened = new Store(dataDir);
  assert.deepEqual(reopened.listDisabled(), { skills: ["toggle-skill"], mcp: [] });

  // 删掉条目时顺手清掉它的开关记录，别留孤儿
  reopened.dropSkill("toggle-skill");
  assert.deepEqual(reopened.listDisabled().skills, []);
});

test("关掉的条目不出现在目录与提示里，也不能 load", async () => {
  const home = tempDir("lazy-toggle-catalog-");
  const dataDir = path.join(home, "data");
  const store = seed(home);
  store.setDisabled("skill", "toggle-skill", true);

  const ctx = makeCtx();
  apply(ctx, { dataDir, autoMigrate: false, autoImport: false, mcpIdleMs: 0 });

  const catalog = ctx.sections[0].text({ scope: { id: "s1", ctx: makeCtx() } });
  assert.doesNotMatch(catalog, /skill:toggle-skill/);
  assert.match(catalog, /mcp:demo/, "没关的那一项照旧在目录里");

  // 提示只算启用中的条目
  const hint = ctx.contexts[0].text({ scope: makeCtx() });
  assert.match(hint, /0 个 skill/);
  assert.match(hint, /1 个 MCP 服务/);

  const toolbox = ctx.globalTools.get("toolbox");
  const agent = { id: "s1", session: { id: "s1" }, ctx: makeCtx() };
  const loadText = (await toolbox.execute({ action: "load", ids: ["skill:toggle-skill"] }, { agent })).text;
  assert.match(loadText, /失败/);
  assert.match(loadText, /关闭状态/);

  // 打开之后立刻恢复
  const enableText = (await toolbox.execute({ action: "enable", ids: ["skill:toggle-skill"] }, { agent })).text;
  assert.match(enableText, /已打开/);
  const afterEnable = ctx.sections[0].text({ scope: agent });
  assert.match(afterEnable, /skill:toggle-skill/);

  await ctx.dispose();
});

test("设置页端点：GET 给清单，POST toggle 改开关", async () => {
  const home = tempDir("lazy-toggle-api-");
  const dataDir = path.join(home, "data");
  seed(home);

  const routes = [];
  const ctx = makeCtx({ routes });
  apply(ctx, { dataDir, autoMigrate: false, autoImport: false, mcpIdleMs: 0 });

  const route = routes.find((item) => item.path === "/dsh-lazy-toolbox/api");
  assert.ok(route, "应注册设置页端点");

  const getResponse = makeResponse();
  await route.handler(makeRequest({ method: "GET" }), getResponse);
  assert.equal(getResponse.statusCode, 200);
  const initial = JSON.parse(getResponse.body);
  assert.equal(initial.inventory.skills.length, 1);
  assert.equal(initial.inventory.mcp.length, 1);
  assert.equal(initial.inventory.skills[0].enabled, true);
  assert.equal(initial.inventory.counts.skillsOn, 1);

  const offResponse = makeResponse();
  await route.handler(
    makeRequest({ method: "POST", body: { op: "toggle", id: "skill:toggle-skill", enabled: false } }),
    offResponse,
  );
  assert.equal(offResponse.statusCode, 200);
  const afterOff = JSON.parse(offResponse.body);
  assert.equal(afterOff.inventory.skills[0].enabled, false);
  assert.equal(afterOff.inventory.counts.skillsOn, 0);

  const reopened = new Store(dataDir);
  assert.deepEqual(reopened.listDisabled().skills, ["toggle-skill"], "开关要落盘");

  const onResponse = makeResponse();
  await route.handler(
    makeRequest({ method: "POST", body: { op: "toggle", id: "skill:toggle-skill", enabled: true } }),
    onResponse,
  );
  assert.equal(JSON.parse(onResponse.body).inventory.skills[0].enabled, true);

  const badResponse = makeResponse();
  await route.handler(makeRequest({ method: "POST", body: { op: "toggle", id: "skill:不存在" } }), badResponse);
  assert.equal(badResponse.statusCode, 500);
  assert.match(JSON.parse(badResponse.body).error, /不存在/);

  await ctx.dispose();
});

test("inventoryForUi / setEnabledById 直接调用也一致", () => {
  const home = tempDir("lazy-toggle-inventory-");
  const store = seed(home);
  const runtime = { store, mcp: { closeServer() {} } };

  const before = inventoryForUi(runtime);
  assert.deepEqual(
    before.skills.map((item) => item.id),
    ["skill:toggle-skill"],
  );
  assert.equal(before.mcp[0].toolCount, 1);

  const after = setEnabledById(runtime, "mcp:demo", false);
  assert.equal(after.mcp[0].enabled, false);
  assert.equal(after.counts.mcpOn, 0);

  assert.throws(() => setEnabledById(runtime, "mcp:不存在", false), /不存在/);
  assert.throws(() => setEnabledById(runtime, "mcp:demo:echo", false), /只支持/);
});
