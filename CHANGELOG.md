# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.7.1] - 2026-11-01

**能用图形界面「添加插件」装了（补 dsh.bundle）；新版本弹窗（本次/今天不提醒）、三标签设置页、内置代码编辑器；顺手把包格式对齐官方包。**

### 修复

- **`插件 → 添加插件` 装不上**：DSH 的安装器先读 `manifest.dsh.bundle.patch`，读不到就直接拒绝
  （`这个包没有声明组合包，无法作为插件安装：dsh-lazy-toolbox declares no dsh.bundle`）。
  现在包里有 [`cordis.patch.yml`](cordis.patch.yml)，`package.json` 声明
  `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，`files` 与 `exports` 都带上它。
  补丁里插的那一行与 `wire-profile` 写进 profile 的完全一致，两种装法不叠加。
- `wire-profile` 写的 insert 行 `inject` 补上 `webServer`，与插件导出的 `inject` 对齐。

### 新增

- **进 DSH 自动查更新 + 弹窗**：启动后约 4 秒异步查一次 GitHub Releases（`updateCheck`，间隔
  `updateCheckHours`），有新版本就在设置页弹窗：
  **本次不提醒**（`update-state.json` 记 process token，重启即失效）/ **今天不提醒**（记到当天
  23:59，跨重启当天也不再弹）/ **更新**（跳到「关于」并开始下载）。静默状态写进 `update-state.json`
  的 `snooze`，`check` 不会把它冲掉；接口新增 `POST op=update.snooze { scope }`，
  `GET` 的 `update.prompt.show` 就是「该不该弹」。
- **设置页改成三标签**：`懒加载` / `工具` / `关于`。
  - 懒加载：三类开关（插件工具 / skill / MCP）与加载方式；
  - 工具：扫描插件内置资产、撤掉本会话注入、**代码编辑器**；
  - 关于：版本、仓库、当前托管数量、云更新卡片。
- **内置代码编辑器** `lib/editor.js`：`read` / `validate` / `write` / `patch` / `revert` 五步，
  写前先校验、不通过不落盘，覆盖前自动备份到 `<数据目录>/editor-backups/`。
  校验：JS 走 `node --check` 真解析器（ESM/CJS 都认）、JSON 走 `JSON.parse` 并把 position 换成
  **行列**、YAML 浅校验（Tab 缩进 / 缩进倍数 / 引号 / 括号）。给 AI 的入口是
  `toolbox { action: "code", step: ... }`；CLI 是 `code <read|validate|write|revert> <路径>`；
  HTTP 是 `code.read` / `code.validate` / `code.write` / `code.revert`。
- `toolbox` schema：`step` 扩到 8 个值，新增 `content` / `find` / `replace` / `force`。
- `dataDir` 进入 `GET` 的 inventory，「关于」页能直接看到数据目录。

### 调整

- **包格式对齐官方包**（对比见 [docs/plugin-format.md](docs/plugin-format.md)）：
  `exports` 由字符串改成条件对象（`{ "default": "./lib/index.js" }` 形态），新增 `icon.svg` +
  `"icon"` 字段并进 `files`。刻意不写的三处（`peerDependencies` / `types` / `dsh.bundle.patch`）
  在文档里逐条写了原因。
- 设置页头部右侧显示当前版本号。

### 文档

- 新增 [docs/editor.md](docs/editor.md)、[docs/plugin-format.md](docs/plugin-format.md)；
  [docs/update.md](docs/update.md) 补弹窗与静默。

### 测试

- 新增 `test/editor.test.mjs`（12 项：类型识别 / 行列换算 / JS 真假解析 / JSON 行列 / YAML 浅校验 /
  不落盘 / force / 备份回滚 / 拒读 / patch 唯一性 / 结果格式化）。
- 云更新补 4 项（本次不提醒跨重启、今天不提醒跨重启、无新版本不弹、静默不被 check 冲掉）。
- 设置页补 9 项（三标签、关于页、工具页、编辑器保存/校验的请求体、弹窗三个按钮）。
- 全量 **116 项** 通过。

## [0.7.0] - 2026-11-01

**新增第三类「插件工具」：别的插件可以把工具交出来托管，默认一个都不常驻。**

### 新增

- `lib/tool-groups.js`：`provideToolGroup({ id, summary, plugin, tools })` 托管接口 +
  `listToolGroups` / `getToolGroup` / `pickGroupTools` / `removeToolGroup` / `onToolGroupsChange`；
  自动补 `output`（`{text}` + render），同名组重提供即覆盖，空组直接报错。
- **全局符号桥** `globalThis[Symbol.for("dsh-lazy-toolbox.bridge")]`：插件与懒工具箱装在不同目录、
  bare import 解析不到时也能接上；`Symbol.for` 走全局符号表，同进程不同模块副本共用一把钥匙。
  桥不在时插件照旧自己注册，不会把工具弄丢。包也导出了 `dsh-lazy-toolbox/tool-groups` 子路径。
- 目录（系统提示）第三类：`### 插件工具（别的插件交出来托管的）`，每行
  `group:<组> — 一句话用途〔插件 x〕，N 个工具：a, b, c…`，不给 schema；`[已加载]` 标记照旧。
- `toolbox`：`load` / `list` / `mode` 支持 `group:<组>` 与 `group:<组>:<工具>`；`list` 无 ids 时按
  插件工具 / skills / mcp 三栏列出，带 ids 可展开某组的工具名与一句话说明。
- 设置页第三栏「插件工具」：显示托管工具数、来源插件，右边同样是 **懒加载 / 跳过**；
  跳过 = 不进目录、`load` 拒绝（插件本身照常工作）。`store.disabled` 增加 `groups`。
