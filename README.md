# dsh-lazy-toolbox

> 把 skill 和 MCP 从「每个对话都塞进工具定义」改成「列个目录，用时才注入」。

DSH（DeepSeek Harness）默认会把所有 skill、所有 MCP 服务的**完整工具定义**（名字 + 描述 + 参数 schema）
推进每一次请求。装的 skill / MCP 越多，每轮对话要付的 token 越大、模型挑工具的噪声越高。

`dsh-lazy-toolbox` 做三件事：

1. **搬走**：安装时把本机 skill 目录、profile 里的 `mcp-client` 配置整体搬进插件库，DSH 因此不再把它们
   放进全局工具定义。卸载时按原文原位置还原。
2. **留目录**：系统提示里只留一份清单 —— `skill` 与 `mcp` 分开列，每条一句话用途，**不含任何调用参数**。
3. **热加载**：模型需要时调用 `toolbox`，把那一项的定义注册进**当前会话**（`agent.ctx` 作用域，只影响这一个
   对话），用完 `unload` 撤掉，下一轮请求立刻变小。

```
安装前                         安装后
┌──────────────────┐          ┌──────────────────┐
│ tool: mcp__gh__x │          │ tool: toolbox    │  ← 常驻，唯一的入口
│ tool: mcp__gh__y │          │ prompt: 目录     │  ← skill/mcp 各一行，无 schema
│ tool: mcp__db__q │          └──────────────────┘
│ ... 40 个         │                    │ load
└──────────────────┘                    ▼
                              ┌──────────────────┐
                              │ 本会话工具表       │  ← 只有此刻需要的定义
                              └──────────────────┘
```

## 快速开始

### 从本地目录接入（开发 / 自用）

```bash
# 1) 把插件接到 profile（bundles + insert 行 + node_modules 链接，幂等）
dsh-lazy-toolbox wire-profile

# 2) 重启 dsh，插件首次启动会自动迁移本机 skill 与 MCP 配置
```

也可以让 dsh 的插件管理器装它，或直接写进 profile：

```jsonc
// $DSH_HOME/profiles/<profile>/package.json
{
  "dependencies": { "dsh-lazy-toolbox": "link:D:/path/to/dsh-lazy-toolbox" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "...", "dsh-lazy-toolbox"] } }
}
```

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml 末尾
- insert:
    - id: lazy-toolbox
      name: dsh-lazy-toolbox
      inject: [systemPrompt, tools]
      config:
        autoImport: true
        autoUnloadOnTurnEnd: true
```

### 从 npm 安装

```bash
npm i -g dsh-lazy-toolbox
dsh-lazy-toolbox wire-profile
```

## 模型看到什么

系统提示里多出这样一段（节选）：

```markdown
## 懒工具箱（skill / MCP 按需加载）
下面这些能力**已经安装但不在当前工具列表里**（所以你看不到它们的参数）。需要时调用 `toolbox`：
- `toolbox { action: "load", ids: ["skill:<名字>" 或 "mcp:<服务>" 或 "mcp:<服务>:<工具>"] }` 把定义注入本会话；
- `toolbox { action: "unload", ids: [...] }`（或 `all: true`）把定义撤掉，减少后续请求体积；
- `toolbox { action: "list", ids: [...] }` 展开某个 MCP 服务的工具清单；
- 用户要求安装新的 skill / MCP 时用 `action: "add_skill" / "add_mcp"`，并给一句话 `summary`。

skills:
- skill:release-notes — 按提交记录生成发版说明 [已加载]
- skill:sql-review — SQL 变更评审清单

