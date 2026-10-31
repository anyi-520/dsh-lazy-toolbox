/**
 * skill 的搬运、解析与按需加载。
 *
 * 安装插件时把用户级 skill 目录（$DSH_HOME/skills、~/.agents/skills）里的
 * 每个 skill 搬进插件库；AI 之后再往这些目录写新 skill，会被自动搬进来。
 * 卸载时按记录的原始路径原样搬回去。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  copyPath,
  ensureDir,
  exists,
  isDirectory,
  listDir,
  movePath,
  nowIso,
  oneLine,
  parseFrontmatter,
  readText,
  rmrf,
} from "./util.js";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSkillName(name) {
  return SKILL_NAME.test(String(name ?? ""));
}

/** 校验并规整 skill 名；不合规时从目录名推导。 */
export function normalizeSkillName(candidate, fallback = "") {
  const raw = String(candidate ?? "").trim();
  if (isSkillName(raw)) return raw;
  const derived = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (isSkillName(derived)) return derived;
  const alt = String(fallback ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return isSkillName(alt) ? alt : "";
}

/** 默认扫描的 skill 根目录（与 dsh-skill-filesystem 的用户级 root 对齐）。 */
export function skillRoots({ dshHome, agentsHome, cwd, includeProject = false }) {
  const roots = [];
  if (includeProject && cwd) {
    roots.push({ path: path.join(cwd, ".dsh", "skills"), source: "project-dsh" });
    roots.push({ path: path.join(cwd, ".agents", "skills"), source: "project-agents" });
  }
  roots.push({ path: path.join(dshHome, "skills"), source: "user-dsh" });
  roots.push({ path: path.join(agentsHome, "skills"), source: "user-agents" });
  return roots.filter((root) => isDirectory(root.path));
}

/** 读取一个 skill 单元（目录包或单 .md），返回元数据 + 正文。 */
export function readSkillUnit(unitPath, kind) {
  const skillFile = kind === "dir" ? path.join(unitPath, "SKILL.md") : unitPath;
  const raw = readText(skillFile, "");
  if (!raw) return undefined;
  const parsed = parseFrontmatter(raw);
  const declared = typeof parsed.data.name === "string" ? parsed.data.name : "";
  const description = typeof parsed.data.description === "string" ? parsed.data.description : "";
  const whenToUse = typeof parsed.data.whenToUse === "string" ? parsed.data.whenToUse : "";
  return {
    skillFile,
    declaredName: declared,
    description,
    whenToUse,
    content: parsed.body,
    data: parsed.data,
  };
}

/** 列出某个根目录下所有可搬走的 skill 单元。 */
export function discoverSkillUnits(root) {
  const units = [];
  for (const entry of listDir(root)) {
    if (entry.name === ".system") continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const parsed = readSkillUnit(full, "dir");
      if (!parsed) continue;
      const name = normalizeSkillName(parsed.declaredName, entry.name);
      if (!name) continue;
      units.push({ path: full, kind: "dir", name, description: parsed.description });
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const parsed = readSkillUnit(full, "file");
      if (!parsed) continue;
      const name = normalizeSkillName(parsed.declaredName, path.basename(entry.name, ".md"));
      if (!name) continue;
      units.push({ path: full, kind: "file", name, description: parsed.description });
    }
  }
  return units;
}

/** 是否落在系统临时目录里（URL 下载 / git clone 的中间产物）。 */
function isTemporaryPath(target) {
  try {
    const resolved = path.resolve(target);
    const tmp = path.resolve(os.tmpdir());
    return resolved === tmp || resolved.startsWith(tmp + path.sep);
  } catch {
    return false;
  }
}

/**
 * 把一个 skill 单元搬进插件库。
 * @returns {name, summary, entry}
 */
