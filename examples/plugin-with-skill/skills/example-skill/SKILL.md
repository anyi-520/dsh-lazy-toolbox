---
name: example-skill
description: 示例 skill：插件自己带的能力，装上插件后懒工具箱会自动登记它
---

# 示例 skill

这个文件放在插件包的 `skills/<名字>/SKILL.md`，插件装进 profile 之后，
懒工具箱会在下一次扫描时把它登记成 `skill:example-skill`。

- 目录里会出现这一条（一句话用途来自上面的 `description`）；
- AI 需要时用 `toolbox { action: "load", ids: ["skill:example-skill"] }` 注入；
- 条目是**原地引用**：插件升级改了这里的正文，下次 load 就是新内容，不用重新导入。

## 具体步骤

1. 读一下相关文件
2. 干活
3. 把结论写清楚
