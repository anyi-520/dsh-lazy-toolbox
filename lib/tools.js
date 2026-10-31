/**
 * 唯一的常驻工具 `toolbox`：目录、热加载、卸载、导入、移除。
 *
 * 它本身很小（约 1KB schema），真正的 skill / MCP 定义只有在 load 时才进入
 * 当前会话的工具定义，unload 后立刻消失。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describeServerTools, parseItemId } from "./inject.js";
import {
  deleteSkillFiles,
  importSkillUnit,
  isSkillName,
  loadSkill,
  normalizeSkillName,
} from "./skills.js";
import { errorMessage, exists, isDirectory, nowIso, oneLine, rmrf, dshHome } from "./util.js";
import { listProfiles, isProfileDir } from "./profile.js";
import { discoverPluginAssets } from "./discover.js";
import { readSection, renderOutline, estimateTokens } from "./outline.js";

const execFileAsync = promisify(execFile);

const ACTIONS = ["status", "list", "load", "unload", "skill", "add_skill", "add_mcp", "remove", "mode", "enable", "disable", "discover", "update"];

export const TOOLBOX_TOOL_NAME = "toolbox";

export function toolboxToolDefinition(runtime) {
  return {
    name: TOOLBOX_TOOL_NAME,
    description: [
      "懒工具箱：查看 / 热加载 / 卸载本机已安装的 skill 与 MCP 工具。",
      "这些能力默认不在你的工具列表里（只在会话目录中列出一句话用途）。",
      "先用 action=list 看清单，再用 action=load（ids: [\"skill:名字\"] / [\"mcp:服务\"] / [\"mcp:服务:工具\"]）把定义注入当前会话，用完 action=unload；",
      "skill 默认只注入大纲（骨架 + 每节一句话），要看某一节原文用 action=skill 带 section；要整篇用 section: \"all\"。",
      "用户要求安装/下载新的 skill 或 MCP 时用 add_skill / add_mcp。",
      "设置某个条目「懒加载 / 跳过」用 action=mode（mode: \"lazy\" | \"skip\"）。",
      "（外部工具链的检测与安装已经拆到独立插件 dsh-toolchain，用它的 toolchain 工具。）",
    ].join(""),
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ACTIONS,
          description: "要执行的动作",
        },
        ids: {
          type: "array",
          items: { type: "string" },
          description: "目标 id 列表：skill:<name>、mcp:<server>、mcp:<server>:<tool>",
        },
        id: {
          type: "string",
          description: "单个 id（等价于只传一个 ids），如 skill:<name>",
        },
        all: {
          type: "boolean",
          description: "unload 时卸载本会话全部已加载项",
        },
        section: {
          type: "string",
          description: "action=skill：要取的节 id（如 \"2.1\"）；\"all\" 表示整篇；省略则只要大纲",
        },
        mode: {
          type: "string",
          enum: ["lazy", "skip"],
          description: "action=mode：lazy=懒加载（进目录、可按需注入）；skip=跳过懒加载（不进目录、不许注入）",
        },
        step: {
          type: "string",
          enum: ["check", "download", "install"],
          description: "action=update：check=查有没有新版本；download=下载并解压；install=覆盖安装（装完要重启 DSH 才生效）",
        },
        path: {
          type: "string",
          description: "add_skill：本地目录 / .md 文件 / 压缩包解出的目录",
        },
        url: {
          type: "string",
          description: "add_skill：git 仓库地址或指向 SKILL.md 的 http(s) 链接",
        },
        name: {
          type: "string",
          description: "add_*：名称（skill 为 kebab-case；MCP 为服务名）",
        },
        summary: {
          type: "string",
          description: "add_*：一句话说明用途（会写进目录，模型据此决定何时加载）",
        },
        transport: {
          type: "string",
          enum: ["stdio", "streamable-http"],
          description: "add_mcp：传输方式，默认 stdio",
        },
        command: {
          type: "string",
          description: "add_mcp（stdio）：启动命令，如 npx / node / uvx",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "add_mcp（stdio）：命令参数",
        },
        env: {
          type: "object",
          description: "add_mcp（stdio）：额外的环境变量（键值均为字符串）",
        },
        cwd: {
          type: "string",
          description: "add_mcp（stdio）：子进程工作目录",
        },
        headers: {
          type: "object",
          description: "add_mcp（streamable-http）：请求头",
        },
        timeoutMs: {
          type: "number",
          description: "add_mcp：单次调用超时毫秒",
        },
      },
      required: ["action"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", description: "给模型看的执行结果" },
        },
      },
      render(_args, value) {
        return [{ type: "text", text: String(value?.text ?? "") }];
      },
    },
    async execute(args, exec) {
      const action = String(args?.action ?? "status");
      const context = { runtime, exec, args };
      const log = runtime.log;
      const started = Date.now();
      const trace = {
        action,
        ids: Array.isArray(args?.ids) ? args.ids.map(String).slice(0, 20) : args?.id ? [String(args.id)] : undefined,
        all: args?.all === true ? true : undefined,
      };
      try {
        const value = await runAction(action, context);
        log?.info?.("toolbox.call", { ...trace, ok: true, ms: Date.now() - started });
        return value;
      } catch (error) {
        log?.error?.("toolbox.call", { ...trace, ok: false, ms: Date.now() - started, error });
        throw error;
      }
    },
  };
}

/** 真正干活的分支；`execute` 只负责计时与日志。 */
async function runAction(action, context) {
  switch (action) {
    case "status":
      return { text: renderStatus(context) };
    case "list":
      return { text: await renderList(context) };
    case "load":
      return { text: await doLoad(context) };
    case "unload":
      return { text: doUnload(context) };
    case "skill":
      return { text: await guard(context, "skill", () => doSkillSection(context)) };
    case "mode":
      return { text: await guard(context, "mode", () => doSetMode(context)) };
    case "add_skill":
      return { text: await guard(context, "add_skill", () => doAddSkill(context)) };
    case "add_mcp":
      return { text: await guard(context, "add_mcp", () => doAddMcp(context)) };
    case "remove":
      return { text: await guard(context, "remove", () => doRemove(context)) };
    case "enable":
      return { text: await guard(context, "enable", () => doSetEnabled(context, true)) };
    case "disable":
      return { text: await guard(context, "disable", () => doSetEnabled(context, false)) };
    case "discover":
      return { text: await guard(context, "discover", () => doDiscover(context)) };
    case "update":
      return { text: await guard(context, "update", () => doUpdate(context)) };
    default:
      throw new Error(`未知 action "${action}"；可选：${ACTIONS.join(" / ")}`);
  }
}

