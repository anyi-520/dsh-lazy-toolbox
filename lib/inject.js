/**
 * 按会话（agent）注入/卸载工具定义。
 *
 * DSH 的 tools 注册表按 agent 作用域分层：通过 `agent.ctx.tools.register()`
 * 注册的定义只对这一个会话可见，天然做到「不影响其他对话」。注入物随 agent
 * 的 ctx 生命周期自动销毁，我们额外保留 disposer 以便模型主动卸载。
 */
import { errorMessage, oneLine } from "./util.js";
import { buildMcpToolDefinition, publicToolName, toolSummary } from "./mcp.js";
import { loadSkill, renderSkillContent } from "./skills.js";
import { buildOutline, renderOutline } from "./outline.js";
import { listToolGroups, pickGroupTools } from "./tool-groups.js";

export function parseItemId(raw) {
  const id = String(raw ?? "").trim();
  if (id.startsWith("skill:")) return { kind: "skill", name: id.slice(6) };
  if (id.startsWith("mcp:")) {
    const rest = id.slice(4);
    const split = rest.indexOf(":");
    if (split < 0) return { kind: "mcp-server", name: rest };
    return { kind: "mcp-tool", server: rest.slice(0, split), tool: rest.slice(split + 1) };
  }
  if (id.startsWith("group:")) {
    const rest = id.slice(6);
    const split = rest.indexOf(":");
    if (split < 0) return { kind: "group", name: rest };
    return { kind: "group-tool", group: rest.slice(0, split), tool: rest.slice(split + 1) };
  }
  return { kind: "unknown", name: id };
}

export class Injector {
  constructor({ store, mcp, logger, skillInjectMode = "index" }) {
    this.store = store;
    this.mcp = mcp;
    this.logger = logger;
    /** "index"（默认，只注入大纲）| "full"（整篇注入） */
    this.skillInjectMode = skillInjectMode;
    this.byAgent = new WeakMap();
    this.bySession = new Map();
  }

  stateFor(agent) {
    let state = this.byAgent.get(agent);
    if (!state) {
      state = { items: new Map(), sessionId: agent?.session?.id ?? "" };
      this.byAgent.set(agent, state);
      if (state.sessionId) this.bySession.set(state.sessionId, agent);
    }
    return state;
  }

  /**
   * 把「可能是 agent、也可能是它的 scope ctx」统一解析成登记时用的 agent 对象。
   * 系统提示组装时传进来的 scope 有时是 agent 本身，有时是 agent.ctx，靠 session id 兜底。
   */
  resolveAgent(candidate) {
    if (!candidate || typeof candidate !== "object") return undefined;
    if (this.byAgent.has(candidate)) return candidate;
    if (candidate.agent && typeof candidate.agent === "object") return this.resolveAgent(candidate.agent);
    const sessionId = candidate.session?.id;
    if (sessionId) return this.bySession.get(sessionId);
    // 认不出来就当「未知会话」处理：宁可继续提醒，也不要误判成已加载
    return undefined;
  }

  loaded(agent) {
    const state = this.byAgent.get(this.resolveAgent(agent) ?? agent);
    if (!state) return [];
    return [...state.items.values()].map((item) => ({
      id: item.id,
      kind: item.kind,
      names: item.names ?? [],
      server: item.server,
    }));
  }

  isLoaded(agent, id) {
    return this.byAgent.get(this.resolveAgent(agent) ?? agent)?.items.has(id) ?? false;
  }

  ensureAgent(agent) {
    if (!agent) throw new Error("懒工具箱需要在一次 agent 会话里调用（当前没有 agent 上下文）");
    const scope = agent.ctx;
    if (!scope || typeof scope.tools?.register !== "function") {
      throw new Error("当前 agent 没有可用的 scoped ctx，无法按会话注入工具定义（可能运行在 PTC/受限模式）");
    }
    return scope;
  }

