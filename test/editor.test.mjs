import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectKind, formatValidation, offsetToLineColumn, patchCode, readCode, revertCode, validateCode, writeCode } from "../lib/editor.js";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lt-editor-"));
}

test("按扩展名认类型", () => {
  assert.equal(detectKind("a.js"), "js");
  assert.equal(detectKind("a.mjs"), "js");
  assert.equal(detectKind("a.json"), "json");
  assert.equal(detectKind("a.yml"), "yaml");
  assert.equal(detectKind("a.yaml"), "yaml");
  assert.equal(detectKind("a.md"), "markdown");
  assert.equal(detectKind("a.bin"), "text");
});

test("字符偏移换算成行列", () => {
  const text = "aa\nbbb\nc";
  assert.deepEqual(offsetToLineColumn(text, 0), { line: 1, column: 1 });
  assert.deepEqual(offsetToLineColumn(text, 3), { line: 2, column: 1 });
  assert.deepEqual(offsetToLineColumn(text, 6), { line: 2, column: 4 });
  assert.deepEqual(offsetToLineColumn(text, 999), { line: 3, column: 2 });
});

test("JS 语法错能给出准确行列（真解析器，不是正则）", async () => {
  const result = await validateCode({ file: "x.mjs", content: "const a = ;\n" });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "js");
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].line, 1);
  assert.ok(result.errors[0].column > 0);
  assert.match(result.errors[0].message, /Unexpected token/);
});

test("ESM 语法能过（export / import 不被当成错误）", async () => {
  const result = await validateCode({ file: "x.mjs", content: 'import fs from "node:fs";\nexport const a = () => fs.existsSync(".");\n' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("JSON 坏在第三行时指向第三行", async () => {
  const result = await validateCode({ file: "x.json", content: '{\n  "a": 1,\n  b: 2\n}' });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].line, 3);
});

test("YAML 抓 Tab 缩进与括号不配平", async () => {
  const tabbed = await validateCode({ file: "x.yml", content: "a:\n\t- 1\n" });
  assert.equal(tabbed.ok, false);
  assert.match(tabbed.errors[0].message, /Tab/);
  assert.ok(tabbed.notes.some((note) => /浅校验/.test(note)));

  const bracket = await validateCode({ file: "x.yaml", content: "a: [1, 2\n" });
  assert.equal(bracket.ok, false);
  assert.match(bracket.errors.at(-1).message, /括号/);
});

test("未知类型直接放过，但说明没校验", async () => {
  const result = await validateCode({ file: "x.txt", content: "随便什么 {{{" });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "text");
});

test("write：校验不过不落盘；force 才写", async () => {
  const root = tempRoot();
  const file = path.join(root, "a.mjs");
  const blocked = await writeCode({ root, file, content: "const a = ;\n" });
  assert.equal(blocked.written, false);
  assert.equal(fs.existsSync(file), false, "校验失败不能落盘");
  assert.match(blocked.message, /没有写入/);

  const forced = await writeCode({ root, file, content: "const a = ;\n", force: true });
  assert.equal(forced.written, true);
  assert.equal(forced.forced, true);
  assert.equal(fs.readFileSync(file, "utf8"), "const a = ;\n");
});

test("write：覆盖前留备份，revert 能回去", async () => {
  const root = tempRoot();
  const file = path.join(root, "b.mjs");
  await writeCode({ root, file, content: "export const v = 1;\n" });
  await writeCode({ root, file, content: "export const v = 2;\n" });
  assert.equal(fs.readFileSync(file, "utf8"), "export const v = 2;\n");
  const reverted = revertCode({ root, file });
  assert.equal(fs.readFileSync(file, "utf8"), "export const v = 1;\n");
  assert.ok(fs.existsSync(reverted.from));
});

test("read：带行数、类型、mtime；过大的文件拒读", async () => {
  const root = tempRoot();
  const file = path.join(root, "c.json");
  fs.writeFileSync(file, '{\n  "a": 1\n}\n', "utf8");
  const result = readCode({ file });
  assert.equal(result.kind, "json");
  assert.equal(result.lines, 4);
  assert.ok(result.mtime.includes("T"));
  assert.throws(() => readCode({ file, maxBytes: 3 }), /文件太大/);
  assert.throws(() => readCode({ file: path.join(root, "无此文件.js") }), /文件不存在/);
});

test("patch：唯一才替换，多处要 all=true", () => {
  const once = patchCode({ content: "a\nb\nc", find: "b", replace: "B" });
  assert.equal(once.content, "a\nB\nc");
  assert.equal(once.replaced, 1);
  assert.throws(() => patchCode({ content: "x x", find: "x", replace: "y" }), /出现 2 次/);
  const all = patchCode({ content: "x x", find: "x", replace: "y", all: true });
  assert.equal(all.content, "y y");
  assert.equal(all.replaced, 2);
  assert.throws(() => patchCode({ content: "abc", find: "z", replace: "y" }), /找不到/);
});

test("formatValidation 把错误写成能读的行", async () => {
  const bad = await validateCode({ file: "x.mjs", content: "const a = ;\n" });
  const text = formatValidation(bad);
  assert.match(text, /❌ 校验没通过（js）/);
  assert.match(text, /第 1 行/);
  const good = formatValidation(await validateCode({ file: "x.mjs", content: "export const a = 1;\n" }));
  assert.match(good, /✅ 校验通过/);
});
