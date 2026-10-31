/**
 * 懒工具箱的持久化层。
 *
 * 数据根目录默认 `$DSH_HOME/lazy-toolbox`，结构：
 *   store.json          注册表（skill / mcp / 迁移还原信息）
 *   skills/<name>/...   被搬进来的 skill 目录（或 <name>.md 单文件）
 *
 * 所有写入都是「临时文件 + rename」的原子写，避免 DSH 崩溃留下半截 JSON。
 */
import fs from "node:fs";
import path from "node:path";
import {
  dshHome,
  ensureDir,
  exists,
  isDirectory,
  nowIso,
  readJson,
  writeJsonAtomic,
} from "./util.js";

const SCHEMA_VERSION = 1;

export function defaultDataDir() {
  return path.join(dshHome(), "lazy-toolbox");
}

function emptyStore() {
  return {
    schemaVersion: SCHEMA_VERSION,
    skills: {},
    mcp: { servers: {} },
    restore: { skills: [], profiles: {} },
    // 设置页里被关掉的条目：关掉 = 不进目录、不许 load，但文件/配置都还在
    disabled: { skills: [], mcp: [] },
    updatedAt: nowIso(),
  };
}

export class Store {
  constructor(root) {
    this.root = path.resolve(root || defaultDataDir());
    this.file = path.join(this.root, "store.json");
    this.skillsDir = path.join(this.root, "skills");
    this.data = emptyStore();
    this.load();
  }

  load() {
    this.mtimeMs = this.fileMtime();
    const raw = readJson(this.file, undefined);
    if (!raw || typeof raw !== "object" || raw.schemaVersion !== SCHEMA_VERSION) {
      this.data = emptyStore();
      return this.data;
    }
    this.data = {
      ...emptyStore(),
      ...raw,
      skills: raw.skills && typeof raw.skills === "object" ? raw.skills : {},
      mcp: {
        servers: raw.mcp && raw.mcp.servers && typeof raw.mcp.servers === "object" ? raw.mcp.servers : {},
      },
      restore: {
        skills: Array.isArray(raw.restore?.skills) ? raw.restore.skills : [],
        profiles: raw.restore?.profiles && typeof raw.restore.profiles === "object" ? raw.restore.profiles : {},
      },
      disabled: {
        skills: Array.isArray(raw.disabled?.skills) ? raw.disabled.skills.map(String) : [],
        mcp: Array.isArray(raw.disabled?.mcp) ? raw.disabled.mcp.map(String) : [],
      },
    };
    return this.data;
  }

  save() {
    ensureDir(this.root);
    this.data.updatedAt = nowIso();
    writeJsonAtomic(this.file, this.data);
    this.mtimeMs = this.fileMtime();
  }

  /** store.json 的修改时间；读不到就是 0。 */
  fileMtime() {
    try {
      return fs.statSync(this.file).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * 磁盘被别人改过（另一个对话、CLI、迁移）就重新读一遍。
   * 长驻进程 + 多个会话共用一个 store.json，不刷新会看到过期数据。
   */
  refresh() {
    const mtime = this.fileMtime();
    if (mtime === 0 || mtime === this.mtimeMs) return;
    this.load();
  }

  // ---------------------------------------------------------------- skills

  listSkills() {
    this.refresh();
    return Object.entries(this.data.skills)
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getSkill(name) {
    this.refresh();
    const entry = this.data.skills[name];
    return entry ? { name, ...entry } : undefined;
  }

  putSkill(name, entry) {
    this.data.skills[name] = { ...entry, updatedAt: nowIso() };
    this.save();
  }

  dropSkill(name) {
    delete this.data.skills[name];
    this.dropDisabled("skill", name);
    this.save();
  }

  /** skill 在插件库里的真实路径（目录或单文件）。 */
  skillPath(entry) {
    return path.join(this.root, entry.storePath);
  }

  // ------------------------------------------------------------------- mcp

  listServers() {
    this.refresh();
    return Object.entries(this.data.mcp.servers)
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getServer(name) {
    this.refresh();
    const entry = this.data.mcp.servers[name];
    return entry ? { name, ...entry } : undefined;
  }

  putServer(name, entry) {
    this.data.mcp.servers[name] = { ...entry, updatedAt: nowIso() };
    this.save();
  }

  dropServer(name) {
    delete this.data.mcp.servers[name];
    this.dropDisabled("mcp", name);
    this.save();
  }

  // --------------------------------------------------------------- disabled

  /** 这一项在设置页里被关掉了吗。`kind` 取 "skill" 或 "mcp"。 */
  isDisabled(kind, name) {
    this.refresh();
    const list = kind === "mcp" ? this.data.disabled.mcp : this.data.disabled.skills;
    return list.includes(name);
  }

  /** 开关某一项；返回是否发生了变化。 */
  setDisabled(kind, name, disabled) {
    this.refresh();
    const key = kind === "mcp" ? "mcp" : "skills";
    const list = new Set(this.data.disabled[key]);
    const had = list.has(name);
    if (disabled) list.add(name);
    else list.delete(name);
    this.data.disabled[key] = [...list];
    if (had !== Boolean(disabled)) this.save();
    return had !== Boolean(disabled);
  }

  dropDisabled(kind, name) {
    const key = kind === "mcp" ? "mcp" : "skills";
    const list = this.data.disabled?.[key] ?? [];
    if (!list.includes(name)) return;
    this.data.disabled[key] = list.filter((item) => item !== name);
  }

  listDisabled() {
    this.refresh();
    return { skills: [...this.data.disabled.skills], mcp: [...this.data.disabled.mcp] };
  }

  // ---------------------------------------------------------------- restore

  addRestoreSkill(record) {
    this.data.restore.skills = [
      ...this.data.restore.skills.filter((item) => item.name !== record.name),
      record,
    ];
    this.save();
  }

  takeRestoreSkills() {
    const items = this.data.restore.skills;
    this.data.restore.skills = [];
    this.save();
    return items;
  }

  profileRestore(profileDir) {
    return this.data.restore.profiles[profileDir];
  }

  setProfileRestore(profileDir, value) {
    if (value === undefined) delete this.data.restore.profiles[profileDir];
    else this.data.restore.profiles[profileDir] = value;
    this.save();
  }

  // ----------------------------------------------------------------- 查询

  /** 目标目录是否已经是插件库里的 skill 单元。 */
  isOwnedSkillPath(target) {
    const resolved = path.resolve(target);
    const skillsRoot = path.resolve(this.skillsDir);
    return resolved === skillsRoot || resolved.startsWith(`${skillsRoot}${path.sep}`);
  }

  /** 数据目录是否存在（给 CLI 状态用）。 */
  exists() {
    return exists(this.root) && isDirectory(this.root);
  }
}
