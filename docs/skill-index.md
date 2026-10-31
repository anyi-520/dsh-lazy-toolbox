# skill 注入方式：大纲模式（默认）

一句话：**load 一个 skill 只给你「骨架 + 每节一句话」，要看正文再要。**

## 为什么

一个讲「漫剧制作流程」的 skill，正文三万字，约 3 万 token。绝大多数回合只用得到其中
一两节（比如「分镜」），把整篇塞进上下文既贵又冲淡重点。所以：

| | 注入内容 | 量级 |
| --- | --- | --- |
| `full`（老行为） | 整个 SKILL.md | 3 万 token 级 |
| `index`（默认） | 标题 + 每节一句话 + 取节指路 | 几百 token |

`load` 之后 AI 看到的是这样：

```
# skill:ds — 漫剧制作流程
（当前按「大纲模式」加载：这里只有骨架，正文共 1200 行 / 42000 字符 ≈ 16153 token，没有整篇塞进上下文。）

## 分支（每节一句话）
- 1 立项 — 先定题材与目标观众，产出三句话的故事梗概。
-   1.1 题材 — 参考近期榜单，挑一个能连续更新的设定。
-   1.2 大纲 — 十二集，每集 90 秒，结尾留钩子。
- 2 分镜 — 把文字拆成镜头表，标注时长、景别、运镜。
- 3 配音 — 找声线，按角色分配，先试音再批量。

## 要看全文怎么取
- 某一节：toolbox { action: "skill", id: "skill:ds", section: "1" }
- 整篇（慎用）：toolbox { action: "skill", id: "skill:ds", section: "all" }
- 只要大纲（默认）：不要 section 参数即可

资源目录：<skill 目录>
```

需要细节时，AI 再调一次：

```jsonc
toolbox { "action": "skill", "id": "skill:ds", "section": "2" }   // 只要「分镜」那一节
toolbox { "action": "skill", "id": "skill:ds", "section": "all" } // 整篇（带 6 万字符上限）
```

**没有新增任何工具**：取节用的是常驻的 `toolbox`，所以工具定义数量一个没多。

## 怎么切回整篇

某一篇必须整篇照做（很短的、强顺序的 skill），三种方式任选：

```jsonc
// 1) store.json 里给单个 skill 指定
{ "skills": { "my-skill": { "loadMode": "full" } } }
```

```yaml
# 2) 全局：cordis.patch.yml 的插件 config
config:
  skillInjectMode: full
```

```bash
# 3) CLI 看两种结果的差别
node bin/cli.mjs skill ds              # 大纲
node bin/cli.mjs skill ds --section all # 整篇
```

## 细节

- **分节**：按 ATX 标题（`#` ~ `######`）切；代码块里的 `#` 不算；标题里自带的序号
  （`## 1 立项`）显示时去掉，编号由大纲自己算（`1`、`1.1`、`1.2`…）。
- **一句话**：取该节第一段正文的第一句（跳过代码块、表格、分隔线），上限 140 字。
- **取节边界**：某节包含它的子节，到下一个同级或更高级标题为止。
- **查不到**：返回可选节列表，AI 不至于抓瞎。
- **没有标题的 skill**：给开头 1200 字符 + 提示用 `section:"all"`。
- **上限**：单次回传默认 6 万字符（`skillSectionMaxChars`），超了截断并说明。
- **资源文件**：大纲里带上「资源目录」，附属文件（references/、scripts/）AI 用 shell 直接读，不占注入。