/**
 * 写操作失败时给出可读结果，而不是把异常抛给模型。
 * 异常信息同样会让模型看到，但少一层「工具报错」的噪声，也避免看起来像插件崩了。
 * 失败同时写进本地日志（设置页看不到，运维时 tail 日志即可）。
 */
async function guard(context, label, run) {
  try {
    return await run();
  } catch (error) {
    context.runtime.log?.warn?.("toolbox.failed", { action: label, error });
    return [`# ${label} 失败`, `- ${errorMessage(error)}`, "", "可以先用 action=list 确认 id 与现有条目。"].join("\n");
  }
}

function ensureAgentExec(exec) {
  if (!exec?.agent) throw new Error("toolbox 需要在一次 agent 会话内调用");
  return exec.agent;
}

function renderStatus({ runtime, exec }) {
  const agent = ensureAgentExec(exec);
  const skills = runtime.store.listSkills();
  const servers = runtime.store.listServers();
  const disabled = runtime.store.listDisabled();
  const loaded = runtime.injector.loaded(agent);
  const lines = [];
  lines.push(`# 懒工具箱状态`);
  lines.push(`数据目录：${runtime.store.root}`);
  const offSkills = skills.filter((skill) => disabled.skills.includes(skill.name));
  const offServers = servers.filter((server) => disabled.mcp.includes(server.name));
  const offNote = offSkills.length + offServers.length > 0 ? `（其中停用 ${offSkills.length + offServers.length} 个）` : "";
  lines.push(`skill：${skills.length} 个；MCP：${servers.length} 个${offNote}；本会话已加载：${loaded.length} 项`);
  if (loaded.length > 0) {
    lines.push("");
    lines.push("## 本会话已加载");
    for (const item of loaded) {
      lines.push(`- ${item.id}${item.names.length > 0 ? ` → ${item.names.join(", ")}` : ""}`);
    }
  }
  if (skills.length > 0) {
    lines.push("");
    lines.push("## skills");
    for (const skill of skills) {
      const off = disabled.skills.includes(skill.name) ? "（停用）" : "";
      lines.push(`- skill:${skill.name} — ${oneLine(skill.summary, 96)}${off}`);
    }
  }
  if (servers.length > 0) {
    lines.push("");
    lines.push("## mcp");
    for (const server of servers) {
      const off = disabled.mcp.includes(server.name) ? "（停用）" : "";
      lines.push(`- mcp:${server.name} — ${oneLine(server.summary, 96)}${off}`);
    }
  }
  return lines.join("\n");
}

