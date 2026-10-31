# 架构

## 它挂在 DSH 的哪些扩展点上

| 扩展点 | 用途 |
| --- | --- |
| `ctx.tools.register(def)` | 注册常驻的 `toolbox` 工具（全局层） |
| `agent.ctx.tools.register(def)` | 把 MCP 工具定义注入**单个 agent 的作用域**，返回精确 disposer |
| `ctx.systemPrompt.section({name, order, text, interpolate})` | 目录块；`text` 是函数，按当前 agent 动态渲染 |
| `ctx.systemPrompt.getSectionOrder("MCP_SERVERS")` | 目录排在 MCP 段之后（3100 + 1） |
| `ctx.on("agent/pre-step", (payload, next))` | 节流扫描新 skill / 新 mcp 行；必须 `return next()` |
| `ctx.on("session/event", (session, event))` | `event.type === "turn/end"` 时卸载本会话注入 |
| `ctx.on("agent/disposed", ({agent}))` | 撤销该 agent 的全部注入 |
| `ctx.effect(fn, label)` | 插件卸载时关掉所有 MCP 连接 |
| `ctx.get("workingDirectory")` | `add_skill` 解析相对路径 |

插件声明 `export const inject = ["systemPrompt", "tools"]`，与 profile 里 insert 行的 `inject` 保持一致。

## 作用域为什么天然隔离

DSH 的 `ToolRuntime` 内部是 `ScopedLayers`（`@deepseek-ai/dsh-scope`）：每个 agent 有一个 scope key，
`tools.register()` 通过 `this.layers.effect(this.ctx, …)` 写进**调用者所在层**，`view(scope)` 在读取时
按链合并（global → 祖先 → 自己）。因此：

- 通过 `agent.ctx` 注册 = 只进这个 agent 自己的层；
- 通过插件根 `ctx` 注册 = 全局层，所有 agent 可见；
- disposer 精确弹出该条定义；scope 销毁时整层回收。

我们在真实运行时验证过：同一进程里注册到 scope A 的定义，用 `tools.get(name, scopeA)` 可见，
用 `tools.get(name)`（全局视图）不可见。

## 注入流程

```
tool load ["mcp:github"]
  └─ Injector.load(agent, ids)
       ├─ parseItemId → {kind:"mcp-server", name:"github"}
       ├─ McpManager.listTools("github")      # 复用连接，必要时握手
       ├─ for tool of tools:
       │    definition = buildMcpToolDefinition(...)
       │    disposers.push(agent.ctx.tools.register(definition))
       └─ state.items.set("mcp:github", {names, disposers})
```

`unload` 反向执行 disposer 并 `release` 连接（`mcpIdleMs` 后真正关闭子进程 / HTTP 会话）。

skill 的注入不同：它没有工具定义可加，`load` 直接把 `SKILL.md` 正文包成 `<skill_content>` 返回，
因此模型在同一步就能读到；`unload` 只清掉「已加载」标记（正文已进入历史，无法撤回，也不会重复注入）。

## 迁移是怎么做到可逆的

profile 的 `cordis.patch.yml` 用**文本级**处理，不引 YAML 依赖：

1. `splitTopLevelEntries` 按「顶格 `- `」切块，得到每条的起止行；
2. `findMcpEntries` 找出 `name: '@deepseek-ai/dsh-mcp-client'` 的块，用子集解析器读 `config`
   （`transport / serverName / command / args / env / cwd / url / headers / toolCallTimeoutMs`）；
3. 写入插件库 `store.json`；
4. `removeEntries` 从原文里删掉这些块，同时把 **原始文本 + 起始行号** 存进 `store.restore.profiles`。

还原时 `insertEntries` 按行号从后往前插回，因此不受其它条目增删影响；文件被外部改过会先备份成
`cordis.patch.yml.lazy-toolbox-backup`。

skill 是**目录整体移动**（`fs.renameSync`，跨盘退化为复制 + 删除），源路径记在 `store.restore.skills`；
还原时检查目标是否被占用，占用就跳过并报告。同名冲突从不覆盖。

## 目录与句子的来源

- skill：`SKILL.md` frontmatter 的 `description`，取第一句（`oneLine`，96 字）。
- MCP：`config.serverSummary` / `config.description`，都没有就用「服务名 MCP 服务（N 个工具）」。
- 运行期新加的：`add_skill` / `add_mcp` 强制要求 `summary` 参数。

## schema 收敛规则

DSH 的 `assertSupportedJsonSchema` 只接受这些关键字：

```
type | oneOf | properties | required | additionalProperties | items | enum | const
+ 注解 description | title | default | examples
```

并且：`type` 与 `oneOf` 不能并存；`oneOf` 不能与 `properties/required/additionalProperties/items/enum/const`
并列；`additionalProperties` 只能是布尔；`required` 的字段必须在 `properties` 里；`type` 不能是数组。

`lib/schema.js` 据此降级：类型数组取第一个非 `null`；`anyOf/allOf/$ref/format/minimum/...` 丢弃；
`additionalProperties` 为 schema 时改成 `true`；`enum` 过滤掉与类型不符的值；无类型时按结构推断
（有 `properties` → object，有 `items` → array，有 `enum` → 按首值）。

## 零依赖的边界

不 import 任何 `@deepseek-ai/*`：profile 装的是 `.pnpm` 提升后的副本，asar 里的包路径不可预测，
一个 peer 解析失败就会让整个插件 pending。所有 DSH 交互都通过 `ctx` 服务；MCP、YAML、schema 自己实现。
