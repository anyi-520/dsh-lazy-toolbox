# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.5.2] - 2026-10-31

**插件自带的 skill / MCP 会被自动接管。**

### 新增

- `lib/discover.js`：扫 profile 里已安装的插件包（`node_modules` 一层 + `$DSH_HOME/plugins/*`），
  识别内置资产并登记进插件库：
  - `package.json` 的 `dsh.skills` / `dsh.skill` / `dsh.mcp` / `dsh.mcpServers`；
  - 约定目录 `skills/`、`dsh/skills/`、`.dsh/skills/`（目录自身是 skill，或每个子目录一个）；
  - 配置文件 `mcp.json`、`.dsh/mcp.json`、`dsh/mcp.json`、`mcp-servers.json`；
  - `"dsh": { "autoDetect": false }` 可让某个插件退出接管。
- 接管方式为**原地引用**：`storePath` 直接指向插件里的 skill 目录，不复制文件，插件升级即生效；
  `remove` 这类条目时只删登记，不动插件文件。
- 幂等与回收：内容指纹没变就跳过读盘；插件卸载后条目在下一轮扫描里回收；
  在设置里关掉（`disable`）或 `remove` 过的条目不会被自动复活。
- 触发点：`apply` 启动时、`agent/pre-step` 节流扫描；另有 `toolbox { action: "discover" }`、
  CLI `dsh-lazy-toolbox discover [--dry-run]`、导出函数 `discoverNow()`。
- 配置项 `autoDetectPluginAssets`（默认 `true`）。
- 设置页清单与 `toolbox list` / 目录会标出来源：`〔插件 <包名>〕`（前端为「插件 xxx」小标签，
  API 字段新增 `plugin` / `external`）。
- 文档：`docs/plugin-assets.md`（支持的写法、例子、取舍）、`docs/介绍.md` 与
  `docs/INTRO.en.md`（中英介绍文）、`examples/plugin-with-skill/`（可复制的插件骨架）。
- 测试：`test/discover.test.mjs`（8 项）——发现、原地引用、幂等、尊重开关、卸载回收、
  删除不动插件文件、MCP 来源、`package.json` 带 BOM 也能识别。全量 **51 项**通过。

### 修复

- `readJson` / `readText` 现在会剥掉 UTF-8 BOM：被记事本或 PowerShell 存过的
  `package.json` 之前会让 `isProfileDir` 直接返回 false、插件被静默跳过。
- `profile.js` 的三处 `JSON.parse(readFileSync(...))` 改为走 `readJson`，同一原因。

## [0.5.1] - 2026-10-31

**本机运行日志：功能调用与错误全部落本地文件，设置页不显示。**

### 新增

- `lib/log.js`：JSONL 日志器（`PluginLog`）。按天分文件 `logs/plugin-YYYYMMDD.log`，单文件超
  `logMaxBytes`（默认 2 MB）自动分卷成 `.1` `.2`，超过 `logRetentionDays`（默认 14 天）自动清理；
  超长字符串截断到 2000 字符；**写失败静默丢弃**，不会影响插件本身。
- 记录的事件：`plugin.start` / `plugin.stop`、`toolbox.call`（每次调用带 `action`、`ids`、`ok`、`ms`，
  失败带 `error.stack`）、`toolbox.failed`（`guard()` 兜住的写操作失败）、`inject.load` /
  `inject.unload`（逐条结果与注入的定义数）、`mcp.connect` / `mcp.close`（传输方式、命令、错误）、
  `api.request`（设置页 HTTP 调用）、`scan.failed`、`migrate.skills` / `migrate.mcp`。
- 配置项：`logEnabled`（默认 `true`）、`logDir`、`logLevel`（`debug|info|warn|error`）、
  `logMaxBytes`、`logRetentionDays`。设 `logEnabled: false` 走 `nullLog`，完全不写。
- CLI：`dsh-lazy-toolbox logs [--lines N] [--raw] [--path]`。
- 测试：`test/log.test.mjs`（9 项：JSONL 结构、级别过滤、截断、分卷、保留期清理、不可写降级、
  `tail()` 顺序、`apply` 首条 `plugin.start`、`toolbox.call` 成功/失败留痕）。全量 43 项通过。

### 说明

- 日志只写本地，不上报、不进系统提示、不在设置页显示。
- 日志目录默认 `$DSH_HOME/lazy-toolbox/logs`，与 `store.json` 同级，卸载插件时随数据目录一起处理。

## [0.5.0] - 2026-10-31

**工具链面板已拆分为独立插件 `dsh-toolchain`。**

设置页不再把「skill / MCP 开关」和「外部分析引擎」挤在同一页：懒工具箱只做懒加载，
引擎的检测与一键安装搬到 `dsh-toolchain`（独立设置页 `设置 → 工具链`，order 55，排在懒工具箱之前）。

### 移除

- `client.js` 里的 `ToolchainSection`（以及 `Pill`、`STATUS_LABEL`、`GROUP_ORDER` 等只给它用的样式与常量）。
  现在设置页只有「skill 与 MCP 开关」一张卡。
