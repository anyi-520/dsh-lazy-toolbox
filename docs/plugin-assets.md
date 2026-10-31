# 插件内置的 skill / MCP：自动接管

很多插件本身就带能力：一个 `skills/` 目录、一个 `mcp.json`，或者在 `package.json` 里写
`dsh.skills` / `dsh.mcp`。装了这种插件，你本来还得手动把它们加进懒工具箱，否则它们要么
被 DSH 全量塞进工具定义（占上下文），要么干脆没人知道。

**0.5.2 起不用手动加了**：懒工具箱启动时、以及每次扫描时会看一遍已安装的插件包，
把里面内置的 skill 与 MCP 服务登记进库，出现在目录里，可以直接 `load`。

## 支持哪些写法

| 写法 | 例子 |
| --- | --- |
| `package.json` 的 `dsh.skills` | `"dsh": { "skills": ["skills", "./extra"] }` |
| `package.json` 的 `dsh.skill` | `"dsh": { "skill": "skills/foo" }` |
| 约定目录（无需声明） | `<包>/skills/`、`<包>/dsh/skills/`、`<包>/.dsh/skills/` |
| `package.json` 的 `dsh.mcp` / `mcpServers` | `"dsh": { "mcp": { "name": { "command": "node", "args": ["s.js"] } } }` |
| 配置文件 | `<包>/mcp.json`、`<包>/.dsh/mcp.json`、`<包>/dsh/mcp.json`、`<包>/mcp-servers.json` |

约定目录下，要么目录自己就是 skill（里面有 `SKILL.md`），要么每个子目录是一个 skill。
`mcp.json` 可以写成 `{ "mcpServers": { ... } }`、`{ "servers": { ... } }`，也可以直接是
`{ "名字": { ... } }`。每个服务的配置支持 `command` / `args` / `env` / `cwd` 或 `url` / `headers`。

不想被接管的插件，在 `package.json` 里写 `"dsh": { "autoDetect": false }` 即可。

## 接管是怎么做的（重要）

- **原地引用，不复制**：库里的路径直接指向插件目录里的 skill，插件升级后内容自动是新的，
  不会出现「库里一份旧的、插件里一份新的」；
- **幂等**：已经登记过的不会重复加，反复扫描没有副作用；内容没变时连读盘都省掉（指纹判断）；
- **回收**：插件被卸载后，下一次扫描把对应条目删掉；
- **尊重你的决定**：在设置里关掉、或 `remove` 掉的条目不会被自动复活；
- **不动插件文件**：删除这类条目只删登记（`remove` 会告诉你「文件在插件里，未动」）。

## 三条使用路径

```bash
# 立刻扫一遍（--dry-run 只报告不写入）
node bin/cli.mjs discover --dry-run
node bin/cli.mjs discover
```

或者让 AI 来：`toolbox { action: "discover" }`（带 `dry_run: true` 可以先看）。

自动扫描默认开启，可用配置关掉：

```yaml
config:
  autoDetectPluginAssets: false
```

## 一个完整例子

假设你装了一个叫 `demo-skillpack` 的插件，它的 `package.json` 长这样：

```json
{
  "name": "demo-skillpack",
  "dsh": {
    "skills": ["skills"],
    "mcp": { "demo-echo": { "command": "node", "args": ["server.mjs"], "summary": "演示用 echo MCP" } }
  }
}
```

目录里有 `skills/release-notes/SKILL.md`。扫描之后：

```
$ node bin/cli.mjs discover
看过 1 个插件包
+ skill:demo-release-notes	← demo-skillpack	D:\...\demo-skillpack\skills\release-notes
+ mcp:demo-echo	← demo-skillpack
```

设置页「懒工具箱」里这两行会带「插件 demo-skillpack」的小标签，AI 的目录里也会多出两条，
一句话用途分别是 SKILL.md 的 `description` 和 mcp 条目的 `summary`。

完整的插件骨架见仓库里的 [`examples/plugin-with-skill/`](../examples/plugin-with-skill/)。