- CLI：`list` 带 `group:` 行（工具数 + 开关状态）。
- 文档 [docs/plugin-tools.md](docs/plugin-tools.md)；README 中英同步。
- 已接入：`dsh-memstudio` 的 17 个 `mem_*` 工具改为托管（`group:memstudio`）——
  `D:\逆向\plugins\dsh-memstudio\index.js` 里原本常驻注册的循环改成走桥，桥不在则回落。
- 测试：新增 `test/tool-groups.test.mjs`（11 项：托管/挑工具/桥/通知/解析/注入/卸载/跳过/清单）
  与 2 项设置页用例，全量 **91 项** 通过。

## [0.6.0] - 2026-11-01

**云更新：自动查仓库新版本 → 显示更新内容 → 下载 → 覆盖安装 → 提示重启。**

### 新增

- `lib/update.js`：查 `GET /repos/<updateRepo>/releases/latest`，比较版本（支持 `0.10 > 0.9`、
  `1.0.0 > 1.0.0-rc.1`），只取本项目命名的 zip 附件，下载后校验大小。
- 设置页新增第一张卡片「云更新」：当前版本 / 最新版本 / 检查时间、可滚动的更新内容、
  三个按钮（检查更新 / 下载 vX / 安装 vX），装完变红字提示「请关掉 DSH 再打开」。
- 安装流程：先把现版本文件备份到 `<数据目录>/updates/backup-<版本>-<时间戳>/`，再覆盖插件本体
  （`package.json`、`client.js`、`lib/`、`bin/`、`docs/`、`examples/`、`test/`、`scripts/`、
  README、CHANGELOG、LICENSE、NOTICE）；`node_modules`、`.git`、数据目录不碰。
- 解压：Windows 走 PowerShell `Expand-Archive`，其他平台走 `unzip`；失败只保留 zip 并提示手动解压。
- 检查结果落盘 `<数据目录>/update-state.json`（10 分钟内复用），启动时先显示缓存，
  延迟 4 秒后台再查一次，不阻塞启动。
- 三个入口：设置页按钮、CLI `update check|download|install`、`toolbox { action: "update", step }`。
- 配置：`updateRepo` / `updateCheck` / `updateCheckHours`；私有仓库或限流可用 `GH_TOKEN` / `GITHUB_TOKEN`。
- API：`GET /dsh-lazy-toolbox/api` 返回 `version` 与 `update`；新增 `update.check` /
  `update.download` / `update.install` 三个 op。
- 文档 [docs/update.md](docs/update.md)，README 中英同步。
- 测试：新增 `test/update.test.mjs`（7 项，含真实 zip 的解压→备份→覆盖链路）与 3 项设置页用例，
  全量 **78 项** 通过。

## [0.5.3] - 2026-10-31

**skill 只注入大纲（正文按需取）、每条目可选「懒加载 / 跳过」、破甲类插件进「不做懒加载」名单。**

### 新增

- `lib/outline.js`：把 SKILL.md 解析成大纲——按 ATX 标题分节、算出层级编号（`1` / `1.1`）、
  每节取第一段第一句作为一句话概括（跳过代码块/表格）、支持按 id 或标题片段取某一节，
  `section: "all"` 取整篇。代码块里的 `#` 不算标题，标题自带序号显示时去掉。
- `load skill` 默认改为**大纲模式**：注入「一句话 + 每节一行 + 取节指路 + 资源目录」，
  3 万 token 的 skill 变成几百 token；`inject.js` 记录 `mode: "index"`。
- 新增 `toolbox { action: "skill", id, section }`：按需拉取某一节原文（或整篇），
  **不新增任何工具定义**（走常驻的 `toolbox`）；单次回传上限 `skillSectionMaxChars`（默认 6 万字符）。
- 新增 `toolbox { action: "mode", ids, mode: "lazy"|"skip" }` 与设置页两段式选择器
  （懒加载 / 跳过），CLI `mode <id> lazy|skip`；与 `enable` / `disable` 同源（`disabled` 列表）。
- `lib/denylist.js`：「不做懒加载」名单。命中名单的插件，其内置 skill / MCP **不接管、不登记、
  不进目录**（这类插件自己 hook 注入系统提示词，接管会双重注入）；之前版本已接管过的条目
  在下一轮扫描里撤掉登记（不删插件文件）。
  - 内置包名：`dsh-purge`、`dsh-jailbreak`、`dsh-break-armor`、`dsh-unfiltered`、`dsh-uncensored`、
    `dsh-prompt-inject` 等；内置正则：`jailbreak`、`破甲`、`越狱`、`uncensor`、`nsfw`、
    `prompt-inject`、`armor-break`、`dan`、`safety-bypass` 等。
  - 配置 `neverLazyBuiltin` / `neverLazyExtra`；日志事件 `discover.blocked`。
- CLI 增加 `skill <名字> [--section <id>|all]`、`mode <id> <lazy|skip>`。
- 文档：[docs/skill-index.md](docs/skill-index.md)（大纲模式）、[docs/never-lazy.md](docs/never-lazy.md)
  （名单与加载方式），README 中英同步。
- 测试：新增 `test/outline.test.mjs`（11 项）、`test/neverlazy.test.mjs`（5 项），
  client 测试改为校验选择器与 `op=mode`。全量 **68 项** 通过。

### 变更

- 设置页的开关改为「懒加载 / 跳过」两段式选择器（语义不变，`aria-checked` 语义保留在 radio 上）。
- `load skill` 的返回文案改为「已注入 skill 大纲（N 个分支，正文 X 字符没有整篇塞进来）」。

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
