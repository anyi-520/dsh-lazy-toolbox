/**
 * 插件内置资产的自动接管。
 *
 * 有不少插件自己就带 skill 或 MCP 服务（`skills/` 目录、`mcp.json`、
 * 或者 `package.json` 里的 `dsh.skills` / `dsh.mcp`）。这些能力如果直接用，
 * 要么散落在各插件目录里没人知道，要么被 DSH 全量塞进工具定义。
 *
 * 这里做两件事：
 *   1. **发现**：扫 profile 已安装的插件包（只扫一层 node_modules，不递归依赖）与
 *      `$DSH_HOME/plugins/*`，读 manifest 与约定目录/文件；
 *   2. **接管**：把找到的 skill 以「**原地引用**」的方式登记进插件库（不复制、不搬动，
 *      插件升级后内容自然跟着变），MCP 服务登记成可懒加载的条目。
 *
 * 设计约束：
 *   - 只读插件目录，绝不写、不删插件里的文件（`external: true` 的条目在删除时被保护）；
 *   - 幂等：同名条目已存在就跳过，重复扫描不会重复登记；
 *   - 插件被卸载后，下一轮扫描把对应条目回收（`prune`）。
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir, exists, hashOf, isDirectory, nowIso, oneLine, readJson, readText } from "./util.js";
import { normalizeSkillName } from "./skills.js";
import { matchNeverLazy } from "./denylist.js";

/** 约定俗成的内置位置（按优先级）。 */
const SKILL_DIRS = ["skills", path.join("dsh", "skills"), path.join(".dsh", "skills")];
const MCP_FILES = ["mcp.json", path.join(".dsh", "mcp.json"), path.join("dsh", "mcp.json"), "mcp-servers.json"];

/** 把一个 MCP 配置条目规范成插件库能用的形状。 */
export function normalizeServerConfig(raw, { plugin = "" } = {}) {
  if (!raw || typeof raw !== "object") return undefined;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!url && !command) return undefined;
  const transport = url
    ? String(raw.transport ?? raw.type ?? "streamable-http").includes("sse")
      ? "sse"
      : "streamable-http"
    : "stdio";
  const env = {};
  if (raw.env && typeof raw.env === "object") {
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof value === "string") env[key] = value;
    }
  }
  const headers = {};
  if (raw.headers && typeof raw.headers === "object") {
    for (const [key, value] of Object.entries(raw.headers)) {
      if (typeof value === "string") headers[key] = value;
    }
  }
  return {
    summary: oneLine(String(raw.summary ?? raw.description ?? (plugin ? `${plugin} 内置的 MCP 服务` : "插件内置的 MCP 服务")), 200),
    transport,
    command,
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env,
    cwd: typeof raw.cwd === "string" ? raw.cwd : "",
    url,
    headers,
    ...(Number.isFinite(Number(raw.toolCallTimeoutMs)) ? { toolCallTimeoutMs: Number(raw.toolCallTimeoutMs) } : {}),
    source: "plugin",
    plugin,
  };
}