  async load(agent, rawIds) {
    const scope = this.ensureAgent(agent);
    const state = this.stateFor(agent);
    const report = [];
    for (const rawId of rawIds) {
      const parsed = parseItemId(rawId);
      if (parsed.kind === "unknown") {
        report.push({ id: rawId, ok: false, message: `无法识别的 id：${rawId}（应为 skill:<name> / mcp:<server>[:<tool>] / group:<插件组>[:<tool>]）` });
        continue;
      }
      if (state.items.has(rawId)) {
        report.push({ id: rawId, ok: true, message: "已经加载过了" });
        continue;
      }
      // 设置页里关掉的条目不许加载，避免「关了还在用」
      const disabledName = parsed.kind === "mcp-tool" ? parsed.server
        : parsed.kind === "group-tool" ? parsed.group
        : parsed.name;
      const disabledKind = parsed.kind === "skill" ? "skill"
        : parsed.kind === "group" || parsed.kind === "group-tool" ? "group"
        : "mcp";
      if (disabledName && this.store.isDisabled(disabledKind, disabledName)) {
        report.push({
          id: rawId,
          ok: false,
          message: `${disabledKind === "skill" ? "skill" : disabledKind === "group" ? "插件工具组" : "MCP 服务"} "${disabledName}" 在设置页里是关闭状态；先在 设置 → 懒工具箱 里打开，或让用户改用 toolbox 的 enable 动作`,
        });
        continue;
      }
      try {
        if (parsed.kind === "skill") {
          const skill = loadSkill(this.store, parsed.name);
          // 注入方式：默认「大纲模式」——只给骨架 + 每节一句话，正文按需拉取。
          // 某些 skill（很短的、必须整篇照做的）可以在 store 里写 loadMode:"full" 或
          // 全局 config.skillInjectMode 改成 full。
          const mode = skill.entry?.loadMode ?? this.skillInjectMode ?? "index";
          if (mode === "full") {
            state.items.set(rawId, { id: rawId, kind: "skill", names: [], mode: "full", content: skill.content });
            report.push({
              id: rawId,
              ok: true,
              message: `已注入 skill 全文（${skill.summary}，${skill.content.length} 字符）`,
              text: renderSkillContent(skill),
            });
            continue;
          }
          const outline = buildOutline(skill.content);
          const text = renderOutline(parsed.name, skill.summary, outline, { resourceDir: skill.resourceDir });
          state.items.set(rawId, {
            id: rawId,
            kind: "skill",
            names: [],
            mode: "index",
            outline,
            content: skill.content,
            chars: skill.content.length,
          });
          report.push({
            id: rawId,
            ok: true,
            message: `已注入 skill 大纲（${outline.branches.length} 个分支，正文 ${skill.content.length} 字符没有整篇塞进来）`,
            text,
          });
          continue;
        }
        if (parsed.kind === "group" || parsed.kind === "group-tool") {
          const groupId = parsed.kind === "group-tool" ? parsed.group : parsed.name;
          const all = pickGroupTools(groupId);
          if (!all) {
            report.push({ id: rawId, ok: false, message: `没有名为 "${groupId}" 的插件工具组（先用 action=list 看有哪些）` });
            continue;
          }
          const wanted = parsed.kind === "group-tool" ? pickGroupTools(groupId, [parsed.tool]) : all;
          if (!wanted || wanted.length === 0) {
            report.push({ id: rawId, ok: false, message: `工具组 "${groupId}" 里没有工具 "${parsed.tool}"` });
            continue;
          }
          const disposers = [];
          const names = [];
          try {
            for (const tool of wanted) {
              disposers.push(scope.tools.register({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                output: tool.output,
                execute: (args) => tool.execute(args ?? {}),
              }));
              names.push(tool.name);
            }
          } catch (error) {
            for (const dispose of disposers) {
              try {
                dispose();
              } catch {
                /* ignore */
              }
            }
            throw error;
          }
          state.items.set(rawId, { id: rawId, kind: "group", server: groupId, names, disposers });
          report.push({
            id: rawId,
            ok: true,
            message: `已注入 ${names.length} 个插件工具，下一步即可直接调用：${names.join(", ")}`,
          });
          continue;
        }
        const tools = await this.mcp.listTools(parsed.kind === "mcp-tool" ? parsed.server : parsed.name, undefined);
        const wanted = parsed.kind === "mcp-tool" ? tools.filter((tool) => tool.name === parsed.tool) : tools;
        if (wanted.length === 0) {
          report.push({
            id: rawId,
            ok: false,
            message: parsed.kind === "mcp-tool"
              ? `服务 "${parsed.server}" 没有暴露工具 "${parsed.tool}"`
              : `服务 "${parsed.name}" 没有暴露任何工具`,
          });
          continue;
        }
        const disposers = [];
        const names = [];
        try {
          for (const tool of wanted) {
            const definition = buildMcpToolDefinition({ manager: this.mcp, serverName: parsed.kind === "mcp-tool" ? parsed.server : parsed.name, tool });
            disposers.push(scope.tools.register(definition));
            names.push(definition.name);
          }
        } catch (error) {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              /* ignore */
            }
          }
          throw error;
        }
        const server = parsed.kind === "mcp-tool" ? parsed.server : parsed.name;
        this.mcp.retain(server);
        state.items.set(rawId, { id: rawId, kind: "mcp", server, names, disposers });
        report.push({
          id: rawId,
          ok: true,
          message: `已注入 ${names.length} 个工具定义，下一步即可直接调用：${names.join(", ")}`,
        });
      } catch (error) {
        report.push({ id: rawId, ok: false, message: errorMessage(error) });
      }
    }
    return report;
  }

  unload(agent, rawIds) {
    const state = this.byAgent.get(agent);
    if (!state) return [];
    const ids = rawIds === undefined || rawIds === "all" ? [...state.items.keys()] : rawIds;
    const report = [];
    for (const rawId of ids) {
      const item = state.items.get(rawId);
      if (!item) {
        report.push({ id: rawId, ok: true, message: "本来就没有加载" });
        continue;
      }
      try {
        for (const dispose of item.disposers ?? []) dispose();
        if (item.server) this.mcp.release(item.server);
        state.items.delete(rawId);
        report.push({
          id: rawId,
          ok: true,
          message: item.kind === "skill"
            ? "已从本会话的加载状态里移除（正文早已进入对话历史，不会重复注入）"
            : "已从本会话的工具定义里移除",
        });
      } catch (error) {
        report.push({ id: rawId, ok: false, message: errorMessage(error) });
      }
    }
    return report;
  }

  unloadAllForSession(sessionId) {
    const agent = this.bySession.get(sessionId);
    if (!agent) return;
    this.unload(agent, "all");
    this.bySession.delete(sessionId);
  }

  unloadAll() {
    for (const agent of this.bySession.values()) this.unload(agent, "all");
    this.bySession.clear();
  }

  /** 目录里「已加载」的简短标记。 */
  loadedSummary(agent) {
    const loaded = this.loaded(agent);
    if (loaded.length === 0) return "";
    return loaded
      .map((item) => `${item.id}${item.names.length > 0 ? `（${item.names.length} 个工具）` : ""}`)
      .join("、");
  }
}

