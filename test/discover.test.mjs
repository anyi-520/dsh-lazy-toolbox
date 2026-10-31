/**
 * 插件内置资产自动接管（lib/discover.js）的测试。
 * 用一个假的 profile 目录，造两个插件包，验证：发现、原地引用、幂等、
 * 尊重开关、卸载插件后回收、外部条目删除时不动插件文件。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverPluginAssets, detectPluginAssets, pluginCandidates, pluginSignature } from "../lib/discover.js";
import { deleteSkillFiles, loadSkill } from "../lib/skills.js";
import { Store } from "../lib/store.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

/** 造一个 profile：node_modules 下两个插件，一个用 manifest 声明，一个用约定目录。 */
function makeProfile() {
  const profile = tempDir("lt-profile-");

  // 插件 A：manifest 声明 skill + mcp
  const a = path.join(profile, "node_modules", "plugin-a");
  writeFile(
    path.join(a, "package.json"),
    JSON.stringify({ name: "plugin-a", version: "1.0.0", dsh: { skills: ["skills"], mcp: { "demo-mcp": { command: "node", args: ["server.js"] } } } }, null, 2),
  );
  writeFile(path.join(a, "skills", "handoff", "SKILL.md"), "---\nname: handoff\ndescription: 交接班工作流，把当前状态写成一份交接文档\n---\n正文\n");

  // 插件 B：走约定（skills/ + mcp.json），并且声明 autoDetect:false 的反例在插件 C
  const b = path.join(profile, "node_modules", "@scope", "plugin-b");
  writeFile(path.join(b, "package.json"), JSON.stringify({ name: "@scope/plugin-b", version: "2.0.0" }, null, 2));
  writeFile(path.join(b, "skills", "pdf-kit", "SKILL.md"), "---\nname: pdf-kit\ndescription: PDF 处理工具箱\n---\n正文\n");
  writeFile(
    path.join(b, "mcp.json"),
    JSON.stringify({ mcpServers: { "pdf-server": { url: "https://example.invalid/mcp", headers: { authorization: "x" } } } }, null, 2),
  );

  // 插件 C：明确 opt-out
  const c = path.join(profile, "node_modules", "plugin-c");
  writeFile(path.join(c, "package.json"), JSON.stringify({ name: "plugin-c", dsh: { autoDetect: false, skills: ["skills"] } }, null, 2));
  writeFile(path.join(c, "skills", "ignored", "SKILL.md"), "---\nname: ignored\ndescription: 不该被接管\n---\n正文\n");

  return profile;
}

test("发现：manifest 声明 + 约定目录，opt-out 的跳过", () => {
  const profile = makeProfile();
  const candidates = pluginCandidates({ profiles: [profile] });
  assert.equal(candidates.length, 3, "应看到 3 个插件包（含 @scope 里的）");
  assert.ok(pluginSignature(candidates).length > 8, "指纹应可计算");

  const byName = new Map(pluginCandidates({ profiles: [profile] }).map((item) => [item.name, item]));
  const a = detectPluginAssets(byName.get("plugin-a"));
  assert.deepEqual(a.skills.map((item) => item.name), ["handoff"]);
  assert.equal(a.skills[0].summary, "交接班工作流，把当前状态写成一份交接文档");
  assert.deepEqual(a.servers.map((item) => item.name), ["demo-mcp"]);
  assert.equal(a.servers[0].config.transport, "stdio");

  const b = detectPluginAssets(byName.get("@scope/plugin-b"));
  assert.deepEqual(b.skills.map((item) => item.name), ["pdf-kit"]);
  assert.deepEqual(b.servers.map((item) => item.name), ["pdf-server"]);
  assert.equal(b.servers[0].config.transport, "streamable-http");
  assert.equal(b.servers[0].config.headers.authorization, "x");

  // opt-out 的体现在 discoverPluginAssets 里
  const store = new Store(tempDir("lt-store-"));
  const result = discoverPluginAssets({ store, profiles: [profile] });
  assert.deepEqual(result.skills.map((item) => item.name).sort(), ["handoff", "pdf-kit"]);
  assert.deepEqual(result.servers.map((item) => item.name).sort(), ["demo-mcp", "pdf-server"]);
  assert.equal(store.getSkill("ignored"), undefined, "autoDetect:false 的插件不应被接管");
});

