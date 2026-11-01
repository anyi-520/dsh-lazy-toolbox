/**
 * 插件工具托管（lib/tool-groups.js + injector 的 group: 分支）。
 * 模拟「别的插件把 17 个工具交出来」，验证：目录里只留一行、load 才注册、unload 撤掉、
 * 设置里「跳过」就拒绝加载。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  BRIDGE_KEY,
  provideToolGroup,
  removeToolGroup,
  listToolGroups,
  getToolGroup,
  pickGroupTools,
  clearToolGroups,
  onToolGroupsChange,
} = await import("../lib/tool-groups.js");
const { Injector, catalogGroupLines, parseItemId } = await import("../lib/inject.js");
const { Store } = await import("../lib/store.js");
const { inventoryForUi, setEnabledById } = await import("../lib/tools.js");

function fakeTools(count = 3, prefix = "mem_") {
  return Array.from({ length: count }, (_, index) => ({
    name: `${prefix}tool_${index}`,
    description: `第 ${index} 个假工具`,
    parameters: { type: "object", additionalProperties: false, properties: { q: { type: "string" } } },
    execute: async (args) => ({ text: `called ${prefix}tool_${index} ${JSON.stringify(args)}` }),
  }));
}

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lt-group-"));
  return new Store(path.join(dir, "store.json"));
}

function fakeAgent() {
  const registered = [];
  return {
    session: { id: "s1" },
    ctx: {
      tools: {
        register(definition) {
          registered.push(definition);
          return () => {
            const index = registered.indexOf(definition);
            if (index >= 0) registered.splice(index, 1);
          };
        },
      },
    },
    registered,
  };
}

test.beforeEach(() => {
  clearToolGroups();
});

test("托管一组工具：目录里只有一条，工具清单可查", () => {
  const dispose = provideToolGroup({
    id: "memstudio",
    summary: "内存工作台：附加进程 / 读写搜 / 断点",
    plugin: "dsh-memstudio",
    tools: fakeTools(3),
  });
  const groups = listToolGroups();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, "memstudio");
  assert.equal(groups[0].toolCount, 3);
  assert.deepEqual(groups[0].toolNames, ["mem_tool_0", "mem_tool_1", "mem_tool_2"]);
  assert.equal(groups[0].plugin, "dsh-memstudio");

  // 目录行：一条用途 + 工具名，不给 schema
  const lines = catalogGroupLines({ store: tempStore(), agent: null, injector: { loaded: () => [] } });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\- group:memstudio — 内存工作台/);
  assert.match(lines[0], /3 个工具/);
  assert.match(lines[0], /dsh-memstudio/);

  dispose();
  assert.equal(listToolGroups().length, 0);
});

test("工具定义自动补 output；没有工具的组不接受", () => {
  provideToolGroup({ id: "bare", summary: "没写 output", tools: [{ name: "x", description: "d", execute: async () => ({ text: "" }) }] });
  const group = getToolGroup("bare");
  assert.equal(typeof group.tools[0].output.render, "function");
  assert.deepEqual(group.tools[0].output.render(null, { text: "hi" }), [{ type: "text", text: "hi" }]);
  assert.throws(() => provideToolGroup({ id: "empty", tools: [] }), /没有工具/);
  assert.throws(() => provideToolGroup({ summary: "无 id" }), /需要 id/);
});

test("挑工具：全给 / 按名字挑", () => {
  provideToolGroup({ id: "mem", tools: fakeTools(4) });
  assert.equal(pickGroupTools("mem").length, 4);
  assert.deepEqual(pickGroupTools("mem", ["mem_tool_2"]).map((t) => t.name), ["mem_tool_2"]);
  assert.equal(pickGroupTools("nope"), null);
});

test("全局桥：Symbol.for 那把钥匙上挂着一套 API", () => {
  const bridge = globalThis[BRIDGE_KEY];
  assert.ok(bridge, "应挂到 globalThis");
  assert.equal(bridge.version, 1);
  for (const key of ["provideToolGroup", "removeToolGroup", "listToolGroups", "getToolGroup", "pickGroupTools"]) {
    assert.equal(typeof bridge[key], "function", `缺 ${key}`);
  }
  bridge.provideToolGroup({ id: "viaBridge", summary: "从桥进来", tools: fakeTools(1) });
  assert.ok(getToolGroup("viaBridge"));
  bridge.removeToolGroup("viaBridge");
});

test("变化通知：provide / remove 都会叫醒监听者", () => {
  let hits = 0;
  const off = onToolGroupsChange(() => {
    hits += 1;
  });
  provideToolGroup({ id: "a", tools: fakeTools(1) });
  removeToolGroup("a");
  off();
  provideToolGroup({ id: "b", tools: fakeTools(1) });
  assert.equal(hits, 2);
});

test("id 解析：group:<组> 与 group:<组>:<工具>", () => {
  assert.deepEqual(parseItemId("group:memstudio"), { kind: "group", name: "memstudio" });
  assert.deepEqual(parseItemId("group:memstudio:mem_read"), { kind: "group-tool", group: "memstudio", tool: "mem_read" });
});

test("load group: 才注册工具；unload 撤掉；没加载前一个都没有", async () => {
  provideToolGroup({ id: "memstudio", summary: "内存工作台", plugin: "dsh-memstudio", tools: fakeTools(3) });
  const store = tempStore();
  const injector = new Injector({ store, mcp: null, logger: { warn() {} } });
  const agent = fakeAgent();

  assert.equal(agent.registered.length, 0, "托管不等于常驻");

  const report = await injector.load(agent, ["group:memstudio"]);
  assert.equal(report[0].ok, true);
  assert.equal(agent.registered.length, 3);
  assert.match(report[0].message, /已注入 3 个插件工具/);
  assert.deepEqual(agent.registered.map((d) => d.name), ["mem_tool_0", "mem_tool_1", "mem_tool_2"]);
  assert.equal(agent.registered[0].parameters.properties.q.type, "string", "参数 schema 要原样带过来");

  const result = await agent.registered[0].execute({ q: "hi" });
  assert.match(result.text, /called mem_tool_0/);

  injector.unload(agent, ["group:memstudio"]);
  assert.equal(agent.registered.length, 0);
});

test("load group:<组>:<工具> 只给那一个", async () => {
  provideToolGroup({ id: "mem", tools: fakeTools(5) });
  const injector = new Injector({ store: tempStore(), mcp: null, logger: { warn() {} } });
  const agent = fakeAgent();
  await injector.load(agent, ["group:mem:mem_tool_3"]);
  assert.deepEqual(agent.registered.map((d) => d.name), ["mem_tool_3"]);
});

test("设置里选「跳过」就拒绝加载；打开后又能加载", async () => {
  provideToolGroup({ id: "memstudio", summary: "内存工作台", tools: fakeTools(2) });
  const store = tempStore();
  const injector = new Injector({ store, mcp: null, logger: { warn() {} } });
  const agent = fakeAgent();

  store.setDisabled("group", "memstudio", true);
  const blocked = await injector.load(agent, ["group:memstudio"]);
  assert.equal(blocked[0].ok, false);
  assert.match(blocked[0].message, /插件工具组 "memstudio" 在设置页里是关闭状态/);
  assert.equal(agent.registered.length, 0);

  store.setDisabled("group", "memstudio", false);
  const allowed = await injector.load(agent, ["group:memstudio"]);
  assert.equal(allowed[0].ok, true);
});

test("组不存在 / 组里没这个工具：可读错误，不抛", async () => {
  const injector = new Injector({ store: tempStore(), mcp: null, logger: { warn() {} } });
  const agent = fakeAgent();
  const missing = await injector.load(agent, ["group:nope"]);
  assert.equal(missing[0].ok, false);
  assert.match(missing[0].message, /没有名为 "nope" 的插件工具组/);

  provideToolGroup({ id: "mem", tools: fakeTools(1) });
  const noTool = await injector.load(agent, ["group:mem:zzz"]);
  assert.equal(noTool[0].ok, false);
  assert.match(noTool[0].message, /没有工具 "zzz"/);
});

test("设置页清单：第三类「插件工具」带 toolCount 与开关", () => {
  provideToolGroup({ id: "memstudio", summary: "内存工作台", plugin: "dsh-memstudio", tools: fakeTools(17, "mem_") });
  const store = tempStore();
  const runtime = { store, mcp: { closeServer() {} } };
  const inventory = inventoryForUi(runtime);
  assert.equal(inventory.groups.length, 1);
  assert.equal(inventory.groups[0].id, "group:memstudio");
  assert.equal(inventory.groups[0].category, "plugin");
  assert.equal(inventory.groups[0].enabled, true);
  assert.equal(inventory.groups[0].toolCount, 17);
  assert.equal(inventory.counts.groups, 1);

  setEnabledById(runtime, "group:memstudio", false);
  const after = inventoryForUi(runtime);
  assert.equal(after.groups[0].enabled, false);
  assert.deepEqual(store.listDisabled().groups, ["memstudio"]);

  assert.throws(() => setEnabledById(runtime, "group:nope", false), /不存在插件工具组/);
});
