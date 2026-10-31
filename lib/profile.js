/**
 * profile / cordis.patch.yml 的读写。
 *
 * 不引 yaml 依赖：只做「顶层数组项」的文本级切块，能认出
 * `name: '@deepseek-ai/dsh-mcp-client'` 的条目、读出它 config 子树的
 * 标量/列表/映射，并在移除时原样保存整块文本，卸载时按原位置写回。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dshHome, ensureDir, oneLine, readText, unquote } from "./util.js";

export const MCP_CLIENT_PLUGIN = "@deepseek-ai/dsh-mcp-client";
export const TOOLBOX_NAME = "dsh-lazy-toolbox";
export const TOOLBOX_ID = "lazy-toolbox";

/** 本文件所在目录（lib/），用来定位插件根目录。 */
const PROFILE_HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 列出 $DSH_HOME/profiles 下所有 profile 目录。 */
export function listProfiles(home = dshHome()) {
  const root = path.join(home, "profiles");
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .map((name) => path.join(root, name))
    .filter((dir) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
}

/** 从 profile 的 package.json 猜它是不是一个 profile。 */
export function isProfileDir(dir) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return false;
  }
  if (!pkg || typeof pkg !== "object") return false;
  if (typeof pkg.name === "string" && pkg.name.startsWith("dsh-profile-")) return true;
  return Array.isArray(pkg.dsh?.profile?.bundles);
}

/** 顶层数组项切块：[{ start, end, text }]，行号从 0 开始，end 不含。 */
export function splitTopLevelEntries(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^-\s/.test(lines[index])) starts.push(index);
  }
  const entries = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = index + 1 < starts.length ? starts[index + 1] : lines.length;
    entries.push({ start, end, text: lines.slice(start, end).join("\n") });
  }
  return { lines, entries };
}

function indentOf(line) {
  return (line.match(/^[ \t]*/) || [""])[0].length;
}

function stripComment(line) {
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote && line[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
  }
  return line;
}

/** 解析 `- a` / `[a, b]` / `{k: v}` 这类简单 YAML 值。 */
export function parseYamlValue(raw) {
  const value = unquote(String(raw ?? "").trim());
  if (!value) return "";
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitFlow(value.slice(1, -1)).map((item) => unquote(item));
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const out = {};
    for (const pair of splitFlow(value.slice(1, -1))) {
      const match = /^([^:]+):\s*(.*)$/.exec(pair.trim());
      if (match) out[unquote(match[1])] = unquote(match[2]);
    }
    return out;
  }
  return value;
}

