# 安装 / 卸载

## 前置

- DSH Desktop 0.2.1-rc.x（`$DSH_HOME` 默认 `~/.dsh`）
- Node.js >= 20
- 建议先退出 DSH 再动 profile 文件（改完重启生效）

## 方式零：图形界面「添加插件」（最省事）

DSH 里 `插件 → 添加插件`，填包名、GitHub 仓库地址或**本地目录路径**都行：

```
D:\dsh-lazy-toolbox           # 解压出来的目录
```

能装成插件的前提是包里有 `dsh.bundle` 声明（0.7.1 起已有）：

```jsonc
// package.json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

```yaml
# cordis.patch.yml —— 装进 profile 时插这一行
- insert:
    - id: lazy-toolbox
      name: dsh-lazy-toolbox
      inject: [systemPrompt, tools, webServer]
      config:
        autoImport: true
        autoUnloadOnTurnEnd: true
```

装完 DSH 会自己把依赖、`dsh.profile.bundles` 和这行 patch 写进 profile，**重启 DSH 生效**。
早期版本（≤ 0.7.0）没有这个字段，图形界面会报
`这个包没有声明组合包，无法作为插件安装：dsh-lazy-toolbox declares no dsh.bundle`，
换 0.7.1 或走下面的方式一。

## 方式一：本地目录（推荐给开发）

```bash
git clone <repo> dsh-lazy-toolbox
cd dsh-lazy-toolbox
node bin/cli.mjs wire-profile          # 自动找 $DSH_HOME/profiles/* 并接线
```

它做三件事，全部幂等：

1. `package.json` 的 `dependencies` 加 `"dsh-lazy-toolbox": "link:<绝对路径>"`；
2. `package.json` 的 `dsh.profile.bundles` 加 `dsh-lazy-toolbox`；
3. `cordis.patch.yml` 末尾加 insert 行（id `lazy-toolbox`），并在 profile 的 `node_modules`
   里建一个指向插件目录的目录链接（junction），重启即可解析。

写进去的那一行和包里的 `cordis.patch.yml`（方式零用的）是同一段内容，两种装法不叠加。

指定 profile：

```bash
node bin/cli.mjs wire-profile --profile "C:/Users/me/.dsh/profiles/desktop"
```

## 方式二：npm

```bash
npm i -g dsh-lazy-toolbox        # 或 npm i -D 到 profile 目录
dsh-lazy-toolbox wire-profile
```

`wire-profile` 写的是 `link:` 依赖。从 npm 安装时应改成版本号：

```jsonc
"dependencies": { "dsh-lazy-toolbox": "^0.1.0" }
```

然后 `pnpm install`（DSH 启动时也会自己跑一次）建好链接。

## 方式三：手动

```jsonc
// $DSH_HOME/profiles/desktop/package.json
{
  "dependencies": { "dsh-lazy-toolbox": "link:D:/path/to/dsh-lazy-toolbox" },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-lazy-toolbox"
      ]
    }
  }
}
```

```yaml
# $DSH_HOME/profiles/desktop/cordis.patch.yml（末尾追加）
- insert:
    - id: lazy-toolbox
      name: dsh-lazy-toolbox
      inject: [systemPrompt, tools]
      config:
        autoMigrate: true
        autoImport: true
        autoUnloadOnTurnEnd: true
```

再把插件目录链接进 `node_modules/dsh-lazy-toolbox`（Windows 用 junction，Linux/macOS 用 symlink）。

## 首次启动会发生什么

1. 读取 profile 的 `cordis.patch.yml`，把 `@deepseek-ai/dsh-mcp-client` 条目搬进
   `$DSH_HOME/lazy-toolbox/store.json`，并从 yml 里删掉（原文 + 行号已保存）。
2. 扫描 `$DSH_HOME/skills`、`~/.agents/skills`（以及 `autoImportProjectSkills` 开启时的项目目录），
   把 skill 单元整体移进 `$DSH_HOME/lazy-toolbox/skills/`。
3. 注册 `toolbox` 工具与目录 section。

**注意**：MCP 的全局工具定义要等这次重启才消失；skill 目录被搬走后 `skill` 工具也不再索引它。
先用 CLI 预览：

```bash
dsh-lazy-toolbox migrate --dry-run
```

## 卸载

```bash
node scripts/preuninstall.mjs          # 或者用包管理器卸载，会自动跑 preuninstall
node bin/cli.mjs unwire-profile        # 手动摘线：insert / bundles / link
```

`preuninstall` 顺序：

1. skill 目录移回原位（目标被占用则跳过并报告）；
2. MCP 条目按保存的行号写回 `cordis.patch.yml`（改前备份 `.lazy-toolbox-backup`）；
3. 摘掉 insert 行、bundles 项与 node_modules 链接。

**插件库不会自动删**：`$DSH_HOME/lazy-toolbox` 留着，方便排查或再装回来。确认不需要了再手动删。

## 只想临时停用

从 `cordis.patch.yml` 删掉 insert 行（或加 `disabled: true`），重启即可；插件库与迁移状态都保留。
