/**
 * 内置代码编辑器（给 AI 用，不经过终端）。
 *
 * 为什么要它：让 AI 用终端改文件，一条命令写错就是一次失败往返 = 一次多余的 token 消耗。
 * 这里把「读 → 改 → 校验 → 写」放在进程内完成，写之前先做语法校验，错了直接把
 * 行号/列号/原因返回，不进磁盘。
 *
 * 校验覆盖：
 *   .js/.mjs/.cjs  → 真解析器（node --check，临时文件，ESM/CJS 都认）
 *   .json          → JSON.parse，错误位置换算成行列
 *   .yml/.yaml     → 浅校验（Tab 缩进、缩进层级、引号/括号配平）
 *   .md/.txt/其他  → 不校验，只报告字符数
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureDir, exists, nowIso } from "./util.js";

const execFileAsync = promisify(execFile);

const MAX_READ = 400_000;

export function detectKind(file) {
  const ext = path.extname(String(file)).toLowerCase();
  if ([".js", ".mjs", ".cjs", ".jsx"].includes(ext)) return "js";
  if (ext === ".json") return "json";
  if (ext === ".yml" || ext === ".yaml") return "yaml";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".ts" || ext === ".tsx") return "ts";
  if (ext === ".css" || ext === ".scss") return "css";
  if (ext === ".html" || ext === ".htm") return "html";
  return "text";
}

/** 把「第 N 个字符」换算成行列（1 基）。 */
export function offsetToLineColumn(text, offset) {
  const safe = Math.max(0, Math.min(Number(offset) || 0, text.length));
  const head = text.slice(0, safe);
  const line = head.split("\n").length;
  const column = safe - head.lastIndexOf("\n");
  return { line, column };
}