mcp:
- mcp:github — GitHub 仓库、Issue 与 PR 操作，38 个工具
- mcp:postgres — 只读 SQL 查询
```

`load` 之后该会话的工具表里才会出现 `mcp__github__*`；`unload`（或回合结束）后消失。
目录里的 `[已加载]` 是给模型的状态提示，不影响其他会话。

### 新会话不会被蒙在鼓里

光有目录还不够：模型容易扫一眼就当没看见，直接凭记忆答。所以插件另外注册了一个
**运行时上下文提醒**（`systemPrompt.context`），每个会话一开始就出现在上下文快照里：

```
懒工具箱：本机还装了 2 个 skill、1 个 MCP 服务，它们不在工具定义里，
详情见系统提示里的目录（每条一句话用途）。只要当前任务和某条用途对得上，
先调用 `toolbox { action: "load", ids: ["skill:<名字>"] }`（MCP 用 "mcp:<服务>"）
把定义注入本会话，再动手；不要因为工具列表里没有、就跳过它或凭记忆作答。
用完用 `toolbox { action: "unload", ... }` 撤掉。
```

- 每个会话都有，**加载过东西之后**这条文本变成空串，DSH 会把它从上下文快照里过滤掉，不占 token；
- 因为默认 `autoUnloadOnTurnEnd`，每个新的用户回合会重新提醒一次 —— 正是「别的对话不知道有这个插件」的对症药；
- 库里为空（没装任何 skill / MCP）时不输出，不会无中生有。

## `toolbox` 的全部动作

| action | 作用 |
| --- | --- |
| `status` | 插件库概况、本会话已加载项、待还原记录 |
| `list` | 目录（skill / mcp 分列）；`ids` 指定某个 `mcp:<服务>` 时展开它的工具清单 |
| `load` | 把 `ids` 里的项目注入**当前会话**；skill 直接给出正文 |
| `unload` | 撤掉 `ids`（或 `all: true`）注入的定义 |
| `add_skill` | 从本地路径或 http(s) URL 导入 skill（也支持 git 仓库） |
| `add_mcp` | 登记并**先连一次**验证 MCP，成功后记录工具数；失败自动回滚 |
| `remove` | 从插件库删除 skill 文件 / MCP 配置（`ids:["skill:x"]`，也接受单个 `id`） |
| `enable` / `disable` | 打开 / 关闭某个 skill 或 MCP 服务（等价于设置页里的那个开关） |

> 外部工具链（JDK / Ghidra / rea-agents / JADX / IDA）的检测与一键安装已经**拆成独立插件
> [`dsh-toolchain`](../dsh-toolchain/README.md)**：那边有独立的 `toolchain` 工具与
> `设置 → 工具链` 页面。本插件的 `toolbox` 不再提供 `requirements` / `install`。

### 设置 → 懒工具箱：skill 与 MCP 的开关

设置页第一屏就是全部 skill 与全部 MCP（**分两组**），每条一行：名字、一句话用途、
工具数 / 来源，右边一个开关。关掉之后：

- 它不再出现在系统提示的目录里，AI 也就不会再被告知它存在；
- `toolbox action="load"` 会明确拒绝（「在设置页里是关闭状态」），不会偷偷加载；
- **文件与配置都还在**（`store.json` 里记成 `disabled.skills` / `disabled.mcp`），点一下就能回来。

适合「装了很多但这一轮用不到」的场景：不用删，也不会占目录与提示的 token。

```jsonc
// store.json 片段
"disabled": { "skills": ["reverse-engineer-anything-cn"], "mcp": [] }
```

面板与 AI 看到的是同一份事实：`GET /dsh-lazy-toolbox/api` 返回的 `inventory`，
改开关走 `POST {"op":"toggle","id":"skill:<名字>","enabled":false}`。

### 工具链面板已拆走

外部引擎（JDK / Ghidra / rea-agents / JADX / IDA）的检测、一键安装与 env 同步都在独立插件
**`dsh-toolchain`** 里：它有独立设置页 `设置 → 工具链`（order 55，排在懒工具箱之前）和常驻工具
`toolchain`。本插件不再注册工具链面板，也不再调用 `applyEnv()`。

拆分时状态文件 `$DSH_HOME/lazy-toolbox/requirements.json` **原样保留**：`dsh-toolchain` 首次加载时
会读它并写进自己的 `$DSH_HOME/toolchain/requirements.json`，所以拆完面板上立刻是「已安装」，
不需要重装几百 MB 的引擎。MCP 服务注册表 `store.json` 仍由本插件维护，`dsh-toolchain`
只往里写 REA 条目的 `env`。


写操作失败时返回一段可读结果（`# add_skill 失败 …`），不会把异常直接抛给模型。

