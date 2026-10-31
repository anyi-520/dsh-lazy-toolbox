---
name: release-notes
description: 按提交记录生成发版说明，包含变更分类、影响面与升级提示。
whenToUse: 用户要发版、写 release notes、整理 CHANGELOG 时。
---

# 发版说明生成

1. 取区间：`git log --oneline <last-tag>..HEAD`，没有 tag 时用最近 50 条。
2. 分类：feat / fix / perf / refactor / docs / chore，按约定式提交前缀判断。
3. 每条写「改了什么 + 影响谁」，不要复述标题。
4. 破坏性变更单列，并给出迁移步骤。
5. 结尾给「升级提示」：是否需要重装依赖、是否要迁移数据。

输出结构：

```markdown
## <version> (<date>)

### 新增
- ...

### 修复
- ...

### 破坏性变更
- ...（如何迁移）
```
