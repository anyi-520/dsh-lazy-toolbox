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
function loadBundle(hookQueue = [], globals = {}) {
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
    navigator: { clipboard: { writeText: (...args) => net.clipboard?.(...args) } },
    // 假 FileReader：直接把 file.__base64 当结果
    FileReader: class {
      readAsDataURL(file) {
        this.result = `data:application/zip;base64,${file?.__base64 ?? ""}`;
        setTimeout(() => this.onload?.(), 0);
      }
    },
  };
  Object.assign(sandbox, globals);
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
  if (node == null || depth > 80) return [];
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

/** LazyToolboxSection 的 hook 顺序：inventory / error / busy / update / about / zip / tab / promptHidden / 编辑器四件套 */
function sectionQueue(inventory = null, update = null, tab = "lazy", about = null, zip = null) {
  return [inventory, "", "", update, about, zip, tab, false, "", "", null, ""];
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
  const slots = {};
  mod.apply({
    slots: {
      inject(name, run) {
        assert.ok(["settings.section", "shell.overlay"].includes(name), "意外的 slot：" + name);
        run();
      },
      register(options, given) {
        slots[options.name] = { options, component: given };
        if (options.name === "settings.section") component = given;
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

test("apply 在设置页登记「懒工具箱」一节（order 60），并往全局层挂更新弹窗", () => {
  const { mod } = loadBundle();
  const registrations = [];
  const ctx = {
    slots: {
      inject(name, run) {
        assert.ok(["settings.section", "shell.overlay"].includes(name), "意外的 slot：" + name);
        run();
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  mod.apply(ctx);
  assert.equal(registrations.length, 2, "设置页一节 + 全局更新弹窗");
  const section = registrations.find((item) => item.options.name === "settings.section");
  const overlay = registrations.find((item) => item.options.name === "shell.overlay");
  assert.equal(section.options.id, "lazy-toolbox");
  assert.equal(section.options.label(), "懒工具箱");
  assert.equal(section.options.order, 60);
  assert.equal(typeof section.component, "function");
  assert.equal(overlay.options.id, "lazy-toolbox-update", "弹窗要挂在 shell.overlay 上，进 DSH 就能弹");
  assert.equal(typeof overlay.component, "function");
});

test("全局更新弹窗自己拉状态，prompt.show 时弹三个按钮", async () => {
  // UpdateDialog 的 hook 顺序：update / busy / hidden（useEffect 在测试里是空实现，
  // 所以直接把「已经拉到新版本」这份状态喂进队列）
  const { mod } = loadBundle([{ ...UPDATE, prompt: { show: true } }, "", false]);
  let dialog;
  mod.apply({
    slots: {
      inject(name, run) {
        run();
      },
      register(options, component) {
        if (options.name === "shell.overlay") dialog = component;
        return () => {};
      },
    },
  });
  assert.equal(typeof dialog, "function");
  const tree = render(dialog({}));
  assert.match(textOf(tree), /懒工具箱有新版本/);
  const labels = buttonsOf(tree).map((button) => button.label);
  for (const label of ["本次不提醒", "今天不提醒", "更新"]) {
    assert.ok(labels.includes(label), `弹窗里应有「${label}」，实际：${labels.join("|")}`);
  }
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
  assert.match(text, /插件工具 \/ skill \/ MCP 开关/);
  assert.match(text, /开着 0 组插件工具/);
  assert.match(text, /开着 0 组插件工具 \/ 1 skill \/ 0 MCP/);
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


test("云更新卡片：显示当前/最新、更新内容与三步按钮（在「工具」标签里）", () => {
  const { mod } = loadBundle(sectionQueue(INVENTORY, UPDATE, "tool"));
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
  const { mod, net } = loadBundle(sectionQueue(INVENTORY, UPDATE, "tool"));
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
  const { mod } = loadBundle(sectionQueue(INVENTORY, downloaded, "tool"));
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
  const second = loadBundle(sectionQueue(INVENTORY, installed, "tool"));
  const component2 = registerComponent(second.mod).component;
  const text = textOf(render(component2({})));
  assert.match(text, /已安装 v0\.6\.0/);
  assert.match(text, /请关掉 DSH 再打开/);
});


const INVENTORY_WITH_GROUP = {
  ...INVENTORY,
  groups: [
    {
      id: "group:memstudio",
      category: "plugin",
      name: "memstudio",
      summary: "内存工作台：附加进程 / 读写搜索 / 断点 / 指针链",
      enabled: true,
      toolCount: 17,
      toolNames: ["mem_read", "mem_write"],
      plugin: "dsh-memstudio",
      external: true,
    },
  ],
  counts: { groups: 1, skills: 2, mcp: 1, groupsOn: 1, skillsOn: 1, mcpOn: 0 },
};

test("第三类「插件工具」在设置页单独成组，显示托管工具数与插件名", () => {
  const { mod } = loadBundle(sectionQueue(INVENTORY_WITH_GROUP));
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const text = textOf(tree);
  assert.match(text, /开着 1 组插件工具 \/ 1 skill \/ 0 MCP/);
  assert.match(text, /插件工具1 组/, "应有「插件工具」分组标题与数量");
  assert.match(text, /memstudio/);
  assert.match(text, /托管 17 个工具/);
  assert.match(text, /插件 dsh-memstudio/);
  const labels = buttonsOf(tree).map((b) => b.label);
  assert.ok(labels.includes("懒加载") && labels.includes("跳过"), "插件工具那行也要有加载方式选择器");
});

test("插件工具选「跳过」也走 op=mode（id 用 group: 前缀）", async () => {
  const { mod, net } = loadBundle(sectionQueue(INVENTORY_WITH_GROUP));
  const calls = [];
  net.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, inventory: INVENTORY_WITH_GROUP }) };
  };
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  // 第一行是插件工具（memstudio，当前是懒加载），它的「跳过」单选是整棵树里第一个
  const skipRadios = tree.filter((node) => node.props && node.props["data-mode"] === "skip");
  assert.ok(skipRadios.length > 0, "应有「跳过」单选");
  skipRadios[0].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls[0], { op: "mode", id: "group:memstudio", mode: "skip" });
});

// ── 顶部名片（照插件管理页的样式） ─────────────────────────────────────────

test("顶部名片：名称 + 正常标签 + 版本 + 来源信息 / 数据目录", () => {
  const { mod } = loadBundle(sectionQueue({ ...INVENTORY_WITH_GROUP, dataDir: "C:/Users/x/.dsh/lazy-toolbox", installDir: "D:/逆向/dsh-lazy-toolbox" }, UPDATE));
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const text = textOf(tree);
  assert.match(text, /懒工具箱/);
  assert.match(text, /正常/);
  assert.match(text, /v0\.5\.3/);
  assert.match(text, /来源信息/);
  assert.match(text, /代码来源/);
  assert.match(text, /link:D:\/逆向\/dsh-lazy-toolbox/);
  assert.match(text, /数据目录/);
  assert.match(text, /C:\/Users\/x\/\.dsh\/lazy-toolbox/);
  const labels = buttonsOf(tree).map((button) => button.label);
  assert.ok(labels.includes("检查更新"), "名片右上角要有检查更新");
});

test("没有清单时名片显示「未就绪」而不是空白", () => {
  const { mod } = loadBundle(sectionQueue(null));
  const { component } = registerComponent(mod);
  const text = textOf(render(component({})));
  assert.match(text, /未就绪/);
  assert.match(text, /未读到安装目录/);
});

// ── 三标签 ───────────────────────────────────────────────────────────────

test("顶部有「懒加载 / 工具 / 关于」三个标签，默认落在懒加载", () => {
  const { mod } = loadBundle(sectionQueue(INVENTORY_WITH_GROUP));
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const tabs = tree.filter((node) => node.props && node.props.role === "tab");
  assert.equal(tabs.length, 3, "三个标签");
  assert.deepEqual(
    tabs.map((node) => node.props["data-tab"]),
    ["lazy", "tool", "about"],
  );
  assert.deepEqual(
    tabs.map((node) => node.children.join("")),
    ["懒加载", "工具", "关于"],
  );
  assert.equal(tabs.filter((node) => node.props["aria-selected"] === "true").length, 1);
  assert.equal(tabs.find((node) => node.props["aria-selected"] === "true").props["data-tab"], "lazy");
  // 懒加载页里有 list，没有更新卡片
  assert.match(textOf(tree), /插件工具1 组/);
  assert.doesNotMatch(textOf(tree), /云更新/);
});

test("「关于」标签：介绍软件 + 感谢名单 + 制作名单，不再放更新卡片", () => {
  const ABOUT = {
    intro: "懒工具箱管的是「上下文预算」。",
    repo: "https://github.com/anyi-520/dsh-lazy-toolbox",
    thanks: [],
    thanksEmpty: "还空着——留给你。",
    authors: [
      { id: "anyi", name: "安逸", badge: "作者", role: "需求、拍板、测试", avatar: "/dsh-lazy-toolbox/avatar/anyi.jpg", link: "https://github.com/anyi-520", linkText: "github.com/anyi-520" },
      { id: "xiaomajiang", name: "小码酱", badge: "实现", role: "写代码的那个 AI", avatar: "data:image/svg+xml;utf8,%3Csvg%3E" },
    ],
  };
  const { mod } = loadBundle(sectionQueue(INVENTORY_WITH_GROUP, UPDATE, "about", ABOUT));
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const text = textOf(tree);
  assert.match(text, /关于懒工具箱/);
  assert.match(text, /上下文预算/);
  assert.match(text, /感谢名单/);
  assert.match(text, /还空着/);
  assert.match(text, /制作名单/);
  assert.match(text, /安逸/);
  assert.match(text, /小码酱/);
  assert.match(text, /github\.com\/anyi-520\/dsh-lazy-toolbox/);
  assert.match(text, /当前托管：1 组插件工具 \/ 2 skill \/ 1 MCP/);
  // 更新相关内容整体搬走了（名片右上角的「检查更新」是全局的，仍在）
  assert.doesNotMatch(text, /云更新/);
  assert.doesNotMatch(text, /下载 v0\.6\.0|安装 v0\.6\.0/);
  assert.doesNotMatch(text, /当前 v0\.5\.3/);
  const avatarSrcs = findBy(tree, (props) => typeof props.src === "string").map((node) => node.props.src);
  assert.ok(avatarSrcs.includes("/dsh-lazy-toolbox/avatar/anyi.jpg"), "安逸的头像走插件端点：" + avatarSrcs.join("|"));
  assert.ok(avatarSrcs.some((src) => src.startsWith("data:image/svg+xml")), "小码酱用内联 SVG 头像");
  const labels = buttonsOf(tree).map((button) => button.label);
  for (const gone of ["下载 v0.6.0", "安装 v0.6.0", "保存", "回滚"]) {
    assert.ok(!labels.includes(gone), `关于页不该有「${gone}」：${labels.join("|")}`);
  }
});

test("宿主没给 about（老版本服务端）时，制作名单照样有人，不是「暂无」", () => {
  const { mod } = loadBundle(sectionQueue(INVENTORY_WITH_GROUP, null, "about"));
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const text = textOf(tree);
  assert.match(text, /关于懒工具箱/);
  assert.match(text, /上下文预算/);
  assert.match(text, /感谢名单/);
  assert.match(text, /制作名单/);
  assert.match(text, /安逸/);
  assert.match(text, /小码酱/);
  assert.doesNotMatch(text, /暂无/);
  const avatarSrcs = findBy(tree, (props) => typeof props.src === "string").map((node) => node.props.src);
  assert.ok(
    avatarSrcs.some((src) => src.startsWith("data:image/jpeg;base64,")),
    "没有头像端点时要回落到内联照片：" + avatarSrcs.map((src) => src.slice(0, 32)).join("|"),
  );
  assert.ok(avatarSrcs.some((src) => src.startsWith("data:image/svg+xml")), "小码酱用内联 SVG");
});

test("「工具」标签里有 zip 导入卡片：拖放区 + 选择 zip", () => {
  const { mod } = loadBundle(sectionQueue(INVENTORY_WITH_GROUP, null, "tool"));
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const text = textOf(tree);
  assert.match(text, /导入插件 zip/);
  assert.match(text, /\.zip 免解压/);
  assert.match(text, /拖 \.zip 到这里/);
  assert.match(text, /zip-slip/);
  const drop = tree.find((node) => node.props && node.props["data-role"] === "zip-drop");
  assert.ok(drop, "应有拖放区");
  assert.equal(typeof drop.props.onDrop, "function");
  assert.equal(typeof drop.props.onDragOver, "function");
  const pick = tree.find((node) => node.props && node.props["data-role"] === "zip-pick");
  assert.ok(pick, "应有「选择 zip」的按钮");
  const input = tree.find((node) => node.props && node.props["data-role"] === "zip-input");
  assert.equal(input?.props?.type, "file");
  assert.match(String(input?.props?.accept), /\.zip/);
});

test("把 zip 拖进设置页 → POST op=plugin.import，内容带 base64", async () => {
  const { mod, net } = loadBundle(sectionQueue(INVENTORY_WITH_GROUP, null, "tool"));
  const calls = [];
  net.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        ok: true,
        imported: {
          name: "dsh-demo-plugin",
          version: "1.2.3",
          dir: "D:/data/plugins/dsh-demo-plugin-1.2.3",
          files: 4,
          bytes: 2048,
          hasBundle: true,
          profiles: [{ profileDir: "D:/profile", dependency: { wrote: true }, link: { ok: true, wrote: true }, patch: { wrote: true } }],
          hint: "重启 DSH 生效。",
        },
        inventory: INVENTORY_WITH_GROUP,
      }),
    };
  };
  const { component } = registerComponent(mod);
  let tree = render(component({}));

  const drop = tree.find((node) => node.props && node.props["data-role"] === "zip-drop");
  const file = { name: "dsh-demo-plugin-1.2.3.zip", __base64: "UEsDBAoAAAAAAA==" };
  const event = { preventDefault() {}, dataTransfer: { files: [file], types: ["Files"] } };
  drop.props.onDrop(event);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(calls[0].op, "plugin.import");
  assert.equal(calls[0].zip, "UEsDBAoAAAAAAA==", "要把 base64 正文传上去（不带 data: 前缀）");
  assert.equal(calls[0].filename, "dsh-demo-plugin-1.2.3.zip");
});

test("拖进来的不是 zip 就不发请求，直接说清楚", async () => {
  const { mod, net } = loadBundle(sectionQueue(INVENTORY_WITH_GROUP, null, "tool"));
  const calls = [];
  net.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const section = tree[0];
  section.props.onDrop({ preventDefault() {}, dataTransfer: { files: [{ name: "照片.png" }] } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 0, "非 zip 不该发请求");
});

test("装完把结果摊开：版本、目录、profile 接线与重启提示", () => {
  const imported = {
    name: "dsh-demo-plugin",
    version: "1.2.3",
    dir: "D:/data/plugins/dsh-demo-plugin-1.2.3",
    files: 4,
    bytes: 2048,
    hasBundle: true,
    profiles: [{ profileDir: "D:/profile", dependency: { wrote: true }, link: { ok: true, wrote: true }, patch: { wrote: true } }],
    hint: "重启 DSH 生效。",
  };
  const { mod } = loadBundle(sectionQueue(INVENTORY_WITH_GROUP, null, "tool", null, { result: imported, name: "dsh-demo-plugin-1.2.3.zip" }));
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const text = textOf(tree);
  assert.match(text, /已装 dsh-demo-plugin@1\.2\.3/);
  assert.match(text, /D:\/data\/plugins\/dsh-demo-plugin-1\.2\.3/);
  assert.match(text, /组合包：有/);
  assert.match(text, /patch已加/);
  assert.match(text, /重启 DSH 生效/);
  const labels = buttonsOf(tree).map((button) => button.label);
  assert.ok(labels.includes("复制安装目录"), "装完给个复制路径的按钮：" + labels.join("|"));
});

test("装完点「填进官方弹窗」：走原生 value setter 并派发 input 事件", () => {
  const events = [];
  const input = {
    placeholder: "例如 dsh-plugin-whale-pet",
    value: "",
    type: "text",
    offsetParent: {},
    focus() {},
    dispatchEvent(event) {
      events.push(event.type);
    },
  };
  // 原生 setter 打上 native: 前缀，证明走的是 setter 而不是裸赋值
  function HTMLInputElement() {}
  Object.defineProperty(HTMLInputElement.prototype, "value", {
    configurable: true,
    get() {
      return input.value;
    },
    set(next) {
      input.value = `native:${next}`;
    },
  });
  const documentStub = {
    querySelectorAll: (selector) => (selector === "input" ? [input] : []),
    defaultView: {
      HTMLInputElement,
      Event: class {
        constructor(type) {
          this.type = type;
        }
      },
    },
  };

  const zipState = {
    result: { name: "dsh-demo-plugin", version: "1.2.3", dir: "D:/data/plugins/dsh-demo-1.2.3", profiles: [], files: 3, bytes: 10 },
  };
  const { mod } = loadBundle(sectionQueue(INVENTORY_WITH_GROUP, null, "tool", null, zipState), { document: documentStub });
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const fill = buttonsOf(tree).find((button) => button.label === "填进官方弹窗");
  assert.ok(fill, "装完应给「填进官方弹窗」按钮：" + buttonsOf(tree).map((b) => b.label).join("|"));
  fill.onClick();
  assert.equal(input.value, "native:D:/data/plugins/dsh-demo-1.2.3");
  assert.deepEqual(events, ["input", "change"]);
});

test("弹窗没开时点「填进官方弹窗」只说没找到，不炸", () => {
  const documentStub = {
    querySelectorAll: () => [],
    defaultView: { HTMLInputElement: function () {}, Event: class {} },
  };
  const zipState = { result: { name: "p", version: "1.0.0", dir: "D:/x", profiles: [], files: 1, bytes: 1 } };
  const { mod } = loadBundle(sectionQueue(INVENTORY_WITH_GROUP, null, "tool", null, zipState), { document: documentStub });
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const fill = buttonsOf(tree).find((button) => button.label === "填进官方弹窗");
  assert.doesNotThrow(() => fill.onClick());
});

test("「工具」标签里有代码编辑器与两个动作按钮", () => {
  const { mod } = loadBundle(sectionQueue(INVENTORY_WITH_GROUP, null, "tool"));
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const text = textOf(tree);
  assert.match(text, /代码编辑器/);
  const labels = buttonsOf(tree).map((button) => button.label);
  for (const label of ["读取", "校验", "保存", "回滚", "扫描插件内置资产", "撤掉本会话注入"]) {
    assert.ok(labels.includes(label), `应有「${label}」按钮，实际：${labels.join("|")}`);
  }
  const area = tree.find((node) => node.props && node.props["data-role"] === "editor-body");
  assert.ok(area, "应有编辑区 textarea");
});

test("编辑器「保存」POST op=code.write，把内容带上", async () => {
  const queue = sectionQueue(INVENTORY_WITH_GROUP, null, "tool");
  queue[8] = "lib/index.js";
  queue[9] = "export const a = ;\n";
  const { mod, net } = loadBundle(queue);
  const calls = [];
  net.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({ ok: true, write: { ok: false, written: false, kind: "js", errors: [{ line: 1, column: 17, message: "Unexpected token ';'" }], message: "校验没通过，没有写入" } }),
    };
  };
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const save = buttonsOf(tree).find((button) => button.label === "保存");
  await save.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls[0], { op: "code.write", path: "lib/index.js", content: "export const a = ;\n" });
});