`add_skill` / `add_mcp` 都会要求一句话 `summary` —— 这就是目录里那一行用途。

## 生命周期

| 时机 | 行为 |
| --- | --- |
| 插件启动 | 迁移 profile 里的 `mcp-client` 条目、`$DSH_HOME/skills`、`~/.agents/skills`（可选项目目录） |
| 每个 pre-step | 节流扫描：AI 之后下载进标准目录的 skill、新加的 `mcp-client` 行，自动搬进来并补一句话用途 |
| 回合结束 | 默认自动卸载本会话注入的定义（`autoUnloadOnTurnEnd`），把请求体积还回去 |
| agent 销毁 | 撤销该 agent 的全部注入，关闭空闲 MCP 连接 |
| 插件卸载 | `preuninstall` 先还原全部 skill 与 MCP 行，再摘 profile 接线 |

**还原语义**：MCP 行保存的是**原文整块 + 原始行号**，还原时按行号写回；skill 目录整体移回原位。
文件被外部改过时会先写 `<file>.lazy-toolbox-backup` 再动。冲突（同名已存在）一律跳过并报告，**从不覆盖**。

## 配置

```yaml
config:
  dataDir: ""                  # 插件库位置，默认 $DSH_HOME/lazy-toolbox
  autoMigrate: true            # 启动时迁移
  autoImport: true             # 运行期自动导入新 skill / 新 mcp 行
  autoImportProjectSkills: false  # 是否也接管项目里的 .dsh/skills
  scanIntervalMs: 5000         # 自动导入的节流间隔
  autoUnloadOnTurnEnd: true    # 回合结束自动卸载
  mcpIdleMs: 60000             # MCP 连接空闲多久关掉
  maxCatalogItems: 200         # 目录最多列多少条
  logEnabled: true             # 本地运行日志（只写文件，设置页不显示）
  logDir: ""                   # 日志目录，默认 $DSH_HOME/lazy-toolbox/logs
  logLevel: info               # debug | info | warn | error
  logMaxBytes: 2097152         # 单个日志文件上限，超了就分卷
  logRetentionDays: 14         # 保留天数，0 = 不清理
```

## 运行日志（本地）

插件把自己的功能调用和错误写成 JSONL，**只落本地文件**，设置页里看不到任何东西：

```
$DSH_HOME/lazy-toolbox/logs/plugin-YYYYMMDD.log        # 超 2 MB 分卷成 .1 .2 …
```

一行一条，字段固定 `ts / level / event / pid`，其余按事件附带：

| event | 记录内容 |
| --- | --- |
| `plugin.start` / `plugin.stop` | 版本、数据目录、生效配置、运行时长 |
| `toolbox.call` | 每次 `toolbox` 调用：`action`、`ids`、`ok`、`ms`，失败带 `error.stack` |
| `toolbox.failed` | `guard()` 兜住的写操作失败（add/remove/enable/disable） |
| `inject.load` / `inject.unload` | 逐条注入/移除结果（成功与否、注入了几个工具定义） |
| `mcp.connect` / `mcp.close` | 连的哪个 MCP、传输方式、命令；连不上带堆栈 |
| `api.request` | 设置页的 HTTP 调用：方法、op、id、状态码、耗时 |
| `scan.failed` / `migrate.*` | 自动导入与迁移的结果/失败 |

写日志失败会被静默吞掉（日志不能拖垮插件），超长字符串截断到 2000 字符，按天分文件、超限分卷、按 `logRetentionDays` 自动清理。看日志：

```bash
dsh-lazy-toolbox logs                 # 最近 100 条，人类可读
dsh-lazy-toolbox logs --lines 20 --raw   # 原样 JSONL，方便 grep / jq
dsh-lazy-toolbox logs --path           # 只打印今天的文件路径
```