export function importSkillUnit({ store, unitPath, kind, source = "manual", name, summary }) {
  const parsed = readSkillUnit(unitPath, kind);
  if (!parsed) throw new Error(`不是有效的 skill（缺少 SKILL.md 或文件为空）：${unitPath}`);
  const resolvedName = normalizeSkillName(name || parsed.declaredName, path.basename(unitPath));
  if (!resolvedName) throw new Error(`skill 名称不合法（只允许 kebab-case）：${name || parsed.declaredName || unitPath}`);
  const targetDir = path.join(store.skillsDir, resolvedName);
  if (exists(targetDir)) throw new Error(`skill "${resolvedName}" 已经在懒工具箱里`);

  ensureDir(store.skillsDir);
  if (kind === "dir") {
    movePath(unitPath, targetDir);
  } else {
    ensureDir(targetDir);
    movePath(unitPath, path.join(targetDir, "SKILL.md"));
  }
  const entry = {
    // 存原始第一句（留点余量），显示时再按目录宽度截断，避免二次截断把句子截坏
    summary: oneLine(summary || parsed.description || parsed.whenToUse || `${resolvedName} skill`, 300),
    storePath: path.relative(store.root, targetDir).replace(/\\/g, "/"),
    unit: "dir",
    originKind: kind,
    // 从 URL/临时目录导入的没有可还原的原位，留空避免卸载时往已删除的临时目录搬
    origin: isTemporaryPath(unitPath) ? "" : path.resolve(unitPath),
    source,
    addedAt: nowIso(),
  };
  store.putSkill(resolvedName, entry);
  return { name: resolvedName, summary: entry.summary, entry };
}

/** 加载 skill 正文（给 toolbox_load 用）。 */
export function loadSkill(store, name) {
  const entry = store.getSkill(name);
  if (!entry) throw new Error(`skill "${name}" 不在懒工具箱里`);
  const dir = store.skillPath(entry);
  const parsed = readSkillUnit(dir, "dir");
  if (!parsed) throw new Error(`skill "${name}" 的文件已丢失：${dir}`);
  return {
    name,
    summary: entry.summary,
    description: parsed.description,
    whenToUse: parsed.whenToUse,
    resourceDir: dir,
    content: parsed.content,
  };
}

/** 渲染成与 DSH `skill` 工具一致的 <skill_content> 块。 */
export function renderSkillContent(skill) {
  return [
    `<skill_content name="${skill.name}">`,
    "<skill_resources>",
    `Base directory for this skill: ${skill.resourceDir}`,
    "Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.",
    "</skill_resources>",
    "",
    "<skill_instructions>",
    skill.content,
    "</skill_instructions>",
    "</skill_content>",
  ].join("\n");
}

/** 把 skill 从插件库搬回原位置（卸载/还原用）。 */
export function restoreSkillUnit(store, record) {
  const dir = path.join(store.skillsDir, record.name);
  if (!exists(dir)) return { ok: false, reason: "插件库里已经没有这个 skill" };
  const origin = record.origin;
  if (!origin) return { ok: false, reason: "缺少原始路径记录" };
  if (exists(origin)) return { ok: false, reason: `原位置已存在同名的东西：${origin}` };
  ensureDir(path.dirname(origin));
  if (record.originKind === "file") {
    const skillFile = path.join(dir, "SKILL.md");
    if (!exists(skillFile)) return { ok: false, reason: "插件库里缺少 SKILL.md" };
    movePath(skillFile, origin);
    rmrf(dir);
    return { ok: true };
  }
  movePath(dir, origin);
  return { ok: true };
}

/** 删除插件库里的 skill 文件（不还原）。插件内置的原地引用条目只删登记，不动插件文件。 */
export function deleteSkillFiles(store, name) {
  const entry = store.getSkill(name);
  if (!entry) return { removed: false, external: false };
  if (entry.external === true) return { removed: false, external: true };
  rmrf(store.skillPath(entry));
  return { removed: true, external: false };
}

/** 备份一份 skill 目录（导入失败时回滚用）。 */
export function backupSkillUnit(unitPath, backupDir, name) {
  ensureDir(backupDir);
  const dest = path.join(backupDir, name);
  if (exists(dest)) rmrf(dest);
  copyPath(unitPath, dest);
  return dest;
}