/** 收集候选插件包目录（一层 node_modules + $DSH_HOME/plugins）。 */
export function pluginCandidates({ profiles = [], dshHome = "" } = {}) {
  const found = [];
  const push = (dir, scope) => {
    const pkgFile = path.join(dir, "package.json");
    if (!exists(pkgFile)) return;
    const pkg = readJson(pkgFile, undefined);
    if (!pkg || typeof pkg !== "object") return;
    found.push({ dir, scope, name: typeof pkg.name === "string" ? pkg.name : path.basename(dir), pkg, pkgFile });
  };
  for (const profileDir of profiles) {
    const modules = path.join(profileDir, "node_modules");
    if (!isDirectory(modules)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(modules, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(modules, entry.name);
      if (entry.name.startsWith("@")) {
        // scope 包：往里再看一层
        let scoped = [];
        try {
          scoped = fs.readdirSync(full, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const inner of scoped) {
          if (!inner.isDirectory() && !inner.isSymbolicLink()) continue;
          push(path.join(full, inner.name), "profile");
        }
        continue;
      }
      push(full, "profile");
    }
  }
  if (dshHome) {
    const pluginsDir = path.join(dshHome, "plugins");
    if (isDirectory(pluginsDir)) {
      let entries = [];
      try {
        entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (entry.name.startsWith(".")) continue;
        push(path.join(pluginsDir, entry.name), "dsh-home");
      }
    }
  }
  return found;
}

/** 从一个插件包里找出内置 skill 与 MCP 服务（只读）。 */
export function detectPluginAssets(candidate) {
  const { dir, pkg, name: packageName } = candidate;
  const manifest = pkg.dsh && typeof pkg.dsh === "object" ? pkg.dsh : {};
  const skills = [];
  const servers = [];
  const skipped = [];

  // ---- skill：manifest 优先，其次约定目录 ----
  const declaredSkills = [];
  for (const value of [manifest.skills, manifest.skill, pkg.dshSkills]) {
    if (typeof value === "string" && value.trim()) declaredSkills.push(value.trim());
    else if (Array.isArray(value)) for (const item of value) if (typeof item === "string" && item.trim()) declaredSkills.push(item.trim());
  }
  const skillDirs = [];
  for (const relative of declaredSkills) skillDirs.push(path.join(dir, relative));
  if (declaredSkills.length === 0) for (const relative of SKILL_DIRS) skillDirs.push(path.join(dir, relative));

  const seen = new Set();
  for (const skillDir of skillDirs) {
    if (!isDirectory(skillDir) || seen.has(skillDir)) continue;
    seen.add(skillDir);
    // 情况 A：目录自己就是 skill
    if (exists(path.join(skillDir, "SKILL.md"))) {
      const unit = readSkillUnitSummary(skillDir);
      if (unit) skills.push({ ...unit, dir: skillDir, plugin: packageName });
      else skipped.push({ kind: "skill", plugin: packageName, path: skillDir, reason: "SKILL.md 为空" });
      continue;
    }
    // 情况 B：目录下每个子目录是一个 skill
    let entries = [];
    try {
      entries = fs.readdirSync(skillDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;
      const unitDir = path.join(skillDir, entry.name);
      if (!exists(path.join(unitDir, "SKILL.md"))) continue;
      const unit = readSkillUnitSummary(unitDir);
      if (unit) skills.push({ ...unit, dir: unitDir, plugin: packageName });
      else skipped.push({ kind: "skill", plugin: packageName, path: unitDir, reason: "SKILL.md 为空" });
    }
  }

  // ---- MCP：manifest 优先，其次 mcp.json 之类 ----
  const manifestServers = manifest.mcpServers ?? manifest.mcp ?? pkg.mcpServers ?? pkg.mcp;
  if (manifestServers && typeof manifestServers === "object") {
    for (const [serverName, config] of Object.entries(manifestServers)) {
      const normalized = normalizeServerConfig(config, { plugin: packageName });
      if (normalized) servers.push({ name: serverName, config: normalized });
      else skipped.push({ kind: "mcp", plugin: packageName, path: `package.json#${serverName}`, reason: "缺少 command 或 url" });
    }
  } else {
    for (const relative of MCP_FILES) {
      const file = path.join(dir, relative);
      if (!exists(file)) continue;
      const data = readJson(file, undefined);
      const table = data && typeof data === "object" ? (data.mcpServers ?? data.servers ?? data) : undefined;
      if (!table || typeof table !== "object") {
        skipped.push({ kind: "mcp", plugin: packageName, path: file, reason: "不是可解析的 MCP 配置" });
        continue;
      }
      for (const [serverName, config] of Object.entries(table)) {
        if (serverName === "version" || serverName === "$schema") continue;
        const normalized = normalizeServerConfig(config, { plugin: packageName });
        if (normalized) servers.push({ name: serverName, config: normalized });
        else skipped.push({ kind: "mcp", plugin: packageName, path: `${file}#${serverName}`, reason: "缺少 command 或 url" });
      }
      break; // 一个包只用第一个命中的配置文件
    }
  }

  return { skills, servers, skipped };
}

/** 读 SKILL.md 的 frontmatter，拿到名字与一句话说明。 */
function readSkillUnitSummary(unitDir) {
  const raw = readText(path.join(unitDir, "SKILL.md"), "");
  if (!raw.trim()) return undefined;
  const head = raw.startsWith("---") ? raw.slice(3, raw.indexOf("\n---", 3) + 1) : "";
  const pick = (key) => {
    const matched = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m").exec(head);
    if (!matched) return "";
    return matched[1].trim().replace(/^["']|["']$/g, "");
  };
  const declared = pick("name");
  const summary = pick("description") || pick("whenToUse") || pick("summary");
  const name = normalizeSkillName(declared, path.basename(unitDir));
  if (!name) return undefined;
  return { name, declared, summary: oneLine(summary || `${path.basename(unitDir)} skill`, 300) };
}

/** 给候选集合算一个廉价指纹：目录名 + package.json 的 mtime/size。 */
export function pluginSignature(candidates) {
  const rows = candidates
    .map((candidate) => {
      let stamp = "";
      try {
        const stat = fs.statSync(candidate.pkgFile);
        stamp = `${Math.round(stat.mtimeMs)}:${stat.size}`;
      } catch {
        stamp = "?";
      }
      return `${candidate.scope}|${candidate.name}|${candidate.dir}|${stamp}`;
    })
    .sort();
  return hashOf(rows.join("\n"));
}

/**
 * 扫描并接管插件内置资产。
 * @returns {{ skills: object[], servers: object[], skipped: object[], pruned: object[], changed: boolean }}
 */
export function discoverPluginAssets({
  store,
  profiles = [],
  dshHome = "",
  log = null,
  dryRun = false,
  state = null,
  neverLazy = {},
}) {
  const candidates = pluginCandidates({ profiles, dshHome });
  const signature = pluginSignature(candidates);
  if (state && state.signature === signature && !dryRun) {
    return { skills: [], servers: [], skipped: [], pruned: [], blocked: [], changed: false, signature };
  }

  const importedSkills = [];
  const importedServers = [];
  const skipped = [];
  const blockedPlugins = [];
  // 用户明确关掉/移除过的条目不再自动接管（尊重人的意图，别让扫描把你删掉的又复活）
  const disabled = typeof store.listDisabled === "function" ? store.listDisabled() : { skills: [], mcp: [] };

  for (const candidate of candidates) {
    if (candidate.pkg?.dsh?.autoDetect === false) continue;
    // 「破甲插件」名单：这类插件自己会 hook 注入系统提示词/提示词 skill，
    // 懒工具箱再接管一份就是双重注入，还容易被一句用途骗进上下文 —— 直接不碰。
    const verdict = matchNeverLazy(candidate.name, neverLazy);
    if (verdict.blocked) {
      blockedPlugins.push({ plugin: candidate.name, matched: verdict.matched });
      log?.info?.("discover.blocked", { plugin: candidate.name, matched: verdict.matched });
      continue;
    }
    let assets = { skills: [], servers: [], skipped: [] };
    try {
      assets = detectPluginAssets(candidate);
    } catch (error) {
      skipped.push({ kind: "plugin", plugin: candidate.name, path: candidate.dir, reason: String(error?.message ?? error) });
      continue;
    }
    skipped.push(...assets.skipped);

    for (const found of assets.skills) {
      if (disabled.skills?.includes(found.name)) {
        skipped.push({ kind: "skill", plugin: candidate.name, path: found.dir, reason: "在设置里被关掉了，跳过自动接管" });
        continue;
      }
      const existing = store.getSkill(found.name);
      if (existing) {
        const samePlugin = existing.external === true && path.resolve(existing.origin ?? "") === path.resolve(found.dir);
        if (!samePlugin) skipped.push({ kind: "skill", plugin: candidate.name, path: found.dir, reason: `skill 名 "${found.name}" 已被 ${existing.plugin ?? existing.source ?? "其他来源"} 占用` });
        continue;
      }
      if (!dryRun) {
        store.putSkill(found.name, {
          summary: found.summary,
          // 原地引用：不复制文件，插件升级后内容自动跟着更新
          storePath: path.relative(store.root, found.dir).replace(/\\/g, "/"),
          origin: found.dir,
          external: true,
          plugin: candidate.name,
          source: "plugin",
          discoveredAt: nowIso(),
        });
      }
      importedSkills.push({ name: found.name, plugin: candidate.name, path: found.dir });
    }

    for (const found of assets.servers) {
      if (disabled.mcp?.includes(found.name)) {
        skipped.push({ kind: "mcp", plugin: candidate.name, path: found.name, reason: "在设置里被关掉了，跳过自动接管" });
        continue;
      }
      if (store.getServer(found.name)) {
        skipped.push({ kind: "mcp", plugin: candidate.name, path: found.name, reason: `MCP 服务名 "${found.name}" 已存在` });
        continue;
      }
      if (!dryRun) {
        store.putServer(found.name, { ...found.config, external: true, plugin: candidate.name, discoveredAt: nowIso() });
      }
      importedServers.push({ name: found.name, plugin: candidate.name });
    }
  }

  // 回收：插件没了（或不再提供该资产）→ 把 external 条目删掉
  // 另外：命中「破甲插件」名单的插件，之前版本可能已经接管过，这里一并撤掉登记（不删插件文件）
  const pruned = [];
  const isBlocked = (plugin) => (plugin ? matchNeverLazy(plugin, neverLazy).blocked : false);
  for (const skill of store.listSkills()) {
    if (skill.external !== true) continue;
    if (isBlocked(skill.plugin)) {
      pruned.push({ kind: "skill", name: skill.name, plugin: skill.plugin, reason: "在该名单里" });
      if (!dryRun) store.dropSkill(skill.name);
      continue;
    }
    if (skill.origin && exists(skill.origin)) continue;
    pruned.push({ kind: "skill", name: skill.name, plugin: skill.plugin ?? "" });
    if (!dryRun) store.dropSkill(skill.name);
  }
  for (const server of store.listServers()) {
    if (server.external !== true) continue;
    if (isBlocked(server.plugin)) {
      pruned.push({ kind: "mcp", name: server.name, plugin: server.plugin, reason: "在该名单里" });
      if (!dryRun) store.dropServer(server.name);
      continue;
    }
    const candidate = candidates.find((item) => item.name === server.plugin);
    if (candidate) continue;
    pruned.push({ kind: "mcp", name: server.name, plugin: server.plugin ?? "" });
    if (!dryRun) store.dropServer(server.name);
  }

  const changed = importedSkills.length > 0 || importedServers.length > 0 || pruned.length > 0;
  if (state) state.signature = dryRun ? state.signature : signature;
  if (changed) {
    log?.info?.("discover.plugin", {
      candidates: candidates.length,
      skills: importedSkills.map((item) => `${item.name}@${item.plugin}`),
      mcp: importedServers.map((item) => `${item.name}@${item.plugin}`),
      pruned: pruned.map((item) => `${item.kind}:${item.name}`),
      blocked: blockedPlugins.map((item) => item.plugin),
      dryRun,
    });
  }
  return {
    skills: importedSkills,
    servers: importedServers,
    skipped,
    pruned,
    blocked: blockedPlugins,
    changed,
    signature,
    candidates: candidates.length,
  };
}
