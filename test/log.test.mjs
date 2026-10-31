/**
 * 本地运行日志（lib/log.js）与「调用留痕」的测试。
 * 覆盖：JSONL 结构、级别过滤、长值截断、按大小分卷、retention 清理、
 * 写不进去也不抛、tail() 取最近记录，以及 toolbox 调用真的落盘。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { apply } from "../lib/index.js";
import { PluginLog, nullLog } from "../lib/log.js";
import { Store } from "../lib/store.js";
import { importSkillUnit } from "../lib/skills.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readLines(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("record 写出一行合法 JSONL，带 ts/level/event", () => {
  const dir = tempDir("lt-log-");
  const log = new PluginLog({ dir });
  log.info("toolbox.call", { action: "list", ok: true, ms: 12 });
  const rows = readLines(log.file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, "info");
  assert.equal(rows[0].event, "toolbox.call");
  assert.equal(rows[0].action, "list");
  assert.equal(rows[0].ok, true);
  assert.equal(rows[0].ms, 12);
  assert.match(rows[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof rows[0].pid, "number");
});

test("错误记录带 stack，超长字符串被截断", () => {
  const dir = tempDir("lt-log-");
  const log = new PluginLog({ dir });
  const error = new Error("boom");
  const huge = "x".repeat(5000);
  log.error("toolbox.call", { error, payload: huge });
  const rows = readLines(log.file);
  assert.equal(rows[0].level, "error");
  assert.equal(rows[0].error.message, "boom");
  assert.match(rows[0].error.stack, /boom/);
  assert.ok(rows[0].payload.length < 2100, "长字符串应被截断");
  assert.match(rows[0].payload, /…\(\+\d+\)$/);
});

test("级别过滤：info 级别不丢 debug 之外的噪声", () => {
  const dir = tempDir("lt-log-");
  const log = new PluginLog({ dir, level: "warn" });
  log.debug("a.b", {});
  log.info("a.c", {});
  log.warn("a.d", {});
  const rows = readLines(log.file);
  assert.deepEqual(
    rows.map((row) => row.event),
    ["a.d"],
  );
});

test("超过 maxBytes 立刻分卷，旧文件保留", () => {
  const dir = tempDir("lt-log-");
  const log = new PluginLog({ dir, maxBytes: 64 * 1024 });
  const blob = "y".repeat(2000);
  for (let index = 0; index < 80; index += 1) log.info("fill", { blob });
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".log"));
  assert.ok(files.length >= 2, `应分卷，实际 ${files.join(",")}`);
  assert.ok(files.some((name) => /plugin-\d{8}\.1\.log$/.test(name)), "应有 .1 分卷");
});

test("运行时日志由 apply 创建，plugin.start 落盘，toolbox 调用留痕", async () => {
  const home = tempDir("lt-log-apply-");
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register: () => () => {} },
    systemPrompt: {
      getSectionOrder: () => 0,
      section: () => () => {},
      context: () => () => {},
    },
    on: () => () => {},
    effect: (fn) => {
      const disposer = fn();
      return typeof disposer === "function" ? disposer : () => {};
    },
    get: () => undefined,
  };
  apply(ctx, { dataDir: path.join(home, "data") });

  const store = new Store(path.join(home, "data"));
  const logDir = path.join(store.root, "logs");
  const log = new PluginLog({ dir: logDir });
  const events = readLines(log.file).map((row) => row.event);
  assert.ok(events.includes("plugin.start"), `应记录 plugin.start，实际 ${events.join(",")}`);

  // 直接走常驻工具的 execute，确认调用被写进同一份日志
  const { toolboxToolDefinition } = await import("../lib/tools.js");
  const skillDir = path.join(home, "log-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: log-skill\ndescription: 日志测试\n---\n内容\n", "utf8");
  importSkillUnit({ store, unitPath: skillDir, kind: "dir", source: "manual" });

  const definition = toolboxToolDefinition({
    config: { maxCatalogItems: 200 },
    store,
    log: new PluginLog({ dir: logDir }),
    injector: { loaded: () => [] },
    mcp: { closeServer: async () => {} },
  });
  const exec = { agent: { id: "agent-1", session: { id: "s-1" }, ctx: { tools: { register: () => () => {} } } } };
  await definition.execute({ action: "status" }, exec);
  await assert.rejects(() => definition.execute({ action: "load", ids: [] }, exec), /需要 ids/);

  const rows = readLines(log.file);
  const calls = rows.filter((row) => row.event === "toolbox.call");
  assert.ok(calls.some((row) => row.action === "status" && row.ok === true), "成功的调用要记 ok=true");
  assert.ok(calls.some((row) => row.action === "load" && row.ok === false), "失败的调用要记 ok=false + error");
  const failure = calls.find((row) => row.action === "load");
  assert.match(JSON.stringify(failure.error), /需要 ids/);
});

test("日志目录不可写时不抛异常（降级成静默丢弃）", () => {
  const blocked = path.join(tempDir("lt-log-blocked-"), "file");
  fs.writeFileSync(blocked, "占位", "utf8");
  const log = new PluginLog({ dir: blocked });
  assert.doesNotThrow(() => log.info("any.event", { a: 1 }));
  assert.equal(log.tail(5).length, 0);
});

test("nullLog 是可用空实现", async () => {
  nullLog.info("x", {});
  assert.deepEqual(nullLog.tail(), []);
  assert.equal(await nullLog.timed("x", {}, async () => 7), 7);
});

test("tail 取最近 N 条并按时间顺序返回", () => {
  const dir = tempDir("lt-log-tail-");
  const log = new PluginLog({ dir });
  for (let index = 0; index < 12; index += 1) log.info("seq", { index });
  const rows = log.tail(5).map((line) => JSON.parse(line));
  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.map((row) => row.index),
    [7, 8, 9, 10, 11],
  );
});

test("retention：过期日志在跨天时被清理", () => {
  const dir = tempDir("lt-log-prune-");
  const old = path.join(dir, "plugin-20200101.log");
  fs.writeFileSync(old, '{"ts":"2020-01-01T00:00:00.000Z","level":"info","event":"old"}\n', "utf8");
  const log = new PluginLog({ dir, retentionDays: 7 });
  log.info("fresh", {});
  assert.equal(fs.existsSync(old), false, "过期文件应被删掉");
  assert.ok(fs.existsSync(log.file), "当天文件应在");
});
