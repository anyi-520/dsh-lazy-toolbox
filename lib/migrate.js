/**
 * 迁移：把「原生」的 skill 与 MCP 配置搬进懒工具箱；以及反向还原。
 *
 * MCP 的来源是 profile 的 cordis.patch.yml 里 `@deepseek-ai/dsh-mcp-client` 条目。
 * 迁移 = 读出 config → 写进插件库 → 从 yml 里删掉那一整块（原文保存在 store.restore）。
 * 还原 = 按记录的行号把原文写回。
 */
import path from "node:path";
import fs from "node:fs";
import {
  findMcpEntries,
  insertEntries,
  mcpEntrySummary,
  removeEntries,
} from "./profile.js";
import { errorMessage, exists, isDirectory, oneLine, readText, nowIso } from "./util.js";
import { discoverSkillUnits, importSkillUnit, restoreSkillUnit } from "./skills.js";

function normalizeTransport(value) {
  return value === "streamable-http" ? "streamable-http" : "stdio";
}

/** 从一条 mcp-client 行配置里提取插件库需要的字段。 */
export function serverFromEntry(entry) {
  const config = entry.config ?? {};
  const serverName = String(config.serverName ?? entry.id ?? "").trim();
  if (!serverName) return { ok: false, reason: "缺少 serverName" };
  if (!entry.configSupported) return { ok: false, reason: "config 里有插件无法解析的表达式（如 !!js），保持原样" };
  const transport = normalizeTransport(config.transport);
  if (transport === "stdio" && !config.command) return { ok: false, reason: "stdio 传输缺少 command" };
  if (transport === "streamable-http" && !config.url) return { ok: false, reason: "streamable-http 传输缺少 url" };
  const args = Array.isArray(config.args) ? config.args.map(String) : [];
  const env = config.env && typeof config.env === "object" && !Array.isArray(config.env) ? { ...config.env } : {};
  const headers = config.headers && typeof config.headers === "object" && !Array.isArray(config.headers) ? { ...config.headers } : {};
  return {
    ok: true,
    name: serverName,
    entry: {
      summary: oneLine(config.serverSummary || config.description || mcpEntrySummary(entry), 96),
      transport,
      command: transport === "stdio" ? String(config.command ?? "") : "",
      args,
      env,
      cwd: typeof config.cwd === "string" ? config.cwd : "",
      url: transport === "streamable-http" ? String(config.url ?? "") : "",
      headers,
      toolCallTimeoutMs: Number(config.toolCallTimeoutMs) > 0 ? Number(config.toolCallTimeoutMs) : undefined,
      addedAt: nowIso(),
      source: "migrate",
    },
  };
}

/**
 * 扫描 profile 并迁移 MCP 配置。
 * @returns {{moved: Array, skipped: Array, profiles: Array}}
 */
export function migrateMcpFromProfiles({ store, profiles, dryRun = false, logger }) {
  const moved = [];
  const skipped = [];
  const touched = [];
  for (const profileDir of profiles) {
    const file = path.join(profileDir, "cordis.patch.yml");
    if (!exists(file)) continue;
    const text = readText(file, "");
    const entries = findMcpEntries(text);
    if (entries.length === 0) continue;
    const removed = [];
    for (const entry of entries) {
      const converted = serverFromEntry(entry);
      if (!converted.ok) {
        skipped.push({ profile: profileDir, id: entry.id, reason: converted.reason });
        continue;
      }
      if (store.getServer(converted.name)) {
        skipped.push({ profile: profileDir, id: entry.id, reason: `插件库里已有同名服务 "${converted.name}"，保留原行` });
        continue;
      }
      if (!dryRun) store.putServer(converted.name, converted.entry);
      moved.push({ profile: profileDir, name: converted.name, summary: converted.entry.summary });
      removed.push({ id: entry.id, text: entry.text, index: entry.start });
    }
    if (removed.length === 0) continue;
    touched.push({ profile: profileDir, removed });
    if (!dryRun) {
      const next = removeEntries(text, entries.filter((entry) => removed.some((record) => record.id === entry.id)));
      fs.writeFileSync(file, next, "utf8");
      const previous = store.profileRestore(profileDir) ?? { removed: [] };
      const merged = [...(previous.removed ?? []), ...removed];
      store.setProfileRestore(profileDir, { removed: merged, updatedAt: nowIso() });
    }
    logger?.info?.(`lazy-toolbox: 从 ${profileDir} 迁移了 ${removed.length} 个 MCP 服务`);
  }
  return { moved, skipped, profiles: touched };
}

/** 还原 MCP 原始行（按保存的行号写回，随后清空记录）。 */
export function restoreMcpProfiles({ store, logger }) {
  const results = [];
  for (const [profileDir, record] of Object.entries(store.data.restore.profiles ?? {})) {
    const file = path.join(profileDir, "cordis.patch.yml");
    const records = Array.isArray(record?.removed) ? record.removed : [];
    if (records.length === 0) {
      store.setProfileRestore(profileDir, undefined);
      continue;
    }
    const backup = `${file}.lazy-toolbox-backup`;
    if (exists(file)) fs.copyFileSync(file, backup);
    const text = readText(file, "[]\n");
    const next = insertEntries(text, records);
    fs.writeFileSync(file, next, "utf8");
    store.setProfileRestore(profileDir, undefined);
    results.push({ profile: profileDir, restored: records.length, backup });
    logger?.info?.(`lazy-toolbox: 已把 ${records.length} 个 MCP 条目写回 ${file}`);
  }
  return results;
}

/** 迁移用户级 skill 目录。 */
export function migrateSkillsFromRoots({ store, roots, dryRun = false, logger }) {
  const moved = [];
  const skipped = [];
  for (const root of roots) {
    if (!isDirectory(root.path)) continue;
    for (const unit of discoverSkillUnits(root.path)) {
      if (store.getSkill(unit.name)) {
        skipped.push({ path: unit.path, reason: `插件库里已有同名 skill "${unit.name}"` });
        continue;
      }
      if (dryRun) {
        moved.push({ name: unit.name, from: unit.path, summary: unit.description });
        continue;
      }
      try {
        const imported = importSkillUnit({
          store,
          unitPath: unit.path,
          kind: unit.kind,
          source: "migrate",
        });
        store.addRestoreSkill({
          name: imported.name,
          origin: path.resolve(unit.path),
          originKind: unit.kind,
        });
        moved.push({ name: imported.name, from: unit.path, summary: imported.summary });
      } catch (error) {
        skipped.push({ path: unit.path, reason: errorMessage(error) });
      }
    }
  }
  if (moved.length > 0 && !dryRun) logger?.info?.(`lazy-toolbox: 迁移了 ${moved.length} 个 skill`);
  return { moved, skipped };
}

/** 还原所有迁移过的 skill。 */
export function restoreSkillUnits({ store, logger }) {
  const records = store.takeRestoreSkills();
  const results = [];
  for (const record of records) {
    try {
      const outcome = restoreSkillUnit(store, record);
      results.push({ name: record.name, ...outcome });
    } catch (error) {
      results.push({ name: record.name, ok: false, reason: errorMessage(error) });
    }
  }
  if (logger) logger.info?.(`lazy-toolbox: 还原 skill ${results.filter((item) => item.ok).length}/${results.length}`);
  return results;
}

/** 运行时自动导入：把新出现的 skill 搬进来（AI 自己下载 skill 后自动生效）。 */
export function autoImportSkills({ store, roots, logger }) {
  if (!roots || roots.length === 0) return { moved: [], skipped: [] };
  return migrateSkillsFromRoots({ store, roots, dryRun: false, logger });
}