/**
 * 插件工具组的目录行（第三个分类）。
 * 和 skill / MCP 一样只给「一条用途 + 工具名清单」，不给参数 schema。
 */
export function catalogGroupLines({ store, agent, injector }) {
  const loaded = new Set(injector.loaded(agent).map((item) => item.id));
  const groups = listToolGroups().filter((group) => !store.isDisabled("group", group.id));
  const lines = [];
  for (const group of groups) {
    const plugin = group.plugin ? `〔插件 ${group.plugin}〕` : "";
    lines.push(
      `- group:${group.id} — ${oneLine(group.summary, 96)}${plugin}，${group.toolCount} 个工具：${oneLine(group.toolNames.join(", "), 180)}` +
        `${loaded.has(`group:${group.id}`) ? " [已加载]" : ""}`,
    );
  }
  return lines;
}

/** 目录行：一句话说明，不给调用方式。设置页里关掉的条目不出现在目录里。 */
export function catalogLines({ store, mcp, agent, injector }) {
  const loaded = new Set(injector.loaded(agent).map((item) => item.id));
  const skills = store.listSkills().filter((skill) => !store.isDisabled("skill", skill.name));
  const servers = store.listServers().filter((server) => !store.isDisabled("mcp", server.name));
  const lines = [];
  if (skills.length === 0 && servers.length === 0) {
    const total = store.listSkills().length + store.listServers().length;
    lines.push(
      total === 0
        ? "（空：还没有任何 skill 或 MCP，可用 toolbox 的 add 动作导入）"
        : "（库里所有条目都在设置页里被关掉了：要用的请先在 设置 → 懒工具箱 打开）",
    );
    return lines;
  }
  if (skills.length > 0) {
    lines.push("skills:");
    for (const skill of skills) {
      lines.push(`- skill:${skill.name} — ${oneLine(skill.summary, 96)}${loaded.has(`skill:${skill.name}`) ? " [已加载]" : ""}`);
    }
  }
  if (servers.length > 0) {
    lines.push("mcp:");
    for (const server of servers) {
      const count = server.toolCount ? `，${server.toolCount} 个工具` : "";
      lines.push(`- mcp:${server.name} — ${oneLine(server.summary, 96)}${count}${loaded.has(`mcp:${server.name}`) ? " [已加载]" : ""}`);
    }
  }
  return lines;
}

/** 展开一个 MCP 服务的工具清单（一句话说明，仍然不给参数 schema）。 */
export async function describeServerTools({ mcp, server }) {
  const tools = await mcp.listTools(server);
  return tools.map((tool) => ({
    id: `mcp:${server}:${tool.name}`,
    publicName: publicToolName(server, tool.name),
    summary: toolSummary(tool),
  }));
}