test("编辑器「校验」POST op=code.validate", async () => {
  const queue = sectionQueue(INVENTORY_WITH_GROUP, null, "tool");
  queue[8] = "lib/index.js";
  queue[9] = "export const a = 1;\n";
  const { mod, net } = loadBundle(queue);
  const calls = [];
  net.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, validation: { ok: true, kind: "js", errors: [], notes: [] } }) };
  };
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const check = buttonsOf(tree).find((button) => button.label === "校验");
  await check.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls[0], { op: "code.validate", path: "lib/index.js", content: "export const a = 1;\n" });
});

// ── 新版本弹窗 ───────────────────────────────────────────────────────────

const UPDATE_PROMPT = { ...UPDATE, prompt: { show: true } };

test("有新版本时弹窗出现，带「本次不提醒 / 今天不提醒 / 更新」", () => {
  const { mod } = loadBundle(sectionQueue(INVENTORY, UPDATE_PROMPT));
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const labels = buttonsOf(tree).map((button) => button.label);
  for (const label of ["本次不提醒", "今天不提醒", "更新"]) {
    assert.ok(labels.includes(label), `弹窗里应有「${label}」，实际：${labels.join("|")}`);
  }
  assert.match(textOf(tree), /懒工具箱有新版本/);
  assert.match(textOf(tree), /0\.5\.3 → 最新 0\.6\.0/);
});

test("prompt.show 为假时不出弹窗", () => {
  const { mod } = loadBundle(sectionQueue(INVENTORY, { ...UPDATE, prompt: { show: false } }));
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  assert.doesNotMatch(textOf(tree), /懒工具箱有新版本/);
});

test("「本次不提醒」POST op=update.snooze scope=session", async () => {
  const { mod, net } = loadBundle(sectionQueue(INVENTORY, UPDATE_PROMPT));
  const calls = [];
  net.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, inventory: INVENTORY, update: { ...UPDATE, prompt: { show: false } } }) };
  };
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const button = buttonsOf(tree).find((item) => item.label === "本次不提醒");
  await button.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls[0], { op: "update.snooze", scope: "session" });
});

test("「今天不提醒」POST op=update.snooze scope=today", async () => {
  const { mod, net } = loadBundle(sectionQueue(INVENTORY, UPDATE_PROMPT));
  const calls = [];
  net.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, inventory: INVENTORY, update: { ...UPDATE, prompt: { show: false } } }) };
  };
  const { component } = registerComponent(mod);
  const tree = render(component({}));
  const button = buttonsOf(tree).find((item) => item.label === "今天不提醒");
  await button.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls[0], { op: "update.snooze", scope: "today" });
});
