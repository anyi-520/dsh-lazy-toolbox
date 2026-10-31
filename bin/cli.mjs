#!/usr/bin/env node
/**
 * dsh-lazy-toolbox 的命令行：安装/卸载辅助、状态、迁移与还原。
 *
 *   dsh-lazy-toolbox status
 *   dsh-lazy-toolbox list
 *   dsh-lazy-toolbox migrate [--dry-run]
 *   dsh-lazy-toolbox restore [--skills-only|--mcp-only]
 *   dsh-lazy-toolbox add-skill <path> [--name <n>] [--summary <s>]
 *   dsh-lazy-toolbox add-mcp <name> --command <cmd> [--args "a b"] [--summary <s>]
 *   dsh-lazy-toolbox remove <id>
 *   dsh-lazy-toolbox logs [--lines 100] [--path]
 *   dsh-lazy-toolbox wire-profile [--profile <dir>]
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Store, defaultDataDir } from "../lib/store.js";
import { McpManager } from "../lib/mcp.js";
import { PluginLog } from "../lib/log.js";
import { UpdateManager } from "../lib/update.js";
import {
  migrateMcpFromProfiles,
  migrateSkillsFromRoots,
  restoreMcpProfiles,
  restoreSkillUnits,
} from "../lib/migrate.js";
import {
  ensureProfileBodyInsert,
  ensureProfileBundles,
  ensureProfileLink,
  isProfileDir,
  listProfiles,
  removeProfileBodyInsert,
  removeProfileBundles,
  removeProfileLink,
} from "../lib/profile.js";
import { deleteSkillFiles, importSkillUnit, isSkillName, loadSkill, skillRoots } from "../lib/skills.js";
import { readSection, renderOutline } from "../lib/outline.js";
import { discoverPluginAssets } from "../lib/discover.js";
import { agentsHome, dshHome, errorMessage, exists, isDirectory, oneLine, readJson } from "../lib/util.js";

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() ?? "status";
  const positional = [];
  const flags = {};
  while (args.length > 0) {
    const item = args.shift();
    if (item.startsWith("--")) {
      const key = item.slice(2);
      const next = args[0];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = args.shift();
      } else {
        flags[key] = true;
      }
      continue;
    }
    positional.push(item);
  }
  return { command, positional, flags };
}

function storeFromFlags(flags) {
  const dataDir = typeof flags["data-dir"] === "string" ? path.resolve(flags["data-dir"]) : defaultDataDir();
  return new Store(dataDir);
}

function profilesFromFlags(flags) {
  if (typeof flags.profile === "string") return [path.resolve(flags.profile)].filter(isProfileDir);
  return listProfiles(dshHome()).filter(isProfileDir);
}

function print(line = "") {
  process.stdout.write(`${line}\n`);
}

function cmdStatus(store) {
  print(`数据目录: ${store.root}`);
  print(`skill: ${store.listSkills().length}`);
  for (const skill of store.listSkills()) {
    const off = store.isDisabled("skill", skill.name) ? "（已关闭）" : "";
    print(`  - skill:${skill.name} — ${oneLine(skill.summary, 96)}${off}`);
  }
  print(`mcp: ${store.listServers().length}`);
  for (const server of store.listServers()) {
    const off = store.isDisabled("mcp", server.name) ? "（已关闭）" : "";
    print(`  - mcp:${server.name} — ${oneLine(server.summary, 96)} (${server.transport})${off}`);
  }
  const restore = store.data.restore;
  print(`待还原: skill ${restore.skills.length} 个 / profile ${Object.keys(restore.profiles).length} 个`);
}

function cmdToggle(store, positional, enabled) {
  if (positional.length === 0) throw new Error(`用法：${enabled ? "enable" : "disable"} skill:<名字> / mcp:<服务>`);
  for (const rawId of positional) {
    const [kind, ...rest] = rawId.split(":");
    const name = rest.join(":");
    if (kind === "skill") {
      if (!store.getSkill(name)) throw new Error(`没有 skill:${name}`);
      store.setDisabled("skill", name, !enabled);
    } else if (kind === "mcp") {
      if (!store.getServer(name)) throw new Error(`没有 mcp:${name}`);
      store.setDisabled("mcp", name, !enabled);
    } else {
      throw new Error(`不认识的 id：${rawId}（应为 skill:<名字> 或 mcp:<服务>）`);
    }
    print(`${rawId}: ${enabled ? "已打开" : "已关闭"}`);
  }
}

/** 设置加载方式：lazy（懒加载，进目录）| skip（跳过，不进目录、不许注入）。 */
function cmdMode(store, positional) {
  const [rawId, mode] = positional;
  if (!rawId || !mode) throw new Error("用法：mode skill:<名字>|mcp:<服务> lazy|skip");
  if (mode !== "lazy" && mode !== "skip") throw new Error('mode 只能是 "lazy" 或 "skip"');
  const [kind, ...rest] = rawId.split(":");
  const name = rest.join(":");
  if (kind === "skill") {
    if (!store.getSkill(name)) throw new Error(`没有 skill:${name}`);
    store.setDisabled("skill", name, mode === "skip");
  } else if (kind === "mcp") {
    if (!store.getServer(name)) throw new Error(`没有 mcp:${name}`);
    store.setDisabled("mcp", name, mode === "skip");
  } else {
    throw new Error(`不认识的 id：${rawId}（应为 skill:<名字> 或 mcp:<服务>）`);
  }
  print(`${rawId}: ${mode}`);
}

