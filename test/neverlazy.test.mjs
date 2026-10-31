/**
 * 「不做懒加载」名单（lib/denylist.js）与 discover 的配合：
 * 名单里的插件，其内置 skill / MCP 一律不接管（插件自己注入的那份不受影响），
 * 以及 skill 加载方式（懒加载 / 跳过）在 toolbox 与 API 两侧的一致性。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { matchNeverLazy, describeNeverLazy, BUILTIN_PACKAGES } from "../lib/denylist.js";
import { discoverPluginAssets } from "../lib/discover.js";
import { Store } from "../lib/store.js";
import { toolboxToolDefinition } from "../lib/tools.js";
import { Injector } from "../lib/inject.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function makeProfile(pluginNames) {
  const profile = tempDir("lt-nl-");
  writeFile(path.join(profile, "package.json"), JSON.stringify({ name: "dsh-profile-test" }));
  for (const name of pluginNames) {
    const dir = path.join(profile, "node_modules", ...name.split("/"));
    writeFile(path.join(dir, "package.json"), JSON.stringify({ name, dsh: { skills: ["skills"] } }));
    writeFile(
      path.join(dir, "skills", `${name.replace(/[^a-z0-9]+/gi, "-")}-skill`, "SKILL.md"),
      `---\nname: ${name.replace(/[^a-z0-9]+/gi, "-")}-skill\ndescription: ${name} 自带的 skill\n---\n正文\n`,
    );
  }
  return profile;
}

test("名单：包名 / 模式 / 自定义 三种命中方式", () => {
  assert.equal(matchNeverLazy("dsh-purge").blocked, true);
  assert.equal(matchNeverLazy("dsh-jailbreak-ultimate").blocked, true);
  assert.equal(matchNeverLazy("@someone/dsh-uncensored-pack").blocked, true);
  assert.equal(matchNeverLazy("dsh-break-armor").blocked, true);
  assert.equal(matchNeverLazy("破甲工具箱").blocked, true);
  assert.equal(matchNeverLazy("dsh-lazy-toolbox").blocked, false);
  assert.equal(matchNeverLazy("dsh-memstudio").blocked, false);
  assert.equal(matchNeverLazy("my-plugin", { extra: ["my-plugin"] }).blocked, true);
  assert.equal(matchNeverLazy("dsh-jailbreak", { builtin: false }).blocked, false, "可以关掉内置名单");
  assert.match(matchNeverLazy("dsh-purge").matched, /内置/);
  assert.ok(describeNeverLazy().packages.includes("dsh-purge"));
  assert.ok(BUILTIN_PACKAGES.length >= 5);
});

test("名单里的插件：内置 skill / MCP 一个都不接管，其余插件照常", () => {
  const profile = makeProfile(["dsh-purge", "dsh-normal-plugin"]);
  const store = new Store(tempDir("lt-store-"));
  const result = discoverPluginAssets({ store, profiles: [profile] });
  const names = result.skills.map((item) => item.plugin);
  assert.deepEqual(names, ["dsh-normal-plugin"]);
  assert.equal(store.getSkill("dsh-purge-skill"), undefined);
  assert.deepEqual(result.blocked.map((item) => item.plugin), ["dsh-purge"]);
  assert.match(result.blocked[0].matched, /内置/);
});

test("名单里的插件之前被接管过：这一轮撤掉登记，插件文件不动", () => {
  const profile = makeProfile(["dsh-jailbreak"]);
  const store = new Store(tempDir("lt-store-"));
  // 先手工塞一条「上一版本接管过」的记录
  const source = path.join(profile, "node_modules", "dsh-jailbreak", "skills", "dsh-jailbreak-skill");
  writeFile(path.join(source, "SKILL.md"), "---\nname: dsh-jailbreak-skill\ndescription: x\n---\n正文\n");
  store.putSkill("dsh-jailbreak-skill", { summary: "x", origin: source, external: true, plugin: "dsh-jailbreak", source: "plugin" });
  const result = discoverPluginAssets({ store, profiles: [profile] });
  assert.equal(store.getSkill("dsh-jailbreak-skill"), undefined);
  assert.ok(result.pruned.some((item) => item.name === "dsh-jailbreak-skill"));
  assert.ok(fs.existsSync(path.join(source, "SKILL.md")), "插件里的文件必须还在");
});

test("加载方式：mode=skip 之后不进目录、不许 load；mode=lazy 恢复", async () => {
  const dataDir = tempDir("lt-data-");
  const store = new Store(dataDir);
  const skillDir = path.join(store.skillsDir, "demo");
  writeFile(path.join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: 演示\n---\n\n## 一\n正文一\n");
  store.putSkill("demo", { summary: "演示" });

  const log = { info() {}, warn() {}, error() {}, debug() {}, timed(event, fields, run) { return run(); } };
  const mcp = { listTools: async () => [], retain() {}, release() {}, closeServer: async () => {} };
  const injector = new Injector({ store, mcp, logger: console });
  const runtime = {
    store,
    mcp,
    injector,
    log,
    logger: console,
    config: { skillSectionMaxChars: 60000 },
    async workingDirectoryFor() {
      return dataDir;
    },
  };
  const tool = toolboxToolDefinition(runtime);
  const exec = { agent: { ctx: {} } };
  const call = async (args) => tool.execute(args, exec);

  const skipped = await call({ action: "mode", ids: ["skill:demo"], mode: "skip" });
  assert.match(skipped.text ?? skipped, /跳过/);
  assert.equal(store.isDisabled("skill", "demo"), true);

  const listed = await call({ action: "list" });
  assert.match(listed.text ?? listed, /设置里已关闭/);

  const lazy = await call({ action: "mode", ids: ["skill:demo"], mode: "lazy" });
  assert.match(lazy.text ?? lazy, /懒加载/);
  assert.equal(store.isDisabled("skill", "demo"), false);
});

test("action=skill：不带 section 给大纲，带 section 给那一节，找不到给可选列表", async () => {
  const dataDir = tempDir("lt-data2-");
  const store = new Store(dataDir);
  const skillDir = path.join(store.skillsDir, "ds");
  writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: ds\ndescription: 漫剧制作流程\n---\n\n总览一句话。\n\n## 立项\n先定题材。\n\n## 分镜\n把文字拆成镜头表。\n",
  );
  store.putSkill("ds", { summary: "漫剧制作流程", storePath: "skills/ds", origin: skillDir, source: "manual" });

  const log = { info() {}, warn() {}, error() {}, debug() {}, timed(event, fields, run) { return run(); } };
  const mcp = { listTools: async () => [], retain() {}, release() {}, closeServer: async () => {} };
  const injector = new Injector({ store, mcp, logger: console });
  const runtime = { store, mcp, injector, log, logger: console, config: { skillSectionMaxChars: 60000 } };
  const tool = toolboxToolDefinition(runtime);
  const exec = { agent: { ctx: {} } };
  const call = async (args) => tool.execute(args, exec);

  const outline = await call({ action: "skill", id: "skill:ds" });
  const outlineText = outline.text ?? outline;
  assert.match(outlineText, /skill:ds — 漫剧制作流程/);
  assert.match(outlineText, /立项 — 先定题材/);
  assert.match(outlineText, /分镜 — 把文字拆成镜头表/);
  assert.ok(!outlineText.includes("## 分镜"), "大纲不该包含小节标题下的正文块");

  const section = await call({ action: "skill", id: "skill:ds", section: "2" });
  const sectionText = section.text ?? section;
  assert.match(sectionText, /分镜/);
  assert.match(sectionText, /把文字拆成镜头表/);
  assert.doesNotMatch(sectionText, /先定题材/);

  const missing = await call({ action: "skill", id: "skill:ds", section: "9" });
  assert.match(missing.text ?? missing, /没有这一节/);
});
