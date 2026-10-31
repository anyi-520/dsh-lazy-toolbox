import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../lib/store.js";
import {
  discoverSkillUnits,
  importSkillUnit,
  loadSkill,
  renderSkillContent,
  restoreSkillUnit,
  skillRoots,
} from "../lib/skills.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeSkill(root, name, description = "演示 skill") {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\n正文内容\n`,
    "utf8",
  );
  return dir;
}

test("skill 搬入 → 加载 → 还原", () => {
  const home = tempDir("lazy-home-");
  const root = path.join(home, "skills");
  fs.mkdirSync(root, { recursive: true });
  const dir = makeSkill(root, "demo-skill", "演示一段工作流程。第二句不要");

  const store = new Store(path.join(home, "lazy-toolbox"));
  const units = discoverSkillUnits(root);
  assert.equal(units.length, 1);
  assert.equal(units[0].name, "demo-skill");

  const imported = importSkillUnit({ store, unitPath: dir, kind: "dir", source: "migrate" });
  assert.equal(imported.name, "demo-skill");
  assert.equal(imported.summary, "演示一段工作流程");
  assert.equal(fs.existsSync(dir), false, "原目录应已搬走");
  store.addRestoreSkill({ name: imported.name, origin: dir, originKind: "dir" });

  const skill = loadSkill(store, "demo-skill");
  assert.match(skill.content, /正文内容/);
  assert.match(renderSkillContent(skill), /<skill_content name="demo-skill">/);

  const restored = restoreSkillUnit(store, { name: "demo-skill", origin: dir, originKind: "dir" });
  assert.equal(restored.ok, true);
  assert.equal(fs.existsSync(path.join(dir, "SKILL.md")), true);
});

test("单文件 skill 也能搬入并还原成单文件", () => {
  const home = tempDir("lazy-home-file-");
  const file = path.join(home, "flat.md");
  fs.writeFileSync(file, "---\nname: flat-skill\ndescription: 单文件 skill\n---\n内容\n", "utf8");
  const store = new Store(path.join(home, "lazy-toolbox"));
  const imported = importSkillUnit({ store, unitPath: file, kind: "file", source: "manual" });
  assert.equal(imported.name, "flat-skill");
  assert.equal(fs.existsSync(file), false);
  const restored = restoreSkillUnit(store, { name: "flat-skill", origin: file, originKind: "file" });
  assert.equal(restored.ok, true);
  assert.equal(fs.existsSync(file), true);
});

test("skillRoots 只返回存在的目录", () => {
  const home = tempDir("lazy-home-roots-");
  const agents = path.join(home, ".agents");
  fs.mkdirSync(path.join(home, "skills"), { recursive: true });
  fs.mkdirSync(path.join(agents, "skills"), { recursive: true });
  const roots = skillRoots({ dshHome: home, agentsHome: agents, cwd: home, includeProject: true });
  // cwd 就是 home，所以 project-agents 与 user-agents 指向同一个目录，两条都出现
  assert.deepEqual(roots.map((root) => root.source), ["project-agents", "user-dsh", "user-agents"]);
});

test("store 持久化可往返", () => {
  const home = tempDir("lazy-home-store-");
  const store = new Store(path.join(home, "lazy-toolbox"));
  store.putSkill("a-skill", { summary: "一个 skill", storePath: "skills/a-skill" });
  store.putServer("demo", { summary: "一个 MCP", transport: "stdio", command: "node" });
  const again = new Store(path.join(home, "lazy-toolbox"));
  assert.equal(again.getSkill("a-skill").summary, "一个 skill");
  assert.equal(again.getServer("demo").command, "node");
  assert.equal(again.listSkills().length, 1);
  assert.equal(again.listServers().length, 1);
});
