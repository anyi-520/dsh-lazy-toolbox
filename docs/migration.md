# 迁移与还原语义

## 一句话

**搬走时不丢信息，还原时按原样放回**；冲突一律跳过，从不覆盖。

## MCP：条目级搬运

来源：`$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里的

```yaml
- id: mcp-github
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    transport: stdio
    serverName: github
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env: { GITHUB_TOKEN: "..." }
```

迁移时：

- `findMcpEntries` 按顶格 `- ` 切块，只认 `name` 为 `@deepseek-ai/dsh-mcp-client` 的块；
- 子集解析器读 `config` 的标量 / 列表 / 映射；遇到 `!!js` 等表达式标记为「不支持」并**整块保留原样**
  （插件不替你执行任意表达式）；
- 写入 `store.json` 的 `mcp.servers.<serverName>`，字段：`summary / transport / command / args / env /
  cwd / url / headers / toolCallTimeoutMs`；
- 从原文删除该块，把 `{ id, text, index }` 追加到 `store.restore.profiles[<profileDir>].removed`。

还原时：`insertEntries` 按 `index` 从后往前插回 → 其它条目的增删不影响落点。
若 `cordis.patch.yml` 在此期间被外部改过，先复制成 `cordis.patch.yml.lazy-toolbox-backup` 再写。

同一个 profile 多次迁移会累积记录；`restore` 一次性写回并清空记录。

**跳过的情形**（会打印原因，不阻断其它条目）：

| 情形 | 处理 |
| --- | --- |
| 缺 `serverName` | 跳过 |
| `config` 含 `!!js` 表达式 | 跳过（保持原样） |
| stdio 缺 `command` / http 缺 `url` | 跳过 |
| 插件库里已有同名服务 | 跳过，原行保留 |

## skill：目录级搬运

来源根目录（按 DSH 的 rank 顺序，只处理存在且未被更高优先级覆盖的）：

| 根 | 说明 |
| --- | --- |
| `<project>/.dsh/skills` | 项目级（`autoImportProjectSkills` 开启才处理） |
| `<project>/.agents/skills` | 项目级 |
| `$DSH_HOME/skills` | 用户级 |
| `~/.agents/skills` | 用户级（跨工具共享） |

单元 = 含 `SKILL.md` 的目录，或扁平的 `*.md`（frontmatter 必须有 `name` + `description`；
`name` 需匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`）。

迁移时整体移动到 `$DSH_HOME/lazy-toolbox/skills/<name>/`（同盘 `rename`，跨盘复制后删源），
原路径与形态（dir/file）记进 `store.restore.skills`。

还原时按记录把目录/文件移回原位；目标已存在则跳过并报告。

## 运行期自动导入

`agent/pre-step` 里按 `scanIntervalMs` 节流：

- 标准 skill 目录里出现新单元（例如模型刚 `git clone` 下来一个 skill）→ 立刻搬进插件库，
  于是它**不会**被 DSH 当成全局 skill，但会出现在你的目录里；
- profile 的 `cordis.patch.yml` 里出现新的 `mcp-client` 行 → 搬进插件库。
  此时用 `toolbox load` 就能立刻用；要让它从全局工具定义里彻底消失，需要重启一次。

失败只 `logger.warn`，不影响对话。

## 幂等与并发

- 迁移与还原都按名字/行号判定，重复执行不会重复搬；
- `store.json` 写入用原子替换（临时文件 + rename），不会出现半截 JSON；
- 插件卸载时的还原在 `preuninstall` 里做，顺序固定：先还原文件，再摘接线。
