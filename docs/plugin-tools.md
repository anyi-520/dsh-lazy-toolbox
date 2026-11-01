# 插件工具（把别的插件的工具也变懒）

懒工具箱现在管三类东西：

| 分类 | id 写法 | 来源 |
| --- | --- | --- |
| **插件工具** | `group:<组名>` / `group:<组名>:<工具>` | 别的 DSH 插件把自己的工具交出来托管 |
| skill | `skill:<名字>` | skill 目录 / 插件内置 |
| MCP | `mcp:<服务>` / `mcp:<服务>:<工具>` | mcp.json |

三者在设置页、系统提示目录、`toolbox` 里都是一等公民，唯一的区别是**插件工具不落盘**——
它是活对象，只有那个插件在跑的时候才存在。

## 为什么需要这一类

有的插件一次注册十几二十个工具（比如内存工作台 17 个 `mem_*`），不管这一轮聊的是什么，
这些 schema 都躺在工具定义里占地方。这类插件自己改成调用懒工具箱的托管接口以后：

- 启动时**一个工具都不注册**（工具定义只存在内存里）；
- 系统提示里只多一行：`group:memstudio — 内存工作台：…〔插件 dsh-memstudio〕，17 个工具：mem_targets, mem_apps, …`；
- 真要用：`toolbox { action: "load", ids: ["group:memstudio"] }`（或只挑一个：`group:memstudio:mem_read`）；
- 用完：`toolbox { action: "unload", ids: ["group:memstudio"] }`，下次请求里就没有它们了。

## 插件侧怎么接（两行）

懒工具箱和插件可能装在不同目录，bare import 解析不到，所以用全局符号桥：

```js
// 插件 apply() 里
const definitions = tools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
  execute: (args) => tool.execute(args ?? {}),
}))

const bridge = globalThis[Symbol.for("dsh-lazy-toolbox.bridge")]
if (bridge) {
  bridge.provideToolGroup({
    id: "memstudio",
    summary: "内存工作台：附加进程 / 读写搜索 / 断点 / 指针链 / 冻结（一句话用途，会进目录）",
    plugin: "dsh-memstudio",
    tools: definitions,
  })
} else {
  for (const definition of definitions) ctx.tools.register(definition)  // 没装懒工具箱就照旧常驻
}
```

`Symbol.for` 走全局符号表，同一个进程里不同模块副本拿到的是同一把钥匙，不用管安装路径。

**启动顺序**：懒工具箱可能比你晚加载。稳妥写法是轮询等一会儿（内存工作台就是这么做的：

```js
let waited = 0
const tryProvide = () => {
  const bridge = globalThis[Symbol.for("dsh-lazy-toolbox.bridge")]
  if (bridge) return bridge.provideToolGroup({ /* … */ })
  waited += 100
  if (waited >= 2000) return definitions.forEach((d) => ctx.tools.register(d))
  const timer = setTimeout(tryProvide, 100)
  timer.unref?.()
}
tryProvide()
```

等不到桥（没装懒工具箱 / 版本太老）就回落到自己注册，行为与以前完全一致，不会把工具弄丢。

也可以直接 import（装在同一 node_modules 下时）：

```js
import { provideToolGroup } from "dsh-lazy-toolbox/tool-groups"
```

## 托管接口

```js
provideToolGroup({ id, summary, plugin, tools })  // → 撤销函数
removeToolGroup(id)
listToolGroups()          // [{ id, summary, plugin, toolCount, toolNames }]
getToolGroup(id)
pickGroupTools(id, names) // names 省略 = 全给
onToolGroupsChange(fn)    // 返回取消订阅
```

细节：

- `tools[].execute(args)` 返回 `{ text }`；没写 `output` 时自动补 `{ schema: {text}, render }`；
- 同名 `id` 再提供一次会覆盖（插件重启重新注册的场景）；
- 一个组的工具数为 0 会直接报错，避免目录里出现空组；
- 托管的定义只活在内存里，`store.json` 里只记「跳过」这类开关状态。

## 设置页

「插件工具」单独成组，显示托管了几十个工具、来自哪个插件，右边同样是**懒加载 / 跳过**：

- 懒加载（默认）：进目录，`load` 才注册进来；
- 跳过：不进目录，`load` 拒绝（工具定义还在插件那边，插件本身照常工作）。

## 命令行

```bash
node bin/cli.mjs list             # 三类都列出来（group: 那行带工具数）
node bin/cli.mjs mode group:memstudio skip
```

注意：`list` 里的 `group:` 行来自当前进程的注册表，所以只有在 DSH 跑着的时候才看得见——
单独跑 CLI 时进程里没有插件，那一栏自然是空的。

## 与「不做懒加载」名单的关系

破甲类插件（`dsh-purge` 之类）仍然不进任何目录，也不接受托管——那类插件本来就要自己往系统提示里
塞东西，交给懒工具箱只会变成双重注入。

## 当前已接入

| 组 | 插件 | 工具数 | 说明 |
| --- | --- | --- | --- |
| `group:memstudio` | `dsh-memstudio` | 17 | 内存工作台：附加进程 / 读写搜索 / 断点 / 指针链 / 冻结 / A-D 槽 |
