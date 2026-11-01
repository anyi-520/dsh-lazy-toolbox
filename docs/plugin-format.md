# 与官方插件的格式对比

对比对象：DeepSeek Harness 桌面版 `0.2.1-rc.5`，安装包 `D:\dsh\resources\app.asar` 里的
`dsh/node_modules/@deepseek-ai/dsh-*`。一共 **307 个官方包**，逐个解出 `package.json`
（脚本在 `_work/official-scan.mjs`，明细 `_work/official-plugins.json`）统计出来的事实。

## 一、官方包的字段使用率（307 个包）

| 项 | 数量 | 说明 |
| --- | --- | --- |
| `"type": "module"` | 307 / 307 | 全 ESM，没有 CJS 包 |
| `files` | 307 / 307 | 全都会声明发布清单（平均 3.9 条） |
| `types` / `exports["."].types` | 302 / 307 | 只有极少数纯 JS 包不写类型 |
| `peerDependencies` | 299 / 307 | 最常见的是 `@deepseek-ai/cordis: ~4.0.5` |
| `dsh.client` | 79 | 带浏览器半（设置页 / 面板 / HMR 这类） |
| `dsh.bundle.patch` | 18 | 「开箱即用」的 bundle，靠 `cordis.patch.yml` 自动挂进 profile |
| 顶层 `cordis` 字段 | 0 | 不写在 package.json 里，走 `cordis.patch.yml` |
| `engines.node` | 3 | 写的一般是 `>=22.19.0` |
| `icon` | 少数（bundle 类有） | 例如 plugin-market bundle 的 `"./icon.svg"` |

`exports` 的形状统一是**条件对象**，不是字符串：

```json
"exports": {
  ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
  "./package.json": "./package.json"
}
```

`dsh.client` 也是对象（我们只用到了其中一部分）：

```json
"dsh": {
  "client": {
    "inject": ["@deepseek-ai/dsh-api-gateway"],
    "external": ["@deepseek-ai/dsh-api-gateway/client"],
    "platform": "web"
  }
}
```

## 二、入口代码的形状差异

官方包的入口导出是**类**（`dsh-api-terminal-controller/lib/index.js` 尾行）：

```js
export { TerminalController, TerminalController as default };
```

配 `Config = Schema.object({...})`（`@deepseek-ai/schemastery`）声明配置，靠 cordis 的
服务注册与依赖注入跑起来。这是「核心包 / bundle」的写法。

我们这类**用户侧插件**走的是另一条路：profile 的 `cordis.patch.yml` 直接按函数式插件加载。

```js
export default {
  name: "dsh-lazy-toolbox",
  inject: ["systemPrompt", "tools", "webServer"],
  apply(ctx, config) { ... },
};
```

浏览器半则是 `window.__ModuleLoader__.load({ id, factory })` + `inject = ["slots"]`，
再 `ctx.slots.register(...)` 往 `settings.section` 里塞一栏。这两段都在
[`client.js`](../client.js) 里，官方 `dsh-client-ui-settings` 用的是同一套 slot 机制。

## 三、逐项对比：dsh-lazy-toolbox vs 官方

| 项 | 官方 | 本插件（0.7.1） | 处理 |
| --- | --- | --- | --- |
| ESM | 307/307 | ✅ `"type": "module"` | 一致 |
| `files` 发布清单 | 307/307 | ✅ 12 条 | 一致 |
| 条件式 `exports` | 307/307 | ✅ 改成 `{ default: ... }` 对象 | **已对齐** |
| `icon` | bundle 类有 | ✅ 新增 `icon.svg` + `"icon"` | **已对齐** |
| `dsh.client.platform` | `"web"` | ✅ `"web"` | 一致 |
| `dsh.client.inject` | 包名数组 | ✅ `["@deepseek-ai/dsh-client-ui-settings"]` | 一致 |
| `peerDependencies` | 299/307（cordis） | ❌ 不写 | 有意不写：本插件不 import cordis，运行时只吃宿主传进来的 `ctx`，写 peer 只会让人多装一个不需要的包 |
| `types` | 302/307 | ❌ 纯 JS | 有意不写：零构建、零依赖，加 `.d.ts` 得维护一份并行定义，收益小于成本 |
| `dsh.bundle.patch` | 18/307 | ✅ `./cordis.patch.yml` | **已对齐（0.7.1）**：DSH 的「添加插件」只认带 `dsh.bundle` 的包，没有就报 `declares no dsh.bundle`，所以补上 |
| 入口导出 | 类 + Schema | 函数式插件对象 | 按用户侧插件的加载方式走，和 profile 里的写法一致 |
| `dsh.install` | 0/307 | ✅ 有 | **本插件扩展**：告诉市场类 UI「怎么装我」，官方核心包不需要这个字段 |

## 四、结论

格式上能对齐的都对齐了（条件式 `exports`、`icon`、`files`、`dsh.client` 形态、
`dsh.bundle.patch`）。剩下两处刻意不同，都不是遗漏：

1. **不写 `peerDependencies`**：我们一行都不 import cordis，运行期只用宿主给的 `ctx`；
2. **不写 `types`**：整个插件零依赖零构建，仓库里没有 `lib/types/` 这一层。

`dsh.bundle.patch` 这条是 0.7.1 补的，起因很具体：DSH 的 `插件 → 添加插件` 在装本地目录
或 GitHub 仓库时，先读 `manifest.dsh.bundle.patch`，读不到就直接拒绝安装
（`这个包没有声明组合包，无法作为插件安装`）。所以包内必须有
[`cordis.patch.yml`](../cordis.patch.yml)，内容与 `wire-profile` 写进 profile 的那一段完全一致。

如果哪天要往 npm 发布成「官方风格」的核心包，第一步是把 `lib/*.js` 拆成 TS 源码 + 构建产物
（`lib/types/**/*.d.ts`），第二步是补 `cordis.patch.yml` 的完整 profile 层（我们现在只插自己一行）。