/** 看 skill 的大纲；`--section <id>` 取某一节全文，`--section all` 整篇。 */
function cmdSkill(store, positional, flags) {
  const name = positional[0];
  if (!name) throw new Error("用法：skill <名字> [--section <id>|all]");
  store.getSkill(name) ?? (() => {
    throw new Error(`没有 skill:${name}`);
  })();
  const skill = loadSkill(store, name);
  const section = typeof flags.section === "string" ? flags.section : "";
  const outcome = readSection(skill.content, section);
  if (outcome.kind === "missing") throw new Error(`没有这一节 "${section}"；可选：${outcome.available.join(" / ")}`);
  if (outcome.kind === "outline") {
    print(renderOutline(name, skill.summary, outcome.outline, { resourceDir: skill.resourceDir }));
    return;
  }
  print(`# ${name} · ${outcome.kind === "all" ? "全文" : `${outcome.id} ${outcome.title}`}`);
  print("");
  print(outcome.text.trimEnd());
  if (outcome.kind === "all") print(`\n（整篇 ${skill.content.length} 字符）`);
}

/** 云更新：check / download / install。 */
async function cmdUpdate(store, positional) {
  const step = String(positional[0] ?? "check").toLowerCase();
  const pkg = readJson(new URL("../package.json", import.meta.url), { version: "0.0.0" });
  const updater = new UpdateManager({
    root: store.root,
    config: { updateRepo: process.env.LAZY_TOOLBOX_REPO || "anyi-520/dsh-lazy-toolbox" },
    currentVersion: pkg.version ?? "0.0.0",
    log: new PluginLog({ dir: path.join(store.root, "logs") }),
    logger: console,
  });
  if (step === "check") {
    const status = await updater.check({ force: true });
    print(`仓库: ${status.repo}`);
    print(`当前: ${status.current}  最新: ${status.latest || "?"}`);
    if (status.error) print(`失败: ${status.error}`);
    print(status.hasUpdate ? `有新版本 ${status.latest}（下一步 update download）` : "已是最新");
    if (status.notes) {
      print("");
      print(status.notes);
    }
    return;
  }
  if (step === "download") {
    const status = await updater.download();
    print(`版本: ${status.download?.version ?? "?"}`);
    print(`文件: ${status.download?.file ?? ""}`);
    print(`解压: ${status.download?.packageDir || "失败（需手动解压）"}`);
    return;
  }
  if (step === "install") {
    const status = await updater.install();
    print(`已安装: ${status.installed?.version ?? "?"}（${status.installed?.files ?? 0} 项）`);
    print(`备份: ${status.installed?.backupDir ?? ""}`);
    print("请重启 DSH 让新版本生效。");
    return;
  }
  throw new Error("用法：update [check|download|install]");
}