- 设置页端点 `/dsh-lazy-toolbox/api` 里的工具链 op：`install` / `detect` / `setPath` /
  `setToolsRoot` / `applyEnv`，以及响应里的 `snapshot` / `catalog` / `servers` 字段。
  端点保留 `GET`（返回 `{ ok, inventory }`）与 `POST {op:"toggle"}`。
- `toolbox` 工具的 `requirements` / `install` 两个 action，及 `lib/requirements.js`。
- 启动时的 `applyEnv()`（env 同步现在由 `dsh-toolchain` 负责）。
- `test/requirements.test.mjs`（连同状态迁移语义一起搬到新插件）。

### 保留

- skill / MCP 的 `load` / `unload` / `list` / `status` / `add_skill` / `add_mcp` / `remove` /
  `enable` / `disable`，以及 `doctor` 等一切非工具链能力，行为不变。
- 状态文件 `$DSH_HOME/lazy-toolbox/requirements.json` **不删**：`dsh-toolchain` 首次加载时
  会读它并写进自己的 `$DSH_HOME/toolchain/requirements.json`，拆完立刻显示「已安装」，不用重装引擎。
- MCP 服务注册表 `$DSH_HOME/lazy-toolbox/store.json` 继续是本插件的数据源（`dsh-toolchain`
  只往里写 REA 条目的 env）。

### 迁移

1. 装/挂上 `dsh-toolchain`（`cordis.patch.yml` 加 insert 条目）；
2. 重启 DSH：`设置 → 工具链` 出现，`懒工具箱` 里不再有引擎面板；
3. 已装引擎（`<工具链安装目录>`）保持原样，面板上直接显示「已安装」。

## [0.4.1] - 2026-10-31

真机把「一键装 → 真能跑」这条链走通后修的一批问题。全是实测踩出来的，不装一次根本看不到。

### 修复

- **版本钉死**：REA 6.7.0 的 provider 白名单只认 **Ghidra 12.1.x（verified 12.1.4）** 与 **64 位完整 JDK 25+**。
  装官方最新 12.2 会被判 `unsupported_version`，装 JDK 17 同样被拒。工具链目录改为 `jdk`（JDK 25+）
  与 `ghidra`（12.1.4），sha256 换成 `ddac49f9…`；旧 `jdk17` 状态自动迁移。
- **下载**：Ghidra 直连只有 ~40 KB/s。改成**多源 + 分片并行**：先探 `Accept-Ranges`，
  支持就按 3~6 连接切片写同一文件的不同偏移，实测 156 KB/s → **6~11 MB/s**；
  源按「先快后稳」排序（JDK 走 Azure CDN，Ghidra 走可达代理，官方直连兜底），sha256 不过就换源。
