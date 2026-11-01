/**
 * 插件工具分组：给别的插件用的「把工具交出来、别自己常驻」的入口。
 *
 * 场景：某个插件（比如内存工作台）一次注册 17 个 `mem_*` 工具，不管这一轮聊的是不是内存，
 * 这 17 份 schema 都躺在工具定义里。让它改成调用本模块的 `provideToolGroup()`，
 * 工具定义就只留在这里（内存里，不落盘、不进系统提示），
 * 懒工具箱的目录里多一行「group:memstudio — 内存工作台：…（17 个工具）」，
 * 需要时 `toolbox { action: "load", ids: ["group:memstudio"] }` 才真正注册进去。
 *
 * 其他插件一侧的用法（零依赖、可选）：
 *
 * ```js
 * // 直接引用本文件；包没装就回落到自己注册
 * import("dsh-lazy-toolbox/lib/tool-groups.js")
 *   .then(({ provideToolGroup }) => provideToolGroup({ id: "memstudio", summary: "…", tools }))
 *   .catch(() => { for (const t of tools) ctx.tools.register(t) })
 * ```
 *
 * 注意：这是**同一个 Node 进程里的模块单例**。插件与懒工具箱经由同一 node_modules 解析到同一
 * 实体路径，因此 `import()` 拿到的是同一份注册表。若哪天两者装在不同路径，桥会失效并自动回落
 * 到插件自己注册（不会把工具弄丢）。
 */

/** id → { id, summary, plugin, category, tools, addedAt } */
const groups = new Map();
const listeners = new Set();

function emit() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* 监听者自己的问题不影响别的监听者 */
    }
  }
}

/** 补上默认 output：DSH 要求工具声明返回结构；插件没写就按 {text} 兜底。 */
function normalizeTool(tool) {
  const name = String(tool?.name ?? "").trim();
  if (!name) return null;
  const output = tool.output ?? {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { text: { type: "string" } },
    },
    render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
  };
  return {
    name,
    description: String(tool.description ?? ""),
    parameters: tool.parameters ?? { type: "object", additionalProperties: false, properties: {} },
    output,
    execute: typeof tool.execute === "function" ? tool.execute : async () => ({ text: "" }),
  };
}

/**
 * 把一个插件的工具组交给懒工具箱保管。
 * @returns {() => void} 撤销函数（插件卸载时调用）
 */
export function provideToolGroup({ id, summary = "", plugin = "", category = "plugin", tools = [] } = {}) {
  const key = String(id ?? "").trim();
  if (!key) throw new Error("provideToolGroup 需要 id");
  const normalized = (Array.isArray(tools) ? tools : []).map(normalizeTool).filter(Boolean);
  if (normalized.length === 0) throw new Error(`工具组 ${key} 里没有工具`);
  groups.set(key, {
    id: key,
    summary: String(summary ?? "").trim(),
    plugin: String(plugin ?? "").trim(),
    category: String(category ?? "plugin"),
    tools: normalized,
    addedAt: new Date().toISOString(),
  });
  emit();
  return () => removeToolGroup(key);
}

export function removeToolGroup(id) {
  const changed = groups.delete(String(id ?? ""));
  if (changed) emit();
  return changed;
}

export function clearToolGroups() {
  if (groups.size === 0) return;
  groups.clear();
  emit();
}

/** 目录里要显示的一行：id + 一句话用途 + 工具清单。 */
export function listToolGroups() {
  return [...groups.values()].map((group) => ({
    id: group.id,
    summary: group.summary,
    plugin: group.plugin,
    category: group.category,
    addedAt: group.addedAt,
    toolCount: group.tools.length,
    toolNames: group.tools.map((tool) => tool.name),
  }));
}

export function getToolGroup(id) {
  return groups.get(String(id ?? "")) ?? null;
}

/** 挑某个组里的某几个工具；不给名字就全给。 */
export function pickGroupTools(id, names = null) {
  const group = getToolGroup(id);
  if (!group) return null;
  if (!Array.isArray(names) || names.length === 0) return group.tools;
  const wanted = new Set(names.map(String));
  return group.tools.filter((tool) => wanted.has(tool.name));
}

export function onToolGroupsChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 全局桥：给「装在不同目录、bare import 解析不到本包」的插件用。
 * Symbol.for 走全局符号表，同一个进程里不同模块副本也能拿到同一把钥匙。
 *
 * 别的插件一侧：
 * ```js
 * const bridge = globalThis[Symbol.for("dsh-lazy-toolbox.bridge")];
 * if (bridge) bridge.provideToolGroup({ id: "memstudio", summary: "…", tools });
 * else for (const t of tools) ctx.tools.register(t);   // 懒工具箱不在就自己注册
 * ```
 */
export const BRIDGE_KEY = Symbol.for("dsh-lazy-toolbox.bridge");

const bridge = {
  version: 1,
  provideToolGroup,
  removeToolGroup,
  clearToolGroups,
  listToolGroups,
  getToolGroup,
  pickGroupTools,
  onToolGroupsChange,
};
if (!globalThis[BRIDGE_KEY]) globalThis[BRIDGE_KEY] = bridge;