function cmdList(store) {
  for (const skill of store.listSkills()) {
    const off = store.isDisabled("skill", skill.name) ? "\t[off]" : "";
    print(`skill:${skill.name}\t${oneLine(skill.summary, 120)}${off}`);
  }
  for (const server of store.listServers()) {
    const off = store.isDisabled("mcp", server.name) ? "\t[off]" : "";
    print(`mcp:${server.name}\t${oneLine(server.summary, 120)}${off}`);
  }
}

async function cmdMigrate(store, flags) {
  const dryRun = flags["dry-run"] === true;
  const profiles = profilesFromFlags(flags);
  const mcpResult = migrateMcpFromProfiles({ store, profiles, dryRun, logger: { info: print, warn: (m) => print(`WARN ${m}`) } });
  for (const item of mcpResult.moved) print(`${dryRun ? "[dry] " : ""}mcp:${item.name}\t${item.summary}`);
  for (const item of mcpResult.skipped) print(`skip ${item.id} @ ${item.profile}: ${item.reason}`);
  const roots = skillRoots({
    dshHome: dshHome(),
    agentsHome: agentsHome(),
    cwd: process.cwd(),
    includeProject: flags.project === true,
  });
  for (const root of roots) print(`扫描 skill 根目录: ${root.path}`);
  const skillResult = migrateSkillsFromRoots({ store, roots, dryRun, logger: { info: print, warn: (m) => print(`WARN ${m}`) } });
  for (const item of skillResult.moved) print(`${dryRun ? "[dry] " : ""}skill:${item.name}\t${oneLine(item.summary, 96)}`);
  for (const item of skillResult.skipped) print(`skip ${item.path}: ${item.reason}`);
  print(`完成：mcp ${mcpResult.moved.length} 个，skill ${skillResult.moved.length} 个${dryRun ? "（未落盘）" : ""}`);
}

async function cmdRestore(store, flags, command) {
  const skipSkills = flags["mcp-only"] === true || command === "restore-mcp";
  const skipMcp = flags["skills-only"] === true || command === "restore-skills";
  let skillResults = [];
  let mcpResults = [];
  if (!skipSkills) skillResults = restoreSkillUnits({ store, logger: { info: print } });
  if (!skipMcp) mcpResults = restoreMcpProfiles({ store, logger: { info: print } });
  for (const item of skillResults) print(`skill:${item.name}\t${item.ok ? "已还原" : `失败：${item.reason}`}`);
  for (const item of mcpResults) print(`profile\t${item.profile}\t写回 ${item.restored} 条（备份 ${item.backup}）`);
  print("还原完成。请重启 dsh 让 MCP 行重新生效。");
}

async function cmdAddSkill(store, positional, flags) {
  const target = positional[0];
  if (!target) throw new Error("add-skill 需要 skill 目录或 .md 文件路径");
  const resolved = path.resolve(target);
  const kind = isDirectory(resolved) ? "dir" : "file";
  const imported = importSkillUnit({
    store,
    unitPath: resolved,
    kind,
    source: "manual",
    name: typeof flags.name === "string" ? flags.name : "",
    summary: typeof flags.summary === "string" ? flags.summary : "",
  });
  print(`已导入 skill:${imported.name} — ${imported.summary}`);
}