async function renderList({ runtime, exec, args }) {
  const ids = Array.isArray(args?.ids) ? args.ids.map(String) : [];
  if (ids.length === 0) {
    // 只给目录：skill / mcp 分开，每条一句话用途，不带任何调用细节
    const agent = exec?.agent;
    const loaded = new Set(agent ? runtime.injector.loaded(agent).map((item) => item.id) : []);
    const skills = runtime.store.listSkills();
    const servers = runtime.store.listServers();
    const lines = ["# 目录"];
    if (skills.length === 0 && servers.length === 0) {
      lines.push("（插件库还是空的：用 add_skill / add_mcp 装东西，或让迁移把本机 skill 与 MCP 搬进来）");
      return lines.join("\n");
    }
    const offSkills = skills.filter((skill) => runtime.store.isDisabled("skill", skill.name));
    const offServers = servers.filter((server) => runtime.store.isDisabled("mcp", server.name));
    if (skills.length > 0) {
      lines.push("");
      lines.push("## skills");
      for (const skill of skills) {
        const off = runtime.store.isDisabled("skill", skill.name) ? "（设置里已关闭）" : "";
        const from = skill.external === true && skill.plugin ? ` 〔插件 ${skill.plugin}〕` : "";
        lines.push(`- skill:${skill.name} — ${oneLine(skill.summary, 96)}${from}${off}${loaded.has(`skill:${skill.name}`) ? " [已加载]" : ""}`);
      }
    }
    if (servers.length > 0) {
      lines.push("");
      lines.push("## mcp");
      for (const server of servers) {
        const count = server.toolCount ? `，${server.toolCount} 个工具` : "";
        const off = runtime.store.isDisabled("mcp", server.name) ? "（设置里已关闭）" : "";
        const from = server.external === true && server.plugin ? ` 〔插件 ${server.plugin}〕` : "";
        lines.push(`- mcp:${server.name} — ${oneLine(server.summary, 96)}${count}${from}${off}${loaded.has(`mcp:${server.name}`) ? " [已加载]" : ""}`);
      }
    }
    if (offSkills.length + offServers.length > 0) {
      lines.push("");
      lines.push("标着「设置里已关闭」的条目不会进系统提示的目录，也不能 load；让用户在 设置 → 懒工具箱 里打开。");
    }
    lines.push("");
    lines.push("展开某个 MCP 的工具清单：action=list, ids:[\"mcp:<服务>\"]");
    return lines.join("\n");
  }
  const lines = [];
  for (const rawId of ids) {
    const parsed = parseItemId(rawId);
    if (parsed.kind === "skill") {
      const skill = runtime.store.getSkill(parsed.name);
      if (!skill) {
        lines.push(`- ${rawId}：不存在`);
        continue;
      }
      lines.push(`- ${rawId} — ${oneLine(skill.summary, 96)}（来源：${skill.source ?? "?"}）`);
      continue;
    }
    if (parsed.kind === "mcp-server" || parsed.kind === "mcp-tool") {
      const server = parsed.kind === "mcp-server" ? parsed.name : parsed.server;
      if (!runtime.store.getServer(server)) {
        lines.push(`- ${rawId}：不存在`);
        continue;
      }
      try {
        const tools = await describeServerTools({ mcp: runtime.mcp, server });
        const filtered = parsed.kind === "mcp-tool" ? tools.filter((tool) => tool.id === rawId) : tools;
        if (filtered.length === 0) {
          lines.push(`- ${rawId}：服务没有这个工具`);
          continue;
        }
        lines.push(`- mcp:${server} 暴露 ${filtered.length} 个工具：`);
        for (const tool of filtered) {
          lines.push(`  - ${tool.id} — ${tool.summary}`);
        }
      } catch (error) {
        lines.push(`- ${rawId}：连接失败 ${errorMessage(error)}`);
      }
      continue;
    }
    lines.push(`- ${rawId}：无法识别`);
  }
  return lines.join("\n");
}