## CLI

```bash
dsh-lazy-toolbox status            # 插件库概况
dsh-lazy-toolbox list              # 目录
dsh-lazy-toolbox migrate [--dry-run] [--project]
dsh-lazy-toolbox restore [--skills-only|--mcp-only]
dsh-lazy-toolbox add-skill <path> [--name n] [--summary "一句话"]
dsh-lazy-toolbox add-mcp <name> --command "npx" --args "-y some-mcp" [--verify]
dsh-lazy-toolbox remove skill:<name>|mcp:<server>
dsh-lazy-toolbox enable skill:<name>|mcp:<server>     # 打开（等同设置页的开关）
dsh-lazy-toolbox disable skill:<name>|mcp:<server>    # 关闭：不进目录、不能 load，文件还在
dsh-lazy-toolbox wire-profile [--profile <dir>]
dsh-lazy-toolbox unwire-profile [--profile <dir>]
dsh-lazy-toolbox logs [--lines N] [--raw] [--path]   # 本地运行日志
dsh-lazy-toolbox doctor            # 自检：数据目录、存储、链接状态
```

`--data-dir` 可指向别的插件库（测试用）。

## 为什么能做到「只影响当前会话」

DSH 的工具注册表按 agent 作用域分层（`@deepseek-ai/dsh-scope`）。`agent.ctx.tools.register(def)`
注册的定义只对该 agent 可见，返回值是精确的撤销函数；agent 销毁时作用域整体回收。
本插件不碰全局注册表，只往当前 agent 的作用域里加/减，所以：

- 会话 A 加载的 MCP 工具，会话 B 看不到；
- 卸载只影响发起卸载的会话；
- 进程重启后一切回到「只有目录」。

## 设计取舍

- **零运行时依赖**：MCP 客户端（stdio + streamable-http）、YAML 子集解析、schema 收敛都在仓库内实现。
  不 import 任何 `@deepseek-ai/*`，避免 profile 的 `.pnpm` 提升与 asar 解析问题；与 DSH 的全部交互都走 `ctx` 服务。
- **schema 有损降级**：DSH 只接受 `type/oneOf/properties/required/additionalProperties/items/enum/const`
  加注解，MCP 常见的 `$ref`、`anyOf`、`format` 会被拒绝。这里统一收敛，宁可丢约束也不让整个服务加载失败。
- **卸载是卸载**：不删用户文件，只搬走再搬回。

## 兼容性

- DSH Desktop 0.2.1-rc.x（`inject: [systemPrompt, tools]`，`tools.register` 需要 `output.schema + render`）
- Node.js >= 20

## 开发

```bash
node --test --test-force-exit "test/*.test.mjs"   # 21 个测试
node bin/cli.mjs doctor
```

测试里有一个真实的 stdio MCP 样本（`test/fixtures/fake-mcp-server.mjs`），MCP 客户端、注入、卸载、
回合结束清理、schema 收敛都是真跑的，不打桩。

## 目录结构

```
lib/
  index.js       插件入口：注册 toolbox、目录 section、迁移与钩子
  tools.js       常驻工具 toolbox 的动作实现
  inject.js      按会话注入/卸载
  mcp.js         MCP 连接池、工具名规范化、定义包装
  mcp-client.js  stdio / streamable-http 传输
  skills.js      skill 发现、搬入、加载、还原
  migrate.js     迁移与还原（MCP 行 + skill 目录）
  profile.js     profile / cordis.patch.yml 的文本级读写
  schema.js      上游 JSON Schema → DSH 子集
  store.js       插件库（store.json + skills/）
  log.js         本地运行日志（JSONL，按天分卷 + 保留期清理）
  util.js        文件、路径、frontmatter 工具
bin/cli.mjs      命令行
scripts/         postinstall / preuninstall 钩子
```

## License

MIT，见 [LICENSE](LICENSE)。
