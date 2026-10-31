/**
 * 本地运行日志：把插件自己的功能调用与错误写进 `<数据目录>/logs/plugin-YYYY-MM-DD.log`。
 *
 * 设计原则：
 *   - **只写本地文件**，不往设置页塞任何东西，也不发到任何地方；
 *   - 一行一条 JSON（JSONL），方便 `grep` / `jq` / 直接 `tail`；
 *   - 任何写日志的异常都被吞掉——日志坏了也不能拖垮插件；
 *   - 单值过长会截断（默认 2000 字符），避免把整段源码/整篇 skill 正文灌进日志；
 *   - 按天分文件，超过 `maxBytes` 当天再分卷，超过 `retentionDays` 天的旧文件自动清理。
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir, nowIso } from "./util.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const VALUE_LIMIT = 2000;
const DAY_MS = 86_400_000;

/** 把可能很大的值压成可写日志的形态。 */
function clamp(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > VALUE_LIMIT ? `${value.slice(0, VALUE_LIMIT)}…(+${value.length - VALUE_LIMIT})` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (depth >= 3) return "…";
  if (Array.isArray(value)) {
    const head = value.slice(0, 40).map((item) => clamp(item, depth + 1));
    return value.length > 40 ? [...head, `…(+${value.length - 40})`] : head;
  }
  if (typeof value === "object") {
    const out = {};
    let count = 0;
    for (const [key, item] of Object.entries(value)) {
      if (count >= 40) break;
      out[key] = clamp(item, depth + 1);
      count += 1;
    }
    return out;
  }
  return String(value);
}

function dayStamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

export class PluginLog {
  /**
   * @param {object} options
   * @param {string} options.dir 日志目录（默认 <数据目录>/logs）
   * @param {boolean} [options.enabled] 关掉就完全不写
   * @param {"debug"|"info"|"warn"|"error"} [options.level] 低于这个级别的记录丢弃
   * @param {number} [options.maxBytes] 单个文件上限，超过就分卷
   * @param {number} [options.retentionDays] 保留天数，0 = 不清理
   */
  constructor({ dir, enabled = true, level = "info", maxBytes = 2 * 1024 * 1024, retentionDays = 14 } = {}) {
    this.dir = path.resolve(dir || path.join(process.cwd(), "logs"));
    this.enabled = enabled !== false;
    this.level = LEVELS[String(level)] === undefined ? LEVELS.info : LEVELS[String(level)];
    this.maxBytes = Math.max(64 * 1024, Number(maxBytes) || 2 * 1024 * 1024);
    this.retentionDays = Math.max(0, Number(retentionDays) || 0);
    this.currentDay = "";
    this.part = 0;
    this.lastPruneDay = "";
  }

  get file() {
    const day = dayStamp(new Date());
    const suffix = this.part > 0 ? `.${this.part}` : "";
    return path.join(this.dir, `plugin-${day}${suffix}.log`);
  }

  /** 记录一条事件；永不抛异常。 */
  record(level, event, fields = {}) {
    if (!this.enabled) return;
    const weight = LEVELS[level] ?? LEVELS.info;
    if (weight < this.level) return;
    try {
      this.rotateIfNeeded();
      const line = JSON.stringify({ ts: nowIso(), level, event, pid: process.pid, ...clamp(fields) });
      ensureDir(this.dir);
      fs.appendFileSync(this.file, `${line}\n`, "utf8");
    } catch {
      /* 日志不能拖垮插件 */
    }
  }

  debug(event, fields) {
    this.record("debug", event, fields);
  }

  info(event, fields) {
    this.record("info", event, fields);
  }

  warn(event, fields) {
    this.record("warn", event, fields);
  }

  error(event, fields) {
    this.record("error", event, fields);
  }

  /** 记一次耗时调用：成功与失败都留痕，失败带 stack。 */
  async timed(event, fields, run) {
    const started = Date.now();
    try {
      const result = await run();
      this.info(event, { ...fields, ok: true, ms: Date.now() - started });
      return result;
    } catch (error) {
      this.record("error", event, { ...fields, ok: false, ms: Date.now() - started, error });
      throw error;
    }
  }

  rotateIfNeeded() {
    const day = dayStamp(new Date());
    if (day !== this.currentDay) {
      this.currentDay = day;
      this.part = 0;
      this.prune(day);
      return;
    }
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size >= this.maxBytes) this.part += 1;
  }

  /** 删掉超过保留期的旧日志（一天最多扫一次）。 */
  prune(day) {
    if (this.retentionDays <= 0 || this.lastPruneDay === day) return;
    this.lastPruneDay = day;
    let entries = [];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - this.retentionDays * DAY_MS;
    for (const name of entries) {
      const matched = /^plugin-(\d{8})(?:\.\d+)?\.log$/.exec(name);
      if (!matched) continue;
      const stamp = matched[1];
      const date = new Date(Number(stamp.slice(0, 4)), Number(stamp.slice(4, 6)) - 1, Number(stamp.slice(6, 8)));
      if (Number.isNaN(date.getTime()) || date.getTime() >= cutoff) continue;
      try {
        fs.unlinkSync(path.join(this.dir, name));
      } catch {
        /* ignore */
      }
    }
  }

  /** 读最近 `lines` 行（CLI 用），新→旧不倒序，保持文件顺序。 */
  tail(lines = 100) {
    const limit = Math.max(1, Number(lines) || 100);
    let files = [];
    try {
      files = fs
        .readdirSync(this.dir)
        .filter((name) => /^plugin-\d{8}(?:\.\d+)?\.log$/.test(name))
        .sort();
    } catch {
      return [];
    }
    const collected = [];
    for (const name of files.slice(-3).reverse()) {
      let text = "";
      try {
        text = fs.readFileSync(path.join(this.dir, name), "utf8");
      } catch {
        continue;
      }
      const rows = text.split("\n").filter(Boolean);
      collected.unshift(...rows.slice(-limit));
      if (collected.length >= limit) break;
    }
    return collected.slice(-limit);
  }
}

/** 没有日志对象时的空实现，方便单测与 CLI 复用同一套调用点。 */
export const nullLog = {
  enabled: false,
  dir: "",
  file: "",
  record() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  async timed(_event, _fields, run) {
    return run();
  },
  tail() {
    return [];
  },
};
