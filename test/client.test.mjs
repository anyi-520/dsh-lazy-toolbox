import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, "..", "client.js");
const source = fs.readFileSync(bundlePath, "utf8");

/**
 * 用假的 __ModuleLoader__ / react 把浏览器半的 bundle 跑起来。
 * 返回 { exports }：apply() 登记到设置页的那一项由各测试自己收集。
 */
function loadBundle(hookQueue = []) {
  let loaded;
  // fetch 由测试替换：sandbox 里的 fetch 只做转调，避免跨 realm 的 globalThis 干扰
  const net = { fetch: async () => ({ ok: true, json: async () => ({}) }) };
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(record) {
          loaded = record;
        },
      },
    },
    console,
    setTimeout,
    clearTimeout,
    fetch: (...args) => net.fetch(...args),
    navigator: { clipboard: { writeText() {} } },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "client.js" });
  assert.ok(loaded, "bundle 应该调用 window.__ModuleLoader__.load");

  const queue = [...hookQueue];
  const react = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child != null) };
    },
    useState(initial) {
      return [queue.length > 0 ? queue.shift() : initial, () => {}];
    },
    useEffect() {},
    useRef() {
      return { current: null };
    },
    useCallback(fn) {
      return fn;
    },
  };
  const requireStub = (name) => {
    if (name === "react") return react;
    throw new Error(`意外的依赖：${name}`);
  };
  const mod = loaded.factory(requireStub);
  return { mod, react, id: loaded.id, net };
}

/** 递归渲染：函数式组件当普通函数调用（它们只用 hook，不依赖渲染器）。 */
function render(node, depth = 0) {
  if (node == null || depth > 30) return [];
  if (Array.isArray(node)) return node.flatMap((child) => render(child, depth + 1));
  if (typeof node === "string" || typeof node === "number") return [node];
  if (typeof node.type === "function") return render(node.type(node.props), depth + 1);
  return [node, ...node.children.flatMap((child) => render(child, depth + 1))];
}

function textOf(tree) {
  return tree
    .map((node) => (typeof node === "string" ? node : ""))
    .join("");
}

function findBy(tree, predicate) {
  return tree.filter((node) => typeof node === "object" && node !== null && predicate(node.props ?? {}, node));
}

/** LazyToolboxSection 的 hook 顺序：inventory / error / busy */
function sectionQueue(inventory = null) {
  return [inventory, "", ""];
}

const INVENTORY = {
  skills: [
    { id: "skill:alpha", name: "alpha", summary: "第一个 skill", enabled: true, source: "manual" },
    { id: "skill:beta", name: "beta", summary: "被关掉的 skill", enabled: false, source: "manual" },
  ],
  mcp: [{ id: "mcp:rea", name: "rea", summary: "逆向引擎", enabled: false, transport: "stdio", toolCount: 207 }],
  counts: { skills: 2, mcp: 1, skillsOn: 1, mcpOn: 0 },
};

function registerComponent(mod, queue) {
  let component;
  mod.apply({
    slots: {
      inject(name, run) {
        assert.equal(name, "settings.section");
        run();
      },
      register(options, given) {
        component = given;
        return () => {};
      },
    },
  });
  assert.equal(typeof component, "function");
  return { component, queue };
}

test("client bundle 用 ModuleLoader 格式导出，id 与包名一致", () => {
  const { mod, id } = loadBundle();
  assert.equal(id, "dsh-lazy-toolbox");
  assert.equal(mod.name, "dsh-lazy-toolbox");
  assert.equal([...mod.inject].join(","), "slots");
  assert.equal(typeof mod.apply, "function");
});

test("apply 在设置页登记「懒工具箱」一节（order 60）", () => {
  const { mod } = loadBundle();
  const registrations = [];
  const ctx = {
    slots: {
      inject(name, run) {
        assert.equal(name, "settings.section");
        run();
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  mod.apply(ctx);
  assert.equal(registrations.length, 1);
  const [{ options }] = registrations;
  assert.equal(options.name, "settings.section");
  assert.equal(options.id, "lazy-toolbox");
  assert.equal(options.label(), "懒工具箱");
  assert.equal(options.order, 60);
  assert.equal(typeof registrations[0].component, "function");
});

test("页面把 skill 与 MCP 都列出来，关掉的显示「已关闭」，不再有工具链内容", () => {
  const { mod } = loadBundle(sectionQueue(INVENTORY));
  const { component } = registerComponent(mod);

  const tree = render(component({}));
  const switches = findBy(tree, (props) => props.role === "switch");
  assert.equal(switches.length, 3, "两个 skill + 一个 MCP 各一个开关");
  assert.deepEqual(
    switches.map((node) => node.props["aria-checked"]),
    ["true", "false", "false"],
  );

  const text = textOf(tree);
  assert.match(text, /skill 与 MCP 开关/);
  assert.match(text, /开着 1 skill \/ 0 MCP/);
  assert.match(text, /alpha/);
  assert.match(text, /rea/);
  assert.match(text, /207 个工具/);
  assert.match(text, /已关闭/);
  // 工具链面板已拆成独立插件，这里不该再出现
  assert.doesNotMatch(text, /工具链/);
  assert.doesNotMatch(text, /Ghidra/);
});

test("点开关会 POST op=toggle 到宿主端点", async () => {
  const { mod, net } = loadBundle(sectionQueue(INVENTORY));
  const calls = [];
  net.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ ok: true, inventory: INVENTORY }) };
  };
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const [firstSwitch] = findBy(tree, (props) => props.role === "switch");
  await firstSwitch.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.length, 1);
  assert.match(String(calls[0].url), /\/dsh-lazy-toolbox\/api$/);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { op: "toggle", id: "skill:alpha", enabled: false });
});
