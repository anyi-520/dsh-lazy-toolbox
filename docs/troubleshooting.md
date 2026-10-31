# 排障

## 先跑自检

```bash
dsh-lazy-toolbox doctor
```

它会打印 `DSH_HOME`、插件库位置、`store.json` 是否存在、版本、每个 profile 的链接状态，以及登记的 MCP。

## 插件没生效（系统提示里没有「懒工具箱」段）

1. `cordis.patch.yml` 里有没有 insert 行（id `lazy-toolbox`），`inject` 是否写了 `[systemPrompt, tools]`；
2. `package.json` 的 `dsh.profile.bundles` 里有没有 `dsh-lazy-toolbox`；
3. profile 的 `node_modules/dsh-lazy-toolbox` 是否存在、能否解析（`dsh-lazy-toolbox doctor` 的 `linked=`）；
4. DSH 的日志里搜 `lazy-toolbox`：正常会看到
   `lazy-toolbox: 已启用（数据目录 …）`。

插件声明了 `inject: ["systemPrompt", "tools"]`，任何一个服务缺失都会让它停在 pending 状态 —— 不会有报错，
只是不生效。这也是为什么 insert 行的 `inject` 要与之一致。

## `toolbox load` 报「当前 agent 没有可用的 scoped ctx」

说明执行时拿不到 `agent.ctx`。常见原因：

- 在非 agent 上下文里调用（例如某个后台任务）；
- 工具以 PTC/受限模式运行，作用域代理不可用。

`exec.agent` 缺失时插件会退回 `ctx.agents.requireInitiator()`；两者都没有就会报这个错。

## MCP 连不上

```bash
dsh-lazy-toolbox add-mcp demo --command "npx" --args "-y some-mcp" --verify
```

- Windows 上 `.cmd/.bat` 会经 `ComSpec /d /s /c` 执行；裸命令名会在 `PATH` 里查找；
- `command` 找不到 → 检查绝对路径或换 `process.execPath`；
- HTTP 传输：`--url http://127.0.0.1:PORT/mcp`，需要服务支持 `initialize` + `tools/list`，SSE 用 `data:` 帧；
- 连上但 0 个工具 → `toolbox list ids:["mcp:<name>"]` 看服务端到底暴露了什么。

## 工具名对不上

MCP 工具名统一为 `mcp__<server>__<rawName>`，长度上限 64，非法字符替换为 `_`；
超长或有损归一化时追加 12 位 hash 后缀。与 DSH 原生命名一致，所以迁移前后模型看到的名字不变。

## 目录里没有某条 skill

- 它的 `SKILL.md` frontmatter 缺 `name`/`description`，或 `name` 不符合 kebab 规则 → 会被跳过；
- 它在 `$DSH_HOME/skills` 之外的根（例如项目目录）而 `autoImportProjectSkills` 是 `false`；
- 同名项已在插件库里，新的被跳过（先 `toolbox remove skill:<name>` 或 `migrate --dry-run` 确认）。

## 想立刻验证迁移结果但不落盘

```bash
dsh-lazy-toolbox migrate --dry-run
```

## 还原失败 / 想手动还原

```bash
dsh-lazy-toolbox restore --mcp-only      # 只写回 MCP 行
dsh-lazy-toolbox restore --skills-only   # 只移回 skill 目录
```

写回前会备份成 `cordis.patch.yml.lazy-toolbox-backup`。若目标 skill 目录已被占用，会跳过并说明。

## 回合结束后工具又不见了

这是 `autoUnloadOnTurnEnd: true` 的预期行为：每轮结束把注入的定义还回去，控制请求体积。
需要跨轮常驻就把它设为 `false`（或在 prompt 里让模型每轮重新 `load`）。

## 数据在哪

```
$DSH_HOME/lazy-toolbox/
  store.json          目录、MCP 配置、待还原记录
  skills/<name>/      搬进来的 skill 单元
```

删掉整个目录等于「放弃还原记录」——**先 `restore` 再删**。