function splitFlow(text) {
  const parts = [];
  let current = "";
  let depth = 0;
  let quote = "";
  for (const char of text) {
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "[" || char === "{") depth += 1;
    if (char === "]" || char === "}") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * 解析一段（缩进连续的）YAML 子树。只支持插件配置实际用到的形状：
 * 标量、标量列表、标量映射，以及一层嵌套（args/env/headers/oauth 之类）。
 */
export function parseYamlSubset(lines) {
  const meaningful = lines.filter((line) => line.trim() && !line.trim().startsWith("#"));
  if (meaningful.length === 0) return {};
  const baseIndent = indentOf(meaningful[0]);
  const result = {};
  let index = 0;
  while (index < lines.length) {
    const rawLine = lines[index];
    index += 1;
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    if (indentOf(rawLine) < baseIndent) continue;
    const line = stripComment(rawLine);
    const match = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const rest = match[2].trim();
    if (rest.startsWith("!!js")) {
      result[key] = undefined;
      continue;
    }
    if (rest !== "") {
      result[key] = parseYamlValue(rest);
      continue;
    }
    // 空值：收集更深缩进的子块
    const block = [];
    while (index < lines.length) {
      const next = lines[index];
      if (!next.trim()) {
        block.push(next);
        index += 1;
        continue;
      }
      if (indentOf(next) <= indentOf(rawLine)) break;
      block.push(next);
      index += 1;
    }
    const trimmed = block.filter((item) => item.trim());
    if (trimmed.length === 0) {
      result[key] = "";
      continue;
    }
    if (/^\s*-/.test(trimmed[0])) {
      result[key] = trimmed.map((item) => parseYamlValue(item.replace(/^\s*-\s?/, "")));
    } else {
      result[key] = parseYamlSubset(trimmed);
    }
  }
  return result;
}

/** 找出一份 cordis.patch.yml 里所有 mcp-client 条目。 */
export function findMcpEntries(text) {
  const { entries } = splitTopLevelEntries(text);
  const found = [];
  for (const entry of entries) {
    const lines = entry.text.split("\n");
    const nameLineIndex = lines.findIndex((line) => /^\s*name\s*:\s*['"]?@deepseek-ai\/dsh-mcp-client['"]?\s*$/.test(stripComment(line)));
    if (nameLineIndex < 0) continue;
    const idMatch = /^\s*-?\s*id\s*:\s*(.+?)\s*$/.exec(lines.find((line) => /^\s*-?\s*id\s*:/.test(line)) ?? "");
    let config = {};
    let configSupported = true;
    const configIndex = lines.findIndex((line) => /^\s*config\s*:\s*$/.test(stripComment(line)));
    if (configIndex >= 0) {
      const baseIndent = indentOf(lines[configIndex]);
      const block = [];
      for (let index = configIndex + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.trim() && indentOf(line) <= baseIndent) break;
        block.push(line);
      }
      const parsed = parseYamlSubset(block);
      if (Object.values(parsed).some((value) => value === undefined)) configSupported = false;
      config = parsed;
    }
    found.push({
      start: entry.start,
      end: entry.end,
      text: entry.text,
      id: idMatch ? unquote(idMatch[1]) : "",
      config,
      configSupported,
    });
  }
  return found;
}

/** 概要：一句话说明这个 MCP 服务干什么（优先 serverSummary / description）。 */
export function mcpEntrySummary(entry) {
  const config = entry.config ?? {};
  const explicit = config.serverSummary ?? config.summary ?? config.description;
  if (typeof explicit === "string" && explicit.trim()) return oneLine(explicit);
  const label = config.serverName ?? entry.id ?? "MCP";
  const transport = config.transport === "streamable-http" ? "HTTP" : "stdio";
  return `${label}（${transport}）MCP 服务`;
}

/** 从一段行数组里移除给定条目（按 start 降序删除，避免行号漂移）。 */
export function removeEntries(text, entries) {
  const lines = String(text ?? "").split(/\r?\n/);
  const sorted = [...entries].sort((a, b) => b.start - a.start);
  for (const entry of sorted) {
    const drop = entry.end - entry.start;
    lines.splice(entry.start, drop);
  }
  return lines.join("\n");
}

/** 按记录的位置把条目写回。位置越界就追加到末尾。 */
export function insertEntries(text, records) {
  const lines = String(text ?? "").split(/\r?\n/);
  const sorted = [...records].sort((a, b) => a.index - b.index);
  for (const record of sorted) {
    const block = String(record.text).split(/\r?\n/);
    const at = Math.max(0, Math.min(record.index, lines.length));
    lines.splice(at, 0, ...block);
  }
  return lines.join("\n");
}

// ------------------------------------------------ 插件自身的 profile 接线

const INSERT_BLOCK = [
  "- insert:",
  `    - id: ${TOOLBOX_ID}`,
  `      name: ${TOOLBOX_NAME}`,
  "      inject: [systemPrompt, tools]",
  "      config:",
  "        autoImport: true",
  "        autoUnloadOnTurnEnd: true",
  "",
].join("\n");

export function profileHasBodyInsert(text) {
  return new RegExp(`^\\s*-\\s*id:\\s*${TOOLBOX_ID}\\s*$`, "m").test(String(text ?? ""));
}

export function ensureProfileBodyInsert(profileDir) {
  const file = path.join(profileDir, "cordis.patch.yml");
  const text = readText(file, "");
  if (profileHasBodyInsert(text)) return { ok: true, wrote: false, path: file };
  ensureDir(profileDir);
  const prefix = text && !text.endsWith("\n") ? "\n" : "";
  const glue = text ? "\n" : "";
  fs.writeFileSync(file, `${text}${prefix}${glue}${INSERT_BLOCK}`, "utf8");
  return { ok: true, wrote: true, path: file };
}

export function removeProfileBodyInsert(profileDir) {
  const file = path.join(profileDir, "cordis.patch.yml");
  const text = readText(file, "");
  if (!profileHasBodyInsert(text)) return { ok: true, removed: false, path: file };
  const lines = text.split(/\r?\n/);
  const idIndex = lines.findIndex((line) => new RegExp(`^\\s*-\\s*id:\\s*${TOOLBOX_ID}\\s*$`).test(line));
  if (idIndex < 0) return { ok: true, removed: false, path: file };
  let start = idIndex;
  while (start > 0 && !/^-\s*insert\s*:\s*$/.test(lines[start])) start -= 1;
  if (!/^-\s*insert\s*:\s*$/.test(lines[start])) start = idIndex;
  let end = idIndex + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (/^-\s/.test(line) && !/^\s/.test(line)) break;
    end += 1;
  }
  lines.splice(start, end - start);
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  return { ok: true, removed: true, path: file };
}

/**
 * 把插件本身写进 profile 的依赖与 bundles。
 * @param profileDir - profile 目录。
 * @param options.spec - 依赖声明，默认 `link:<插件目录>`；从 npm 安装时传版本号。
 */
export function ensureProfileBundles(profileDir, options = {}) {
  const file = path.join(profileDir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ok: false, wrote: false, path: file };
  }
  const spec = options.spec || `link:${defaultPluginDir().replace(/\\/g, "/")}`;
  let wrote = false;
  pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : {};
  if (pkg.dependencies[TOOLBOX_NAME] !== spec) {
    pkg.dependencies[TOOLBOX_NAME] = spec;
    wrote = true;
  }
  pkg.dsh = pkg.dsh && typeof pkg.dsh === "object" ? pkg.dsh : {};
  pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === "object" ? pkg.dsh.profile : {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  if (!bundles.includes(TOOLBOX_NAME)) {
    pkg.dsh.profile.bundles = [...bundles, TOOLBOX_NAME];
    wrote = true;
  }
  if (!wrote) return { ok: true, wrote: false, path: file };
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  return { ok: true, wrote: true, path: file };
}

export function removeProfileBundles(profileDir) {
  const file = path.join(profileDir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ok: false, removed: false, path: file };
  }
  let removed = false;
  const bundles = pkg?.dsh?.profile?.bundles;
  if (Array.isArray(bundles) && bundles.includes(TOOLBOX_NAME)) {
    pkg.dsh.profile.bundles = bundles.filter((item) => item !== TOOLBOX_NAME);
    removed = true;
  }
  if (pkg?.dependencies && typeof pkg.dependencies === "object" && TOOLBOX_NAME in pkg.dependencies) {
    delete pkg.dependencies[TOOLBOX_NAME];
    removed = true;
  }
  if (!removed) return { ok: true, removed: false, path: file };
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  return { ok: true, removed: true, path: file };
}