async function doLoad({ runtime, exec, args }) {
  const agent = ensureAgentExec(exec);
  const ids = Array.isArray(args?.ids) ? args.ids.map(String) : [];
  if (ids.length === 0) throw new Error("action=load 需要 ids");
  const report = await runtime.injector.load(agent, ids);
  runtime.log?.info?.("inject.load", {
    session: agent?.session?.id ?? agent?.id ?? "",
    items: report.map((item) => ({ id: item.id, ok: item.ok, tools: item.names?.length ?? 0, message: item.message })),
  });
  const lines = ["# 加载结果"];
  for (const item of report) {
    lines.push(`- ${item.id}：${item.ok ? "OK" : "失败"} — ${item.message}`);
    if (item.text) {
      lines.push("");
      lines.push(item.text);
    }
  }
  lines.push("");
  lines.push("提示：新工具定义从下一步开始生效；不再需要时调用 toolbox 的 unload。");
  return lines.join("\n");
}

function doUnload({ runtime, exec, args }) {
  const agent = ensureAgentExec(exec);
  const ids = args?.all === true ? "all" : Array.isArray(args?.ids) ? args.ids.map(String) : [];
  if (ids !== "all" && ids.length === 0) throw new Error("action=unload 需要 ids 或 all=true");
  const report = runtime.injector.unload(agent, ids);
  runtime.log?.info?.("inject.unload", {
    session: agent?.session?.id ?? agent?.id ?? "",
    items: report.map((item) => ({ id: item.id, ok: item.ok })),
  });
  const lines = ["# 卸载结果"];
  for (const item of report) lines.push(`- ${item.id}：${item.ok ? "OK" : "失败"} — ${item.message}`);
  if (report.length === 0) lines.push("（本会话没有已加载项）");
  return lines.join("\n");
}

/**
 * 开关条目（设置页里的那个开关，AI 也能用同一套动作调）。
 * 关掉 = 不进系统提示目录、不许 load；文件与配置都保留。
 */
function doSetEnabled({ runtime, args }, enabled) {
  const ids = Array.isArray(args?.ids) ? args.ids.map(String) : args?.id ? [String(args.id)] : [];
  if (ids.length === 0) throw new Error(`${enabled ? "enable" : "disable"} 需要 ids（如 ["skill:<名字>"] / ["mcp:<服务>"]）`);
  const lines = [enabled ? "# 已启用" : "# 已停用"];
  for (const rawId of ids) {
    const parsed = parseItemId(rawId);
    if (parsed.kind === "skill") {
      if (!runtime.store.getSkill(parsed.name)) {
        lines.push(`- ${rawId}：不存在`);
        continue;
      }
      const changed = runtime.store.setDisabled("skill", parsed.name, !enabled);
      lines.push(`- ${rawId}：${enabled ? "已打开" : "已关闭"}${changed ? "" : "（本来就是该状态）"}`);
      continue;
    }
    if (parsed.kind === "mcp-server") {
      if (!runtime.store.getServer(parsed.name)) {
        lines.push(`- ${rawId}：不存在`);
        continue;
      }
      const changed = runtime.store.setDisabled("mcp", parsed.name, !enabled);
      lines.push(`- ${rawId}：${enabled ? "已打开" : "已关闭"}${changed ? "" : "（本来就是该状态）"}`);
      continue;
    }
    lines.push(`- ${rawId}：只支持整个 skill 或整个 MCP 服务`);
  }
  lines.push("");
  lines.push(enabled ? "打开后它会重新出现在系统提示的目录里，可以 load。" : "关闭后它不再出现在目录里，也不能 load；文件与配置都还在，随时可以再打开。");
  return lines.join("\n");
}