async function cmdAddMcp(store, positional, flags) {
  const name = positional[0];
  if (!name) throw new Error("add-mcp 需要服务名");
  const transport = flags["streamable-http"] === true || flags.url ? "streamable-http" : "stdio";
  store.putServer(name, {
    summary: oneLine(typeof flags.summary === "string" ? flags.summary : `${name} MCP 服务`, 96),
    transport,
    command: typeof flags.command === "string" ? flags.command : "",
    args: typeof flags.args === "string" ? flags.args.split(/\s+/).filter(Boolean) : [],
    env: {},
    url: typeof flags.url === "string" ? flags.url : "",
    headers: {},
    source: "manual",
  });
  print(`已登记 mcp:${name}（${transport}）`);
  if (flags.verify === true) {
    const manager = new McpManager({ store, logger: { info: print, warn: print } });
    try {
      const tools = await manager.listTools(name);
      print(`连接成功，工具 ${tools.length} 个`);
    } catch (error) {
      print(`连接失败：${errorMessage(error)}`);
      process.exitCode = 1;
    } finally {
      await manager.closeAll();
    }
  }
}

function cmdRemove(store, positional) {
  const id = positional[0] ?? "";
  if (id.startsWith("skill:")) {
    const name = id.slice(6);
    if (!isSkillName(name)) throw new Error(`skill 名不合法：${name}`);
    if (!store.getSkill(name)) {
      // 没登记但目录还在（之前删除中断留下的），允许用它清掉
      const orphan = path.join(store.skillsDir, name);
      if (!exists(orphan)) throw new Error(`不存在 ${id}`);
      deleteSkillFiles(store, name);
      print(`已清掉未登记的残留目录 ${id}`);
      return;
    }
    deleteSkillFiles(store, name);
    store.dropSkill(name);
    store.data.restore.skills = store.data.restore.skills.filter((item) => item.name !== name);
    store.save();
    print(`已移除 ${id}`);
    return;
  }
  if (id.startsWith("mcp:")) {
    const name = id.slice(4);
    if (!store.getServer(name)) throw new Error(`不存在 ${id}`);
    store.dropServer(name);
    print(`已移除 ${id}`);
    return;
  }
  throw new Error("remove 需要 skill:<name> 或 mcp:<server>");
}

function cmdWireProfile(flags, undo = false) {
  const profiles = profilesFromFlags(flags);
  if (profiles.length === 0) throw new Error("没有找到 profile 目录，可用 --profile <dir> 指定");
  for (const dir of profiles) {
    if (undo) {
      const a = removeProfileBodyInsert(dir);
      const b = removeProfileBundles(dir);
      const c = removeProfileLink(dir);
      print(`${dir}\tinsert removed=${a.removed}\tbundle removed=${b.removed}\tlink removed=${c.removed}`);
    } else {
      const a = ensureProfileBundles(dir);
      const b = ensureProfileBodyInsert(dir);
      const c = ensureProfileLink(dir);
      print(`${dir}\tbundle wrote=${a.wrote}\tinsert wrote=${b.wrote}\tlink wrote=${c.wrote}${c.ok ? "" : ` (链接失败：${c.reason})`}`);
    }
  }
}

function cmdDoctor(store, flags) {
  const home = dshHome();
  print(`DSH_HOME: ${home}`);
  print(`data dir: ${store.root} exists=${exists(store.root)}`);
  print(`store.json: ${exists(store.file) ? "ok" : "missing"}`);
  const pkg = readJson(new URL("../package.json", import.meta.url), {});
  print(`plugin version: ${pkg.version ?? "?"}`);
  for (const dir of profilesFromFlags(flags)) {
    const wired = exists(path.join(dir, "node_modules", "dsh-lazy-toolbox"));
    print(`profile ${dir}: linked=${wired}`);
  }
  for (const server of store.listServers()) {
    print(`mcp:${server.name}: ${server.transport === "stdio" ? `${server.command} ${(server.args ?? []).join(" ")}` : server.url}`);
  }
  // 未登记的残留目录：删不掉时会留在这里，提示可用 remove 清理
  const registered = new Set(store.listSkills().map((skill) => skill.name));
  if (exists(store.skillsDir)) {
    for (const entry of fs.readdirSync(store.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || registered.has(entry.name)) continue;
      print(`orphan skill dir: ${path.join(store.skillsDir, entry.name)}（未登记，可 remove skill:${entry.name} 清掉）`);
    }
  }
}