/** 插件自己的目录（package.json 所在处）。 */
export function defaultPluginDir() {
  return path.resolve(PROFILE_HELPERS_DIR, "..");
}

/**
 * 在 profile 的 node_modules 里放一个指向插件目录的链接。
 * pnpm 的 `link:` 依赖下次 install 会自己建；这里先建好，重启即生效。
 */
export function ensureProfileLink(profileDir, pluginDir = defaultPluginDir()) {
  const target = path.join(profileDir, "node_modules", TOOLBOX_NAME);
  try {
    const stats = fs.lstatSync(target);
    if (stats.isSymbolicLink() || stats.isDirectory()) {
      const current = stats.isSymbolicLink() ? fs.realpathSync(target) : "";
      if (!current || path.resolve(current) === path.resolve(pluginDir)) return { ok: true, wrote: false, path: target };
      fs.rmSync(target, { recursive: false, force: true });
    }
  } catch {
    /* 不存在，继续创建 */
  }
  try {
    ensureDir(path.dirname(target));
    fs.symlinkSync(path.resolve(pluginDir), target, "junction");
    return { ok: true, wrote: true, path: target };
  } catch (error) {
    return { ok: false, wrote: false, path: target, reason: error.message };
  }
}

export function removeProfileLink(profileDir) {
  const target = path.join(profileDir, "node_modules", TOOLBOX_NAME);
  try {
    fs.lstatSync(target);
  } catch {
    return { ok: true, removed: false, path: target };
  }
  try {
    fs.rmSync(target, { recursive: false, force: true });
    return { ok: true, removed: true, path: target };
  } catch (error) {
    return { ok: false, removed: false, path: target, reason: error.message };
  }
}