async function doAddSkill({ runtime, exec, args }) {
  ensureAgentExec(exec);
  const summary = typeof args?.summary === "string" ? args.summary : "";
  const name = typeof args?.name === "string" ? args.name : "";
  const source = String(args?.path ?? "").trim();
  const url = String(args?.url ?? "").trim();
  if (!source && !url) throw new Error("add_skill 需要 path 或 url");

  let unitPath = "";
  let kind = "dir";
  let cleanup = () => {};
  if (source) {
    unitPath = await resolveCwd(runtime, exec, source);
    if (!exists(unitPath)) throw new Error(`路径不存在：${unitPath}`);
    kind = isDirectory(unitPath) ? "dir" : "file";
    if (kind === "file" && !unitPath.endsWith(".md")) throw new Error("add_skill 的 path 需要是目录或 .md 文件");
  } else {
    const fetched = await fetchSkillSource(url);
    unitPath = fetched.path;
    kind = fetched.kind;
    cleanup = fetched.cleanup;
  }
  try {
    const imported = importSkillUnit({
      store: runtime.store,
      unitPath,
      kind,
      source: "manual",
      name: name ? normalizeSkillName(name) : "",
      summary,
    });
    return [
      `# 已导入 skill`,
      `- id：skill:${imported.name}`,
      `- 一句话用途：${imported.summary}`,
      `- 存放：${path.join(runtime.store.skillsDir, imported.name)}`,
      "",
      `现在只需要在用到时用 toolbox 的 load 动作注入 skill:${imported.name} 的完整说明。`,
    ].join("\n");
  } finally {
    cleanup();
  }
}

async function fetchSkillSource(url) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lazy-toolbox-skill-"));
  const cleanup = () => rmrf(tmp);
  if (/^https?:\/\/.+\.md($|\?)/i.test(url) || /^https?:\/\/raw\./i.test(url)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
    const body = await response.text();
    const file = path.join(tmp, "SKILL.md");
    fs.writeFileSync(file, body, "utf8");
    return { path: file, kind: "file", cleanup };
  }
  const cloneDir = path.join(tmp, "repo");
  try {
    await execFileAsync("git", ["clone", "--depth", "1", url, cloneDir], { windowsHide: true, timeout: 120000 });
  } catch (error) {
    cleanup();
    throw new Error(`git clone 失败：${errorMessage(error)}`);
  }
  const candidate = findSkillDir(cloneDir);
  if (!candidate) {
    cleanup();
    throw new Error("仓库里没有找到 SKILL.md");
  }
  return { path: candidate, kind: "dir", cleanup };
}

function findSkillDir(root) {
  if (exists(path.join(root, "SKILL.md"))) return root;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(root, entry.name);
    if (exists(path.join(child, "SKILL.md"))) return child;
  }
  return "";
}