test("接管是原地引用：不复制文件，skill 直接从插件目录读", () => {
  const profile = makeProfile();
  const store = new Store(tempDir("lt-store-"));
  discoverPluginAssets({ store, profiles: [profile] });

  const entry = store.getSkill("handoff");
  assert.equal(entry.external, true);
  assert.equal(entry.plugin, "plugin-a");
  assert.equal(entry.source, "plugin");
  assert.ok(fs.existsSync(entry.origin), "origin 指向插件里的真实目录");
  assert.equal(store.skillPath(entry), entry.origin, "库里的路径就是插件里的路径");
  assert.equal(fs.existsSync(path.join(store.skillsDir, "handoff")), false, "不应在库里复制一份");

  const loaded = loadSkill(store, "handoff");
  assert.match(loaded.content, /正文/);
  assert.equal(loaded.resourceDir, entry.origin);
});

test("幂等：第二次扫描不重复登记；签名没变就直接返回", () => {
  const profile = makeProfile();
  const store = new Store(tempDir("lt-store-"));
  const state = { signature: "" };
  const first = discoverPluginAssets({ store, profiles: [profile], state });
  assert.equal(first.changed, true);
  assert.equal(first.skills.length, 2);

  const second = discoverPluginAssets({ store, profiles: [profile], state });
  assert.equal(second.changed, false);
  assert.equal(second.skills.length, 0);
  assert.equal(store.listSkills().length, 2, "不应出现重复条目");
});

test("在设置里关掉的条目不再自动接管", () => {
  const profile = makeProfile();
  const store = new Store(tempDir("lt-store-"));
  store.setDisabled("skill", "handoff", true);
  const result = discoverPluginAssets({ store, profiles: [profile] });
  assert.equal(store.getSkill("handoff"), undefined);
  assert.ok(result.skipped.some((item) => item.kind === "skill" && item.reason.includes("关掉")));
  assert.ok(store.getSkill("pdf-kit"), "其他条目照常接管");
});

test("插件被卸载后，条目在下一轮回收", () => {
  const profile = makeProfile();
  const store = new Store(tempDir("lt-store-"));
  discoverPluginAssets({ store, profiles: [profile] });
  assert.equal(store.listSkills().length, 2);

  fs.rmSync(path.join(profile, "node_modules", "plugin-a"), { recursive: true, force: true });
  const result = discoverPluginAssets({ store, profiles: [profile] });
  assert.deepEqual(result.pruned.map((item) => item.name).sort(), ["demo-mcp", "handoff"]);
  assert.equal(store.getSkill("handoff"), undefined);
  assert.equal(store.getServer("demo-mcp"), undefined, "插件带的 MCP 也要一起回收");
  assert.ok(store.getSkill("pdf-kit"), "别的插件不受影响");
});

test("删除外部条目时只删登记，不动插件里的文件", () => {
  const profile = makeProfile();
  const store = new Store(tempDir("lt-store-"));
  discoverPluginAssets({ store, profiles: [profile] });
  const entry = store.getSkill("pdf-kit");
  const skillFile = path.join(entry.origin, "SKILL.md");
  assert.ok(fs.existsSync(skillFile));

  const outcome = deleteSkillFiles(store, "pdf-kit");
  assert.equal(outcome.external, true);
  assert.equal(outcome.removed, false);
  assert.ok(fs.existsSync(skillFile), "插件里的 SKILL.md 必须还在");
});

test("MCP 条目带上来源，且能按名字查回来", () => {
  const profile = makeProfile();
  const store = new Store(tempDir("lt-store-"));
  discoverPluginAssets({ store, profiles: [profile] });
  const server = store.getServer("demo-mcp");
  assert.equal(server.plugin, "plugin-a");
  assert.equal(server.source, "plugin");
  assert.equal(server.transport, "stdio");
  assert.deepEqual(server.args, ["server.js"]);
});

test("package.json 带 BOM（记事本存过）也能正常发现", () => {
  const profile = makeProfile();
  const bomPlugin = path.join(profile, "node_modules", "plugin-bom");
  writeFile(
    path.join(bomPlugin, "package.json"),
    `\uFEFF${JSON.stringify({ name: "plugin-bom", dsh: { skills: ["skills"] } }, null, 2)}`,
  );
  writeFile(path.join(bomPlugin, "skills", "bom-skill", "SKILL.md"), "---\nname: bom-skill\ndescription: 带 BOM 的插件\n---\n正文\n");

  const store = new Store(tempDir("lt-store-"));
  const result = discoverPluginAssets({ store, profiles: [profile] });
  assert.ok(result.skills.some((item) => item.name === "bom-skill"), "BOM 不该让插件被静默跳过");
  assert.equal(store.getSkill("bom-skill").plugin, "plugin-bom");
});