/**
 * 看本地运行日志（插件在 `<数据目录>/logs/` 里记的功能调用与错误）。
 * `--path` 只打印路径；`--lines N` 看最近 N 条；`--raw` 原样输出 JSONL 方便 grep/jq。
 */
function cmdLogs(store, flags) {
  const log = new PluginLog({ dir: path.join(store.root, "logs") });
  if (flags.path === true) {
    print(log.file);
    return;
  }
  const lines = log.tail(Number(flags.lines) || 100);
  if (lines.length === 0) {
    print(`（还没有日志）目录：${log.dir}`);
    return;
  }
  if (flags.raw === true) {
    for (const line of lines) print(line);
    return;
  }
  for (const line of lines) print(formatLogLine(line));
  print("");
  print(`共 ${lines.length} 条 · ${log.dir}`);
}

/**
 * 扫已安装插件内置的 skill / MCP（`skills/`、`mcp.json`、package.json 的 `dsh.skills` / `dsh.mcp`）。
 * `--dry-run` 只报告不写入。
 */
function cmdDiscover(store, flags) {
  const dryRun = flags["dry-run"] === true;
  const result = discoverPluginAssets({
    store,
    profiles: profilesFromFlags(flags),
    dshHome: dshHome(),
    log: new PluginLog({ dir: path.join(store.root, "logs") }),
    dryRun,
  });
  print(`看过 ${result.candidates} 个插件包${dryRun ? "（dry-run，不写入）" : ""}`);
  for (const item of result.skills) print(`+ skill:${item.name}\t← ${item.plugin}\t${item.path}`);
  for (const item of result.servers) print(`+ mcp:${item.name}\t← ${item.plugin}`);
  for (const item of result.pruned) print(`- ${item.kind}:${item.name}\t← ${item.plugin || "已卸载"}`);
  for (const item of result.skipped) print(`· 跳过 ${item.plugin} · ${item.path}：${item.reason}`);
  if (result.skills.length + result.servers.length + result.pruned.length === 0) print("没有发现新的内置资产。");
}

function formatLogLine(line) {
  try {
    const row = JSON.parse(line);
    const rest = Object.entries(row)
      .filter(([key]) => !["ts", "level", "event", "pid"].includes(key))
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" ");
    return `${row.ts} ${String(row.level ?? "info").toUpperCase().padEnd(5)} ${row.event}${rest ? ` ${rest}` : ""}`;
  } catch {
    return line;
  }
}

async function main() {  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const store = storeFromFlags(flags);
  switch (command) {
    case "status":
      return cmdStatus(store);
    case "list":
      return cmdList(store);
    case "migrate":
      return cmdMigrate(store, flags);
    case "restore":
    case "restore-mcp":
    case "restore-skills":
      return cmdRestore(store, flags, command);
    case "add-skill":
      return cmdAddSkill(store, positional, flags);
    case "add-mcp":
      return cmdAddMcp(store, positional, flags);
    case "remove":
      return cmdRemove(store, positional);
    case "enable":
      return cmdToggle(store, positional, true);
    case "disable":
      return cmdToggle(store, positional, false);
    case "wire-profile":
      return cmdWireProfile(flags, false);
    case "unwire-profile":
      return cmdWireProfile(flags, true);
    case "doctor":
      return cmdDoctor(store, flags);
    case "logs":
      return cmdLogs(store, flags);
    case "discover":
      return cmdDiscover(store, flags);
    case "mode":
      return cmdMode(store, positional);
    case "skill":
      return cmdSkill(store, positional, flags);
    case "update":
      return cmdUpdate(store, positional);
    default:
      print(`未知命令：${command}`);
      print("可用：status | list | migrate [--dry-run] | restore [--skills-only|--mcp-only] | add-skill <path> | add-mcp <name> | remove <id> | enable <id> | disable <id> | mode <id> <lazy|skip> | skill <名字> [--section id] | discover [--dry-run] | update [check|download|install] | logs [--lines N] [--path] | wire-profile | unwire-profile | doctor");
      process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`dsh-lazy-toolbox: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
