# 内置代码编辑器

改文件不必再走终端。终端里一条命令打错就是一个来回 = 一次多余的 token 消耗；编辑器把
「读 → 改 → 校验 → 写」放在插件进程内，**写之前先做语法校验，不通过就不落盘**，并且直接
告诉你第几行第几列。

## 一、给 AI 用：`toolbox` 的 `action: "code"`

```jsonc
toolbox { "action": "code", "step": "read",     "path": "lib/index.js" }
toolbox { "action": "code", "step": "patch",    "path": "lib/index.js", "find": "旧字符串", "replace": "新字符串" }
toolbox { "action": "code", "step": "validate", "path": "lib/index.js", "content": "（可选，不传则校验磁盘上的内容）" }
toolbox { "action": "code", "step": "write",    "path": "lib/index.js", "content": "整篇内容" }
toolbox { "action": "code", "step": "revert",   "path": "lib/index.js" }
```

| step | 干什么 | 注意 |
| --- | --- | --- |
| `read` | 读磁盘内容，带类型 / 行数 / 字符数 / 修改时间 | 超过 400 KB 拒读，提示分段 |
| `validate` | 只校验不写 | 可以校验还没落盘的内容 |
| `write` | 校验通过才写 | 校验失败返回错误清单、`written: false`；确认无误可传 `force: true` |
| `patch` | 找一段**唯一**文本替换 | 出现多次会报错，要全部替换传 `all: true` |
| `revert` | 回到这个文件最近一次写入前的备份 | 备份在 `<数据目录>/editor-backups/` |

路径按当前工作目录解析（相对路径可以），绝对路径也行。

## 二、校验规则

| 类型 | 校验方式 | 能抓到什么 |
| --- | --- | --- |
| `.js` `.mjs` `.cjs` `.jsx` | **真解析器**：`node --check`（临时文件，ESM/CJS 都认） | 语法错 + `第 N 行 第 M 列` + `Unexpected token` 之类的原始信息 |
| `.json` | `JSON.parse`，把 position 换算成行列 | 逗号/引号/尾逗号这类错，精确到行列 |
| `.yml` `.yaml` | 浅校验 | Tab 缩进、缩进不是 2 的倍数、引号没闭合、括号没配平 |
| `.ts` `.tsx` | 只看括号配平 | 类型检查得走 `tsc`，插件里不做 |
| `.md` `.txt` 其他 | 不校验 | 只报字符数 |

`node --check` 用的是宿主自带的 node，不需要额外装什么。

## 三、设置页里用：「设置 → 懒工具箱 → 工具」

一行路径输入 + `读取 / 校验 / 保存 / 回滚` 四个按钮 + 一个等宽字体编辑区，下面直接列
校验结果（绿=通过，红=第几行第几列错在哪）。适合想手动看一眼、改两个字再存。

同一个标签里还有两个动作：

- **扫描插件内置资产**：立刻扫一遍已安装插件自带的 skill / MCP / 工具组；
- **撤掉本会话注入**：把这次会话里注入的工具定义全部撤掉（等于 `unload` 全部）。

## 四、命令行

```bash
dsh-lazy-toolbox code read lib/index.js
dsh-lazy-toolbox code validate lib/index.js
dsh-lazy-toolbox code write lib/index.js --content-file /tmp/new.js
dsh-lazy-toolbox code revert lib/index.js
```

`code validate` 不通过时退出码是 1，方便串在脚本里。

## 五、HTTP 接口（设置页用的同一套）

```
POST /dsh-lazy-toolbox/api   { "op": "code.read",     "path": "..." }
POST /dsh-lazy-toolbox/api   { "op": "code.validate", "path": "...", "content": "..." }
POST /dsh-lazy-toolbox/api   { "op": "code.write",    "path": "...", "content": "...", "force": false }
POST /dsh-lazy-toolbox/api   { "op": "code.revert",   "path": "..." }
```

## 六、安全边界

- 只写你给的那个路径，不递归、不批量；
- 覆盖之前一定留备份（`editor-backups/<时间戳>-<文件名>`），`revert` 只回退最近一次；
- 校验失败默认不落盘，`force: true` 才强写，强写会在返回里标 `forced: true`；
- 写入用 UTF-8、去掉 BOM（PowerShell 的 `Get-Content | Set-Content` 把中文写成乱码那类事故，用这条路可以避开）。
