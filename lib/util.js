/**
 * 通用小工具：文件读写、原子写、目录搬移、YAML 前置块解析、一句话摘要。
 * 只依赖 node 内置模块 —— 插件被装进 profile 后不需要额外依赖。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export function readText(file, fallback = "") {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function exists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

export function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** 同盘优先 rename；跨盘（EXDEV）退化为复制 + 删除。 */
export function movePath(src, dest) {
  ensureDir(path.dirname(dest));
  try {
    fs.renameSync(src, dest);
    return;
  } catch (error) {
    if (error && error.code !== "EXDEV") throw error;
  }
  copyPath(src, dest);
  rmrf(src);
}

export function copyPath(src, dest) {
  const stat = fs.lstatSync(src);
  if (stat.isDirectory()) {
    ensureDir(dest);
    for (const entry of fs.readdirSync(src)) copyPath(path.join(src, entry), path.join(dest, entry));
    return;
  }
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

export function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function hashOf(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

export function homeDir() {
  return process.env.USERPROFILE || os.homedir();
}

/** $DSH_HOME 的解析规则，与 dsh-home-paths 保持一致（环境变量优先）。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(homeDir(), ".dsh");
}

export function agentsHome() {
  const fromEnv = process.env.AGENTS_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(homeDir(), ".agents");
}

/**
 * 解析 SKILL.md 的 YAML 前置块。只认标量字段（name / description / whenToUse /
 * disable-model-invocation / user-invocable），其余字段原样忽略，不改写文件。
 * 支持 `description: >` 或 `description: |` 折叠/块状写法与引号。
 */
export function parseFrontmatter(text) {
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { data: {}, body: source.trim() };
  const data = parseScalarBlock(match[1].split(/\r?\n/));
  return { data, body: source.slice(match[0].length).trim() };
}

/**
 * 极简 YAML 标量块解析：`key: value`，以及 `key:` + 缩进的多行文本。
 * 复杂结构（嵌套 map/list）留给 mcp 配置解析器处理，这里只服务 skill 前置块。
 */
export function parseScalarBlock(lines) {
  const data = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    index += 1;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const collected = [];
      while (index < lines.length && (/^\s+/.test(lines[index]) || !lines[index].trim())) {
        collected.push(lines[index].trim());
        index += 1;
      }
      data[key] = collected.join(" ").trim();
      continue;
    }
    // 空值后面的缩进块：按空格拼成一行（够用，且不丢内容）
    if (value === "") {
      const collected = [];
      while (index < lines.length && /^\s+\S/.test(lines[index])) {
        collected.push(lines[index].trim());
        index += 1;
      }
      if (collected.length > 0) {
        data[key] = collected.join(" ").trim();
        continue;
      }
    }
    data[key] = unquote(value);
  }
  return data;
}

export function unquote(value) {
  const text = String(value ?? "").trim();
  if (text.length >= 2 && ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return text;
}

/** 一句话概括：压掉换行、取第一句，再按长度截断（拉丁文按词边界收尾）。 */
export function oneLine(text, max = 96) {
  const normalized = String(text ?? "")
    .replace(/\uFEFF/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  const sentence = /^(.+?[。！？!?])/u.exec(normalized) ?? /^(.+?\.)(?:\s|$)/.exec(normalized);
  let out = sentence ? sentence[1] : normalized;
  out = out.replace(/[。！？!?.]$/, "").trim();
  if (out.length > max) {
    const limit = Math.max(1, max - 1);
    const head = out.slice(0, limit);
    // 拉丁文尽量停在词边界，中日韩没有空格就按字符截断
    const boundary = /\s\S*$/.test(head) ? head.replace(/\s\S*$/, "").trim() : "";
    out = `${boundary.length >= Math.floor(limit * 0.6) ? boundary : head.replace(/[\s,;:，、；：]+$/, "")}…`;
  }
  return out;
}

export function nowIso() {
  return new Date().toISOString();
}

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error) {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}
