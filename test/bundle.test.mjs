import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { TOOLBOX_ID, TOOLBOX_NAME, ensureProfileBodyInsert } from "../lib/profile.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const patchFile = path.join(root, "cordis.patch.yml");
const patchText = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, "utf8") : "";

test("声明了 dsh.bundle.patch，且文件真的在包里", () => {
  assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml", "DSH 的「添加插件」按这个字段判断能不能当组合包装");
  assert.ok(fs.existsSync(patchFile), "cordis.patch.yml 必须存在");
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes("cordis.patch.yml"), "打包清单要带上它");
  assert.equal(pkg.exports?.["./cordis.patch.yml"], "./cordis.patch.yml", "子路径也导出，便于别处读取");
});

test("patch 里插的是本插件这一行（id / name / inject / config）", () => {
  assert.match(patchText, /^-\s*insert:/m);
  assert.match(patchText, new RegExp(`^\\s*-\\s*id:\\s*${TOOLBOX_ID}\\s*$`, "m"));
  assert.match(patchText, new RegExp(`^\\s*name:\\s*${TOOLBOX_NAME}\\s*$`, "m"));
  assert.match(patchText, /^\s*inject:\s*\[systemPrompt, tools, webServer\]\s*$/m);
  assert.match(patchText, /^\s*autoImport:\s*true$/m);
  assert.match(patchText, /^\s*autoUnloadOnTurnEnd:\s*true$/m);
  assert.equal(TOOLBOX_NAME, pkg.name, "patch 里的 name 必须等于包名");
});

test("patch 的 name 与插件导出的 name 对得上（别写成两套）", async () => {
  const mod = await import("../lib/index.js");
  assert.equal(mod.name, TOOLBOX_ID, "插件导出的 name 是 profile 里的行 id");
  assert.deepEqual(mod.inject, ["systemPrompt", "tools", "webServer"]);
});

test("两种装法写进 profile 的条目一致（bundle patch 与 wire-profile）", () => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? "/tmp", "lt-bundle-"));
  const result = ensureProfileBodyInsert(dir);
  assert.equal(result.ok, true);
  const written = fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8");
  const bundle = patchText.replace(/#.*$/gm, "").replace(/\s+/g, " ").trim();
  const wire = written.replace(/#.*$/gm, "").replace(/\s+/g, " ").trim();
  assert.equal(wire, bundle, "cordis.patch.yml（组合包）和 wire-profile 写出来的应该是同一段");
});

test("YAML 没有 Tab 缩进（DSH 的解析器不吃 Tab）", () => {
  assert.equal(/^\t/m.test(patchText), false);
  for (const line of patchText.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.match(/^ */)[0].length;
    assert.equal(indent % 2, 0, `缩进 ${indent} 不是 2 的倍数：${line}`);
  }
});
