/**
 * 大纲模式（lib/outline.js）：3 万 token 的 SKILL.md 只注入骨架 + 每节一句话，
 * 正文按 section 拉取。这里验证解析、层级编号、一句话摘要、按需切片。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildOutline, readSection, renderOutline, estimateTokens, firstSentence, plain } from "../lib/outline.js";

const SAMPLE = `---
name: ds
description: 漫剧制作流程
---

漫剧从脚本到成片的全流程：出本、分镜、配音、合成、投放。

## 1 立项
先定题材与目标观众，产出三句话的故事梗概。

### 1.1 题材
参考近期榜单，挑一个能连续更新的设定。

### 1.2 大纲
十二集，每集 90 秒，结尾留钩子。

## 2 分镜
把文字拆成镜头表，标注时长、景别、运镜。

\`\`\`text
镜头 1 | 3s | 特写 | 推
\`\`\`

## 3 配音
找声线，按角色分配，先试音再批量。
`;

test("解析：层级编号、标题、每节一句话", () => {
  const outline = buildOutline(SAMPLE);
  assert.deepEqual(
    outline.branches.map((branch) => `${branch.id}:${branch.level}:${branch.title}`),
    ["1:2:立项", "1.1:3:题材", "1.2:3:大纲", "2:2:分镜", "3:2:配音"],
  );
  const byTitle = new Map(outline.branches.map((branch) => [branch.title, branch]));
  assert.equal(byTitle.get("立项").id, "1");
  assert.equal(byTitle.get("题材").id, "1.1");
  assert.equal(byTitle.get("大纲").id, "1.2");
  assert.equal(byTitle.get("分镜").id, "2");
  assert.equal(byTitle.get("配音").id, "3");
  assert.match(byTitle.get("立项").gist, /先定题材与目标观众/);
  assert.match(byTitle.get("分镜").gist, /镜头表/);
});

test("frontmatter 不进正文；开头一句话单独给", () => {
  const outline = buildOutline(SAMPLE);
  assert.equal(outline.title, "立项", "首个标题作为标题（自带的序号去掉）");
  assert.match(outline.preamble, /漫剧从脚本到成片的全流程/);
  assert.doesNotMatch(outline.preamble, /name: ds/);
  assert.equal(outline.totalChars, SAMPLE.length);
});

test("代码块里的 # 不算标题", () => {
  const outline = buildOutline("# A\n\n```\n# 这不是标题\n```\n\n## B\n正文\n");
  assert.deepEqual(outline.branches.map((branch) => branch.title), ["A", "B"]);
});

test("大纲渲染：只有骨架，含取节指路，不含整篇正文", () => {
  const outline = buildOutline(SAMPLE);
  const text = renderOutline("ds", "漫剧制作流程", outline, { resourceDir: "D:/skills/ds" });
  assert.match(text, /skill:ds — 漫剧制作流程/);
  assert.match(text, /大纲模式/);
  assert.match(text, /1 立项 — 先定题材/);
  assert.match(text, /1\.1 题材/);
  assert.match(text, /toolbox \{ action: "skill", id: "skill:ds", section: "1"/);
  assert.match(text, /D:\/skills\/ds/);
  assert.doesNotMatch(text, /镜头 1 \| 3s \| 特写/, "正文里的代码块不该被塞进大纲");
});

test("三万 token 级的 skill：大纲只占原文的零头", () => {
  const big = Array.from({ length: 60 }, (_, index) =>
    `## 第 ${index + 1} 章 流程${index + 1}\n\n这一章讲第 ${index + 1} 步怎么做，注意点什么，出错怎么办。\n\n${"细节正文。".repeat(400)}\n`,
  ).join("\n");
  const outline = buildOutline(big);
  const text = renderOutline("ds", "漫剧制作流程", outline);
  assert.ok(big.length > 100000, "样本要够大：" + big.length);
  assert.ok(text.length < big.length / 20, `大纲应远小于原文：${text.length} vs ${big.length}`);
  assert.equal(outline.branches.length, 60);
});

test("按 id 取某一节：只回那一节", () => {
  const section = readSection(SAMPLE, "2");
  assert.equal(section.kind, "section");
  assert.equal(section.title, "分镜");
  assert.match(section.text, /把文字拆成镜头表/);
  assert.doesNotMatch(section.text, /立项/, "同级的其他节不该混进来");
});

test("取父节包含子节；取子节只到同级边界", () => {
  const parent = readSection(SAMPLE, "1");
  assert.match(parent.text, /### 1\.1 题材/);
  assert.match(parent.text, /### 1\.2 大纲/);
  const child = readSection(SAMPLE, "1.1");
  assert.match(child.text, /题材/);
  assert.doesNotMatch(child.text, /1\.2 大纲/, "子节应在下一个同级标题前收住");
});

test("section: all 给整篇；省略给大纲；找不到给出可选列表", () => {
  assert.equal(readSection(SAMPLE, "all").kind, "all");
  assert.equal(readSection(SAMPLE, "all").text, SAMPLE);
  assert.equal(readSection(SAMPLE, "").kind, "outline");
  const missing = readSection(SAMPLE, "9.9");
  assert.equal(missing.kind, "missing");
  assert.ok(missing.available.some((item) => item.includes("分镜")));
});

test("允许按标题片段取节", () => {
  const section = readSection(SAMPLE, "配音");
  assert.equal(section.kind, "section");
  assert.equal(section.id, "3");
});

test("没有标题的 skill 兜底给开头，不至于抓瞎", () => {
  const flat = "只有一段说明，没有任何标题。".repeat(200);
  const outline = buildOutline(flat);
  assert.equal(outline.branches.length, 0);
  const text = renderOutline("flat", "无分节", outline);
  assert.match(text, /没有分节标题/);
  assert.ok(text.length < flat.length);
});

test("工具函数：plain / firstSentence / estimateTokens", () => {
  assert.equal(plain("**粗** 和 `代码` 与 [链接](http://x)"), "粗 和 代码 与 链接");
  assert.equal(firstSentence("第一句话。第二句话。"), "第一句话。");
  assert.equal(estimateTokens(2600), 1000);
});