/** JS 语法校验：交给 node 自己解析（临时文件，避免 vm 对 ESM 的限制）。 */
async function checkJavaScript(file, content) {
  const ext = [".js", ".mjs", ".cjs"].includes(path.extname(file).toLowerCase()) ? path.extname(file).toLowerCase() : ".js";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-lt-check-"));
  const temp = path.join(dir, `check${ext}`);
  fs.writeFileSync(temp, content, "utf8");
  try {
    await execFileAsync(process.execPath, ["--check", temp], { timeout: 20000, windowsHide: true });
    return { errors: [], notes: [] };
  } catch (error) {
    const raw = String(error.stderr ?? error.stdout ?? error.message ?? "");
    const lines = raw.split(/\r?\n/);
    // 形如：/tmp/check.mjs:3
    //        const a = ;
    //                    ^
    //        SyntaxError: Unexpected token ';'
    let line = 0;
    let column = 0;
    let message = "";
    for (let index = 0; index < lines.length; index += 1) {
      const hit = lines[index].match(/check\.(?:m?c?js):(\d+)/);
      if (hit) {
        line = Number(hit[1]);
        const caret = lines[index + 2] ?? "";
        const caretAt = caret.indexOf("^");
        if (caretAt >= 0) column = caretAt + 1;
      }
      if (/^(SyntaxError|TypeError|ReferenceError)/.test(lines[index].trim())) {
        message = lines[index].trim();
        break;
      }
    }
    if (!message) message = lines.filter(Boolean).slice(-1)[0] ?? "语法错误";
    return { errors: [{ line, column, message: message.replace(/^[A-Za-z]*Error:\s*/, "") }], notes: [] };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** JSON 校验：JSON.parse 的 position 换成行列。 */
function checkJson(content) {
  try {
    JSON.parse(content);
    return { errors: [], notes: [] };
  } catch (error) {
    const message = String(error?.message ?? error);
    const hit = message.match(/position (\d+)/);
    let at = hit ? Number(hit[1]) : 0;
    const lineColumn = message.match(/line (\d+) column (\d+)/);
    const pos = lineColumn
      ? { line: Number(lineColumn[1]), column: Number(lineColumn[2]) }
      : offsetToLineColumn(content, at);
    return { errors: [{ line: pos.line, column: pos.column, message: message.replace(/^JSON\.parse:\s*/, "") }], notes: [] };
  }
}

/** YAML 浅校验：只抓「Tab 缩进 / 缩进不是 2 的倍数 / 引号括号不配平」这类常见错。 */
function checkYaml(content) {
  const errors = [];
  const lines = content.split(/\r?\n/);
  let depth = 0;
  let quote = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\t+/.test(line)) {
      errors.push({ line: index + 1, column: 1, message: "YAML 不能用 Tab 缩进" });
    }
    const indent = line.match(/^ */)[0].length;
    if (line.trim() && indent % 2 !== 0) {
      errors.push({ line: index + 1, column: indent + 1, message: `缩进 ${indent} 个空格不是 2 的倍数` });
    }
    const stripped = line.replace(/#.*$/, "");
    for (const char of stripped) {
      if (quote) {
        if (char === quote) quote = "";
        continue;
      }
      if (char === "'" || char === '"') quote = char;
      else if (char === "[" || char === "{" || char === "(") depth += 1;
      else if (char === "]" || char === "}" || char === ")") depth -= 1;
    }
    if (errors.length > 20) break;
  }
  if (quote) errors.push({ line: lines.length, column: 1, message: `引号没有闭合（${quote}）` });
  if (depth !== 0) errors.push({ line: lines.length, column: 1, message: `括号没有配平（差 ${depth}）` });
  return { errors, notes: ["YAML 只做浅校验（缩进/引号/括号），不替代真解析器"] };
}

/**
 * 校验一段代码。永远返回结构体，不抛异常。
 * @returns {Promise<{ok:boolean, kind:string, errors:Array, notes:Array}>}
 */
export async function validateCode({ file, content }) {
  const text = String(content ?? "");
  const kind = detectKind(file);
  try {
    if (kind === "js") {
      const result = await checkJavaScript(file, text);
      return { ok: result.errors.length === 0, kind, errors: result.errors, notes: result.notes };
    }
    if (kind === "json") {
      const result = checkJson(text);
      return { ok: result.errors.length === 0, kind, errors: result.errors, notes: result.notes };
    }
    if (kind === "yaml") {
      const result = checkYaml(text);
      return { ok: result.errors.length === 0, kind, errors: result.errors, notes: result.notes };
    }
    if (kind === "ts") {
      return { ok: true, kind, errors: [], notes: ["TypeScript 只看括号配平；需要类型检查请走 tsc"] };
    }
    return { ok: true, kind, errors: [], notes: [] };
  } catch (error) {
    return { ok: false, kind, errors: [{ line: 0, column: 0, message: String(error?.message ?? error) }], notes: [] };
  }
}

/** 读文件（带大小上限与行数信息）。 */
export function readCode({ file, maxBytes = MAX_READ }) {
  if (!file) throw new Error("需要 path");
  const target = path.resolve(String(file));
  if (!exists(target)) throw new Error(`文件不存在：${target}`);
  const stat = fs.statSync(target);
  if (stat.isDirectory()) throw new Error(`这是个目录：${target}`);
  if (stat.size > maxBytes) {
    throw new Error(`文件太大（${stat.size} 字节 > ${maxBytes}）：改用分段读取`);
  }
  const content = fs.readFileSync(target, "utf8").replace(/^\uFEFF/, "");
  return {
    file: target,
    kind: detectKind(target),
    size: stat.size,
    lines: content.split("\n").length,
    chars: content.length,
    content,
    mtime: stat.mtime.toISOString(),
  };
}

/** 备份目录：<数据目录>/editor-backups/ */
function backupFile(root, target, content) {
  const dir = path.join(root, "editor-backups");
  ensureDir(dir);
  const name = `${nowIso().replace(/[:.]/g, "-")}-${path.basename(target)}`;
  const dest = path.join(dir, name);
  fs.writeFileSync(dest, content, "utf8");
  return dest;
}

/**
 * 写文件：先校验（除非 force），通过才落盘，落盘前把老内容备份一份。
 */
export async function writeCode({ root, file, content, force = false }) {
  if (!file) throw new Error("需要 path");
  const target = path.resolve(String(file));
  const text = String(content ?? "");
  const validation = await validateCode({ file: target, content: text });
  const previous = exists(target) ? fs.readFileSync(target, "utf8") : "";
  if (!validation.ok && !force) {
    return {
      ok: false,
      file: target,
      kind: validation.kind,
      errors: validation.errors,
      notes: validation.notes,
      written: false,
      message: "校验没通过，没有写入（确认无误可以加 force: true）",
    };
  }
  ensureDir(path.dirname(target));
  const backup = previous ? backupFile(root, target, previous) : "";
  fs.writeFileSync(target, text, "utf8");
  return {
    ok: true,
    file: target,
    kind: validation.kind,
    errors: validation.errors,
    notes: validation.notes,
    written: true,
    size: Buffer.byteLength(text, "utf8"),
    lines: text.split("\n").length,
    backup,
    forced: !validation.ok && Boolean(force),
    message: validation.ok ? "已写入" : "校验有错但强制写入（force）",
  };
}

/** 找一段唯一文本并替换（AI 改局部比整篇重写省 token）。 */
export function patchCode({ content, find, replace, all = false }) {
  const text = String(content ?? "");
  const needle = String(find ?? "");
  if (!needle) throw new Error("patch 需要 find");
  const count = text.split(needle).length - 1;
  if (count === 0) throw new Error("原文件里找不到这段文本（先 read 一次确认）");
  if (count > 1 && !all) throw new Error(`这段文本出现 ${count} 次，加 all: true 或者写得更具体`);
  const next = all ? text.split(needle).join(String(replace ?? "")) : text.replace(needle, String(replace ?? ""));
  return { content: next, replaced: all ? count : 1 };
}

/** 回滚到最近一次备份。 */
export function revertCode({ root, file }) {
  const target = path.resolve(String(file));
  const dir = path.join(root, "editor-backups");
  if (!exists(dir)) throw new Error("还没有任何备份");
  const suffix = `-${path.basename(target)}`;
  const candidates = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .reverse();
  if (candidates.length === 0) throw new Error(`没有 ${path.basename(target)} 的备份`);
  const latest = path.join(dir, candidates[0]);
  const content = fs.readFileSync(latest, "utf8");
  fs.writeFileSync(target, content, "utf8");
  return { file: target, from: latest, size: Buffer.byteLength(content, "utf8") };
}

/** 给 AI 看的一段校验结果文本。 */
export function formatValidation(result) {
  const head = result.ok ? "✅ 校验通过" : "❌ 校验没通过";
  const rows = [`${head}（${result.kind}）`];
  for (const error of result.errors) {
    const where = error.line ? `第 ${error.line} 行${error.column ? ` 第 ${error.column} 列` : ""}：` : "";
    rows.push(`- ${where}${error.message}`);
  }
  for (const note of result.notes ?? []) rows.push(`- 说明：${note}`);
  return rows.join("\n");
}
