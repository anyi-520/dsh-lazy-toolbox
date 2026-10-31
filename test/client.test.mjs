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

/** 把渲染树里的可点按钮抽出来：{ label, onClick, disabled }。 */
function buttonsOf(tree) {
  return tree
    .filter((node) => typeof node === "object" && node !== null && node.props && typeof node.props.onClick === "function")
    .map((node) => ({
      label: node.children.flatMap((child) => (typeof child === "string" ? [child] : [])).join(""),
      onClick: node.props.onClick,
      disabled: node.props.disabled,
    }));
}

function findBy(tree, predicate) {
  return tree.filter((node) => typeof node === "object" && node !== null && predicate(node.props ?? {}, node));
}

/** LazyToolboxSection 的 hook 顺序：inventory / error / busy / update */
function sectionQueue(inventory = null, update = null) {
  return [inventory, "", "", update];
}

const UPDATE = {
  repo: "anyi-520/dsh-lazy-toolbox",
  current: "0.5.3",
  latest: "0.6.0",
  hasUpdate: true,
  checkedAt: "2026-11-01T10:00:00.000Z",
  notes: "## 懒工具箱 0.6.0\n\n- 云更新",
  htmlUrl: "https://github.com/anyi-520/dsh-lazy-toolbox/releases/tag/v0.6.0",
  assets: [{ name: "dsh-lazy-toolbox-0.6.0.zip", size: 150495, url: "https://example.invalid/x.zip" }],
  download: null,
  installed: null,
};

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

test("页面把 skill 与 MCP 都列出来，每条带「懒加载 / 跳过」选择器", () => {
  const { mod } = loadBundle(sectionQueue(INVENTORY));
  const { component } = registerComponent(mod);

  const tree = render(component({}));
  const groups = findBy(tree, (props) => props.role === "radiogroup");
  assert.equal(groups.length, 3, "两个 skill + 一个 MCP 各一个选择器");
  const radios = findBy(tree, (props) => props.role === "radio");
  assert.equal(radios.length, 6, "每条两个选项：懒加载 / 跳过");
  assert.deepEqual(
    radios.filter((node) => node.props["aria-checked"] === "true").map((node) => node.props["data-mode"]),
    ["lazy", "skip", "skip"],
  );

  const text = textOf(tree);
  assert.match(text, /skill 与 MCP 开关/);
  assert.match(text, /开着 1 skill \/ 0 MCP/);
  assert.match(text, /alpha/);
  assert.match(text, /rea/);
  assert.match(text, /207 个工具/);
  assert.match(text, /懒加载/);
  assert.match(text, /跳过/);
  // 工具链面板已拆成独立插件，这里不该再出现
  assert.doesNotMatch(text, /工具链/);
  assert.doesNotMatch(text, /Ghidra/);
});

test("选「跳过」会 POST op=mode 到宿主端点", async () => {
  const { mod, net } = loadBundle(sectionQueue(INVENTORY));
  const calls = [];
  net.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ ok: true, inventory: INVENTORY }) };
  };
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  // 第一个条目（alpha，开着）里点「跳过」
  const skip = findBy(tree, (props) => props.role === "radio" && props["data-mode"] === "skip")[0];
  await skip.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.length, 1);
  assert.match(String(calls[0].url), /\/dsh-lazy-toolbox\/api$/);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { op: "mode", id: "skill:alpha", mode: "skip" });
});

test("已跳过的条目点「懒加载」会 POST mode=lazy", async () => {
  const { mod, net } = loadBundle(sectionQueue(INVENTORY));
  const calls = [];
  net.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ ok: true, inventory: INVENTORY }) };
  };
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const lazy = findBy(tree, (props) => props.role === "radio" && props["data-mode"] === "lazy")[1];
  await lazy.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(JSON.parse(calls[0].options.body), { op: "mode", id: "skill:beta", mode: "lazy" });
});


test("云更新卡片：显示当前/最新、更新内容与三步按钮", () => {
  const { mod } = loadBundle(sectionQueue(INVENTORY, UPDATE));
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const text = textOf(tree);
  assert.match(text, /云更新/);
  assert.match(text, /有新版本 0\.6\.0/);
  assert.match(text, /当前 v0\.5\.3/);
  assert.match(text, /云更新/);
  assert.match(text, /懒工具箱 0\.6\.0/);
  const labels = buttonsOf(tree).map((button) => button.label);
  assert.ok(labels.includes("检查更新"), "应有「检查更新」按钮：" + labels.join("|"));
  assert.ok(labels.includes("下载 v0.6.0"), "有新版时应出现下载按钮");
  assert.ok(!labels.includes("安装 v0.6.0"), "还没解压时不该出现安装按钮");
});

test("点「检查更新」POST op=update.check；点「下载」POST op=update.download", async () => {
  const { mod, net } = loadBundle(sectionQueue(INVENTORY, UPDATE));
  const calls = [];
  net.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, inventory: INVENTORY, update: { ...UPDATE, download: { version: "0.6.0", extracted: true, packageDir: "D:/updates/0.6.0" } } }) };
  };
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const byLabel = (label) => buttonsOf(tree).find((button) => button.label === label);

  await byLabel("检查更新").onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls[0], { op: "update.check" });

  await byLabel("下载 v0.6.0").onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls[1], { op: "update.download" });
});

test("下载好了才出现安装按钮；装完显示重启提示", () => {
  const downloaded = { ...UPDATE, download: { version: "0.6.0", extracted: true, packageDir: "D:/updates/0.6.0" } };
  const { mod } = loadBundle(sectionQueue(INVENTORY, downloaded));
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const labels = buttonsOf(tree).map((button) => button.label);
  assert.ok(labels.includes("安装 v0.6.0"), "解压后应可安装：" + labels.join("|"));

  const installed = {
    ...UPDATE,
    hasUpdate: false,
    download: null,
    installed: { version: "0.6.0", files: 9, backupDir: "D:/updates/backup-0.5.3", restartRequired: true },
  };
  const second = loadBundle(sectionQueue(INVENTORY, installed));
  const component2 = registerComponent(second.mod).component;
  const text = textOf(render(component2({})));
  assert.match(text, /已安装 v0\.6\.0/);
  assert.match(text, /请关掉 DSH 再打开/);
});