- **`bindGhidraJava()`**：把 `JAVA_HOME_OVERRIDE` 写进 Ghidra 的 `support/launch.properties`。
  路径必须用**正斜杠**——properties 里 `\` 是转义符，`D:\re-tools` 会被读成 `D:re-tools`。
- **`computeEnv()` 把 TEMP / TMP / XDG_CONFIG_HOME 钉进工具目录**。Ghidra 的 `LaunchSupport`
  找到 JDK 之后要写 `<config>/java_home.save`，写不进去就当作「找不到 JDK」→ 转交互式询问 → NPE 退出。
  受限令牌 / 受管环境下（例如只能写工作区的沙箱）`%APPDATA%` 与 `%TEMP%` 都不可写，
  现象就是满屏 `JDK 21+ (64-bit) could not be found`，其实 JDK 早就找着了。
- Ghidra 目录名不再要求 `ghidra_` 前缀：以「有没有 `support/analyzeHeadless.bat`」为准。

### 验收

- `rea analyze fixture_pe_vmp.exe` → `provider: ghidra 12.1.4`、`format: pe`、`architecture: x86_64`、
  带 `evidence_id`，exit 0（此前是 `provider_unavailable`）。
- 41 个测试全绿；新增 `computeEnv` 与 `bindGhidraJava` 两个回归测试（含「不许出现反斜杠」断言）。

## [0.4.0] - 2026-10-31

### 新增

- **设置页：skill 与 MCP 开关面板**（设置 → 「懒工具箱」第一节）。skill / MCP 分开列，
  每条带名字、一句话用途、工具数/来源和一个开关。
- 开关语义：**关掉 ≠ 卸载**。关掉后该条不进系统提示的目录、`toolbox action=load` 也会拒绝，
  但文件与配置都还在（`store.json` 的 `disabled.skills` / `disabled.mcp`），随时能再打开。
- 新 `toolbox` action：`enable` / `disable`（`ids:["skill:<名字>"]` / `["mcp:<服务>"]`），
  AI 与设置页走同一份实现。
- 设置页端点扩展：`GET /dsh-lazy-toolbox/api` 多返回 `inventory`（清单 + 开关状态），
  `POST {op:"toggle", id, enabled}` 改开关；`op:install / detect / setPath / setToolsRoot / applyEnv` 照旧。
- 设置页标题从「工具链」改成「懒工具箱」（id 同步为 `lazy-toolbox`），工具链面板原样保留在第二节。
- 5 个新测试：`test/toggle.test.mjs`（store 持久化、目录/提示/load 联动、HTTP 端点、清单函数）、
  `test/client.test.mjs`（bundle 格式、`settings.section` 登记、渲染出 3 个开关、点开关发 POST）。
- 真实运行时验收 `webui-test.mjs`：真 cordis + 真 `dsh-host-webserver` + 真 HTTP 请求跑通
  「GET 清单 → 关掉 → 目录立刻消失 → 落盘 → 再打开 → 目录恢复 → 未知 id 报错」。

### 修复

- 目录 / 提示只统计**启用中**的条目，不会因为「关掉了但还在」而多算。
- 提示 `toolbox:hint` 与目录 `toolbox:catalog` 都会跳过关闭项；全关时目录给出明确说明。

## [0.3.0] - 2026-10-31

### 新增

- **工具链面板（设置页）**：`lib/requirements.js` + `client.js`，在「设置 → 工具链」里列出
  REA 依赖的外部引擎（Node / npm / rea-agents / JDK 17 / Ghidra / JADX / IDA / Hopper），
  显示**装没装、版本、路径、env 名**，并支持一键安装、重装、手工指定路径、改安装目录。
- **`toolbox` 新 action**：`requirements`（读状态）与 `install`（`ids:["ghidra","jdk17"]`），
  AI 和设置页走同一份事实、同一套安装实现。
- **装完自动接线**：`applyEnv()` 把 `JAVA_HOME` / `GHIDRA_INSTALL_DIR` / `REA_JADX_MCP_JAR` / `PATH`
  写进 REA 那个 MCP 服务的 `env`，下次调用即生效（插件启动时也会同步一次）。
- 安装实现：JDK 17（Adoptium GA）、Ghidra 12.2（官方 release，**带 sha256 校验**）、rea-agents（npm 增量装），
  下载/解压/校验全过程写进度与日志，可从设置页或 `toolbox requirements` 轮询。
- 5 个新测试（`test/requirements.test.mjs`）。

### 说明

- 引擎安装目录默认 `<数据目录>/tools`，可在设置里改成任意磁盘（例如 `<工具链安装目录>`）。
- 手工装过的引擎只要目录结构符合官方布局（`bin/java.exe`、`support/analyzeHeadless.bat`）也能被识别。

## [0.2.0] - 2026-10-31

### 新增

- 运行时上下文提醒 `toolbox:hint`（`systemPrompt.context`）：每个新会话开头就告诉模型
  「装了懒工具箱、能力不在工具定义里、先 `load` 再动手」，加载后自动变空、不占 token。
- `doctor` 报告未登记的残留 skill 目录；`remove` 可直接清掉这种孤儿目录。
### 修复

- `list` 不带 `ids` 时不再重复输出整段 `status`，改为纯目录。
- 写操作（`add_skill` / `add_mcp` / `remove`）失败时返回可读结果，不再抛异常给模型。
- `remove` 兼容单个 `id`（`ids:["skill:x"]` 与 `id:"skill:x"` 都行）。
- 一句话用途截断按词边界收尾，不再切出半个英文单词；入库保留原始第一句，显示时才按宽度截。
- 从 URL / 临时目录导入的 skill 不再记录临时 `origin`，避免卸载时往已删除的目录搬。
- `Injector` 统一解析 agent / scope，认不出来时按「未加载」处理，不误判。
- `Store` 读之前比对 `store.json` 的修改时间：多会话 / CLI 同时改动时自动重读，不再看到过期数据。

## [0.1.0] - 2026-10-31

首个版本。

### 新增

- 常驻工具 `toolbox`：`status / list / load / unload / add_skill / add_mcp / remove`。
- 系统提示目录 `toolbox:catalog`：skill 与 MCP 分列，一条一句话用途，不含参数 schema。
- 按会话热加载：通过 `agent.ctx.tools.register()` 把定义注入当前会话，只影响这一个对话。
- 回合结束自动卸载（`autoUnloadOnTurnEnd`，默认开启），agent 销毁时整体回收。
- MCP 客户端：stdio（含 Windows `.cmd/.bat` 兼容）与 streamable-http（含 SSE 增量帧）。
- JSON Schema 收敛：把上游任意 schema 降级成 DSH 强制支持的子集。
- 安装迁移：profile 的 `mcp-client` 条目（原文 + 行号）、`$DSH_HOME/skills`、`~/.agents/skills`。
- 运行期自动导入：AI 下载进标准目录的 skill、新加的 `mcp-client` 行会在 pre-step 被搬进来。
- 卸载还原：`preuninstall` 按原文写回 MCP 行、把 skill 目录移回原位，再摘掉 profile 接线。
- 命令行：`status / list / migrate / restore / add-skill / add-mcp / remove / wire-profile / unwire-profile / doctor`。
- 21 个测试，含真实 stdio MCP 样本的端到端往返。