async function doAddMcp({ runtime, exec, args }) {
  ensureAgentExec(exec);
  const name = String(args?.name ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error("add_mcp 需要 name（1-32 位字母/数字/下划线/短横线）");
  if (runtime.store.getServer(name)) throw new Error(`MCP 服务 "${name}" 已存在`);
  const transport = args?.transport === "streamable-http" ? "streamable-http" : "stdio";
  const entry = {
    summary: oneLine(args?.summary || `${name} MCP 服务`, 96),
    transport,
    command: transport === "stdio" ? String(args?.command ?? "").trim() : "",
    args: Array.isArray(args?.args) ? args.args.map(String) : [],
    env: toStrMap(args?.env),
    cwd: typeof args?.cwd === "string" ? args.cwd : "",
    url: transport === "streamable-http" ? String(args?.url ?? "").trim() : "",
    headers: toStrMap(args?.headers),
    toolCallTimeoutMs: Number(args?.timeoutMs) > 0 ? Number(args.timeoutMs) : undefined,
    addedAt: nowIso(),
    source: "manual",
  };
  if (transport === "stdio" && !entry.command) throw new Error("stdio 传输需要 command");
  if (transport === "streamable-http" && !entry.url) throw new Error("streamable-http 传输需要 url");

  runtime.store.putServer(name, entry);
  try {
    const tools = await runtime.mcp.listTools(name, exec?.signal);
    const summary = oneLine(args?.summary || `${name} MCP 服务（${tools.length} 个工具）`, 96);
    const updated = runtime.store.getServer(name);
    runtime.store.putServer(name, { ...updated, summary, toolCount: tools.length });
    // 验证用的连接不常驻：真正 load 时会按需重连
    await runtime.mcp.closeServer(name);
    return [
      `# 已接入 MCP 服务`,
      `- id：mcp:${name}`,
      `- 一句话用途：${summary}`,
      `- 工具数：${tools.length}`,
      ...tools.slice(0, 20).map((tool) => `  - ${tool.name} — ${oneLine(tool.description, 70)}`),
      tools.length > 20 ? `  - …共 ${tools.length} 个` : "",
      "",
      `需要用时：toolbox load ids:["mcp:${name}"]（或 mcp:${name}:<tool> 只加载单个工具）。`,
    ].filter(Boolean).join("\n");
  } catch (error) {
    runtime.store.dropServer(name);
    await runtime.mcp.closeServer(name);
    throw new Error(`接入失败，已回滚：${errorMessage(error)}`);
  }
}

async function doRemove({ runtime, exec, args }) {
  ensureAgentExec(exec);
  // 兼容 ids:["skill:x"] 与单个 id:"skill:x"
  const ids = Array.isArray(args?.ids) ? args.ids.map(String) : typeof args?.id === "string" && args.id.trim() ? [args.id.trim()] : [];
  if (ids.length === 0) throw new Error("action=remove 需要 ids（如 ids:[\"skill:<name>\"]）");
  const lines = ["# 移除结果"];
  for (const rawId of ids) {
    const parsed = parseItemId(rawId);
    try {
      if (parsed.kind === "skill") {
        if (!isSkillName(parsed.name) || !runtime.store.getSkill(parsed.name)) {
          lines.push(`- ${rawId}：不存在`);
          continue;
        }
        const removed = deleteSkillFiles(runtime.store, parsed.name);
        const wasExternal = runtime.store.getSkill(parsed.name)?.external === true;
        runtime.store.dropSkill(parsed.name);
        if (wasExternal) runtime.store.setDisabled("skill", parsed.name, true);
        runtime.store.data.restore.skills = runtime.store.data.restore.skills.filter((item) => item.name !== parsed.name);
        runtime.store.save();
        lines.push(`- ${rawId}：${removed.external ? "已移除登记（文件在插件里，未动；之后扫描也不会再自动接管）" : "已删除文件与登记"}`);
      } else if (parsed.kind === "mcp-server") {
        if (!runtime.store.getServer(parsed.name)) {
          lines.push(`- ${rawId}：不存在`);
          continue;
        }
        const wasExternal = runtime.store.getServer(parsed.name)?.external === true;
        await runtime.mcp.closeServer(parsed.name);
        runtime.store.dropServer(parsed.name);
        if (wasExternal) runtime.store.setDisabled("mcp", parsed.name, true);
        lines.push(`- ${rawId}：已断开并删除配置${wasExternal ? "（之后扫描不会再自动接管；插件升级后想恢复，用 enable）" : ""}`);
      } else {
        lines.push(`- ${rawId}：只支持移除整个 skill 或整个 MCP 服务`);
      }
    } catch (error) {
      lines.push(`- ${rawId}：失败 ${errorMessage(error)}`);
    }
  }
  return lines.join("\n");
}

/**
 * 扫已安装插件里自带的 skill / MCP（`skills/`、`mcp.json`、`package.json` 的
 * `dsh.skills` / `dsh.mcp`），发现就登记进插件库。幂等，可反复调。
 */
function doDiscover({ runtime, exec, args }) {
  ensureAgentExec(exec);
  const dryRun = args?.dry_run === true;
  const result = discoverPluginAssets({
    store: runtime.store,
    profiles: listProfiles(dshHome()).filter((dir) => isProfileDir(dir)),
    dshHome: dshHome(),
    log: runtime.log,
    dryRun,
  });
  runtime.discoverState = { signature: dryRun ? runtime.discoverState?.signature ?? "" : result.signature };
  const lines = [`# 插件内置资产扫描${dryRun ? "（dry-run，未写入）" : ""}`, `- 看过 ${result.candidates} 个插件包`];
  if (result.skills.length > 0) {
    lines.push("", "## 新接管的 skill");
    for (const item of result.skills) lines.push(`- skill:${item.name} ← ${item.plugin}`);
  }
  if (result.servers.length > 0) {
    lines.push("", "## 新接管的 MCP");
    for (const item of result.servers) lines.push(`- mcp:${item.name} ← ${item.plugin}`);
  }
  if (result.pruned.length > 0) {
    lines.push("", "## 回收（插件已不存在）");
    for (const item of result.pruned) lines.push(`- ${item.kind}:${item.name}${item.plugin ? ` ← ${item.plugin}` : ""}`);
  }
  const reasons = (result.skipped ?? []).filter((item) => item.kind !== "plugin");
  if (reasons.length > 0 && result.skills.length + result.servers.length === 0) {
    lines.push("", "## 跳过的");
    for (const item of reasons.slice(0, 20)) lines.push(`- ${item.plugin} · ${item.path}：${item.reason}`);
  }
  if (result.skills.length + result.servers.length + result.pruned.length === 0) {
    lines.push("", "没有新东西：已装插件里没有未登记的内置 skill / MCP。");
  }
  lines.push("", "提示：这些条目和手动加的完全一样，可以 load / disable / remove。");
  return lines.join("\n");
}

/**
 * action=skill：按需拉取某个 skill 的某一节正文（大纲模式下的「要看详情」入口）。
 * 不带 section 就只回大纲；section:"all" 回整篇（带上限，避免把 3 万 token 一次灌爆）。
 */
function doSkillSection({ runtime, args }) {
  const ids = Array.isArray(args?.ids) ? args.ids.map(String) : typeof args?.id === "string" && args.id.trim() ? [args.id.trim()] : [];
  if (ids.length === 0) throw new Error('action=skill 需要 id（如 id:"skill:ds"）');
  const section = typeof args?.section === "string" ? args.section.trim() : "";
  const rows = [];
  for (const rawId of ids) {
    const parsed = parseItemId(rawId);
    if (parsed.kind !== "skill") {
      rows.push(`- ${rawId}：action=skill 只接受 skill:<名字>`);
      continue;
    }
    const entry = runtime.store.getSkill(parsed.name);
    if (!entry) {
      rows.push(`- ${rawId}：库里没有这个 skill`);
      continue;
    }
    if (runtime.store.isDisabled("skill", parsed.name)) {
      rows.push(`- ${rawId}：在设置里是「跳过」状态，先用 action=mode / enable 打开`);
      continue;
    }
    const skill = loadSkill(runtime.store, parsed.name);
    const outcome = readSection(skill.content, section);
    if (outcome.kind === "missing") {
      rows.push(`- ${rawId}：没有这一节 "${section}"；可选：${outcome.available.slice(0, 40).join(" / ") || "（该 skill 没有分节）"}`);
      continue;
    }
    if (outcome.kind === "outline") {
      rows.push(renderOutline(parsed.name, skill.summary, outcome.outline, { resourceDir: skill.resourceDir, loaded: true }));
      continue;
    }
    const limit = runtime.config?.skillSectionMaxChars ?? 60000;
    const text = outcome.text ?? "";
    const clipped = text.length > limit ? `${text.slice(0, limit)}\n\n…（本节还有 ${text.length - limit} 字符没显示，用 section:"all" 或读源文件）` : text;
    runtime.log?.info?.("skill.read", { name: parsed.name, section: section || "outline", chars: text.length, kind: outcome.kind });
    if (outcome.kind === "all") {
      rows.push(`# skill:${parsed.name} 全文（${skill.content.length} 字符 ≈ ${estimateTokens(skill.content.length)} token）`, "", clipped);
    } else {
      rows.push(`# skill:${parsed.name} · ${outcome.id} ${outcome.title}`, "", clipped);
    }
  }
  return rows.join("\n");
}

/** action=mode：设置某条目「懒加载 / 跳过」。skip 等价于设置页里关掉那个开关。 */
function doSetMode({ runtime, args }) {
  const mode = String(args?.mode ?? "").trim().toLowerCase();
  if (mode !== "lazy" && mode !== "skip") throw new Error('action=mode 需要 mode:"lazy" 或 mode:"skip"');
  const ids = Array.isArray(args?.ids) ? args.ids.map(String) : typeof args?.id === "string" && args.id.trim() ? [args.id.trim()] : [];
  if (ids.length === 0) throw new Error('action=mode 需要 ids（如 ids:["skill:ds"]）');
  const rows = [`# 加载方式 → ${mode === "skip" ? "跳过（不进目录，不许注入）" : "懒加载"}`];
  for (const rawId of ids) {
    try {
      setEnabledById(runtime, rawId, mode === "lazy");
      rows.push(`- ${rawId}：${mode}`);
    } catch (error) {
      rows.push(`- ${rawId}：失败 ${errorMessage(error)}`);
    }
  }
  return rows.join("\n");
}

/**
 * action=update：云更新三步（check / download / install）。
 * 装完只提示「重启 DSH」，插件不自己重启进程。
 */
async function doUpdate({ runtime, args }) {
  const updater = runtime.updater;
  if (!updater) throw new Error("更新管理器没有初始化");
  const step = String(args?.step ?? "check").trim().toLowerCase();
  if (step === "check") {
    const status = await updater.check({ force: true });
    const rows = [`# 云更新检查`, `- 仓库：${status.repo}`, `- 当前版本：${status.current}`, `- 最新版本：${status.latest || "（没查到）"}`];
    if (status.error) rows.push(`- 检查失败：${status.error}`);
    rows.push(`- 结论：${status.hasUpdate ? `有新版本 ${status.latest}，可以 action=update step=download` : "已是最新"}`);
    if (status.notes) rows.push("", "## 更新内容", status.notes);
    return rows.join("\n");
  }
  if (step === "download") {
    const status = await updater.download();
    const download = status.download ?? {};
    return [
      "# 已下载",
      `- 版本：${download.version ?? status.latest}`,
      `- 文件：${download.file ?? ""}（${download.size ?? 0} 字节）`,
      `- 解压到：${download.packageDir || "（解压失败，可手动解压）"}`,
      download.extractError ? `- 注意：${download.extractError}` : "",
      "",
      "下一步：action=update step=install 覆盖安装（会先备份现有文件），装完需要重启 DSH。",
    ].filter(Boolean).join("\n");
  }
  if (step === "install") {
    const status = await updater.install();
    const installed = status.installed ?? {};
    return [
      `# 已安装 ${installed.version ?? ""}`,
      `- 覆盖文件：${installed.files ?? 0} 项（node_modules / .git / 数据目录没动）`,
      `- 备份：${installed.backupDir ?? ""}`,
      "",
      "**请重启 DSH 让新版本生效**（关掉再打开；只刷新页面不够）。",
    ].join("\n");
  }
  throw new Error('action=update 的 step 只能是 "check" / "download" / "install"');
}

/**
 * 设置页的清单：skill 与 MCP 分列，带开关状态。
 * 和 AI 用 toolbox action=list 看到的是同一份 store 事实。
 */
export function inventoryForUi(runtime) {
  const store = runtime.store;
  const skills = store.listSkills().map((skill) => ({
    id: `skill:${skill.name}`,
    name: skill.name,
    summary: oneLine(skill.summary, 160),
    enabled: !store.isDisabled("skill", skill.name),
    source: skill.source ?? "",
    plugin: skill.plugin ?? "",
    external: skill.external === true,
  }));
  const mcp = store.listServers().map((server) => ({
    id: `mcp:${server.name}`,
    name: server.name,
    summary: oneLine(server.summary, 160),
    enabled: !store.isDisabled("mcp", server.name),
    transport: server.transport ?? "stdio",
    toolCount: server.toolCount ?? 0,
    source: server.source ?? "",
    plugin: server.plugin ?? "",
    external: server.external === true,
  }));
  return {
    skills,
    mcp,
    counts: {
      skills: skills.length,
      mcp: mcp.length,
      skillsOn: skills.filter((item) => item.enabled).length,
      mcpOn: mcp.filter((item) => item.enabled).length,
    },
  };
}

/** 设置页调用：打开/关闭某一项，返回最新清单。 */
export function setEnabledById(runtime, rawId, enabled) {
  const parsed = parseItemId(rawId);
  if (parsed.kind === "skill") {
    if (!runtime.store.getSkill(parsed.name)) throw new Error(`不存在 skill "${parsed.name}"`);
    runtime.store.setDisabled("skill", parsed.name, !enabled);
  } else if (parsed.kind === "mcp-server") {
    if (!runtime.store.getServer(parsed.name)) throw new Error(`不存在 MCP 服务 "${parsed.name}"`);
    runtime.store.setDisabled("mcp", parsed.name, !enabled);
    if (!enabled) void runtime.mcp.closeServer(parsed.name);
  } else {
    throw new Error(`只支持 skill:<名字> 或 mcp:<服务>，收到：${rawId}`);
  }
  return inventoryForUi(runtime);
}

function toStrMap(value) {  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
    else if (typeof item === "number" || typeof item === "boolean") out[key] = String(item);
  }
  return out;
}

function resolveCwd(runtime, exec, target) {
  if (path.isAbsolute(target)) return target;
  const base = runtime.workingDirectoryFor ? runtime.workingDirectoryFor(exec) : Promise.resolve(process.cwd());
  return Promise.resolve(base).then((dir) => path.resolve(dir || process.cwd(), target));
}
