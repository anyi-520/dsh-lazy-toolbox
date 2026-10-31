# 加载方式与「不做懒加载」名单

## 一、每条目两种加载方式

设置 → 懒工具箱 里，每个 skill / MCP 右边是两段式选择器：

| 选项 | 含义 |
| --- | --- |
| **懒加载**（默认） | 进系统提示的目录（一句话用途），AI 需要时按需注入定义/大纲 |
| **跳过** | **不做懒加载**：不进目录、`load` 直接拒绝；文件与配置都还在，随时切回来 |

AI 侧等价动作：`toolbox { action: "mode", ids: ["skill:ds"], mode: "skip" }`（或 `"lazy"`）。
命令行：`node bin/cli.mjs mode skill:ds skip`。

「跳过」和原来的开关（`enable` / `disable`）是同一份事实（`store.json` 的
`disabled.skills` / `disabled.mcp`），只是叫法更贴切；`disable` 仍然可用。

## 二、「不做懒加载」名单（破甲类插件）

有一类插件本身就往系统提示词里 hook 一大坨提示词（破甲 / 越狱 / 反审查），或者自带一个
「教怎么绕过限制」的 skill。这类东西被懒工具箱接管会出两个问题：

1. **双重注入**：插件自己 hook 一份，懒工具箱再 load 一份，提示词翻倍还互相打架；
2. **失控**：目录里一句轻描淡写的用途，可能骗过模型让它自己把这种东西拉进上下文。

所以命中名单的插件，其内置 skill / MCP **不接管、不登记、不进目录**——插件自己怎么注入
就怎么注入，懒工具箱不掺和。名单里的插件如果之前版本已经接管过，下一次扫描会撤掉登记
（不删插件里的文件）。

### 内置名单（包名精确匹配）

```
dsh-purge  dsh-jailbreak  dsh-jail-break  dsh-break-armor  dsh-armor-breaker
dsh-unfiltered  dsh-uncensored  dsh-prompt-inject  dsh-prompt-injection  dsh-redteam-prompts
```

### 内置模式（包名/条目名正则）

`jailbreak` / `jail-break` / `破甲` / `越狱` / `uncensor` / `unfiltered` / `nsfw` /
`prompt-inject` / `armor-break` / `dan` / `developer-mode` / `safety-bypass`

### 配置

```yaml
config:
  neverLazyBuiltin: true      # false = 内置名单不生效，全部照常接管
  neverLazyExtra:             # 追加自己的（子串匹配，大小写不敏感）
    - my-shady-plugin
```

单个插件也能自己退出：它的 `package.json` 写 `"dsh": { "autoDetect": false }`。

### 看命中情况

```bash
node bin/cli.mjs discover --dry-run     # 会列出「跳过」的插件与命中原因
toolbox { action: "discover" }          # AI 侧同一份报告
```

日志里有 `discover.blocked` 事件（`logs/plugin-YYYYMMDD.log`），记录插件名与命中的规则。

## 三、注意

- 名单只影响**懒工具箱的接管**，不改变插件自身的任何行为，也不删任何文件；
- 名单不是「判断某个插件是好是坏」，只是「这类插件的内置能力交给它自己管」；
- 想反过来用（明明在名单里，但你希望懒工具箱接管），把 `neverLazyBuiltin` 关掉，或者把该
  插件改名/加 `autoDetect:false` 的反面做法——直接在 `neverLazyExtra` 里不要包含它即可。
