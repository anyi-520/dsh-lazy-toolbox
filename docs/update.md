# 云更新

设置页第一张卡片就是「云更新」。它做四件事，每一步都要你自己点：

1. **检查**：问 GitHub 仓库的最新 Release，和当前版本比；
2. **显示更新内容**：Release 正文（就是 CHANGELOG 那种）原样显示在卡片里，可滚动；
3. **下载**：把发布包 `dsh-lazy-toolbox-<版本>.zip` 下到 `<数据目录>/updates/`，并解压好；
4. **安装**：先备份现有文件，再覆盖；装完卡片变成红字提示 **关掉 DSH 再打开**（只刷新页面不够）。

## 数据从哪来

```
GET https://api.github.com/repos/<updateRepo>/releases/latest
```

只依赖公开接口，不需要你自建服务器。有私有仓库或撞到限流时，可以把 token 放进环境变量
`GH_TOKEN` / `GITHUB_TOKEN`，检查与下载都会带上。

检查结果落盘在 `<数据目录>/update-state.json`，所以设置页打开就有东西看，断网也不会白屏；
启动时如果有缓存就先显示缓存，再延迟 4 秒在后台查一次（不阻塞启动）。

## 配置

```yaml
config:
  updateRepo: anyi-520/dsh-lazy-toolbox  # owner/repo，可换成你自己的 fork
  updateCheck: true                       # 启动时自动检查
  updateCheckHours: 6                     # 隔多久算「该查了」（缓存本身 10 分钟内复用）
```

## 三条路径都能用

设置页：

```
设置 → 懒工具箱 → 云更新： [检查更新] [下载 v0.6.0] [安装 v0.6.0]
```

命令行：

```bash
node bin/cli.mjs update check      # 打印当前/最新 + 更新内容
node bin/cli.mjs update download   # 下载并解压
node bin/cli.mjs update install    # 覆盖安装（自动备份），提示重启
```

AI 侧：

```jsonc
toolbox { "action": "update", "step": "check" }
toolbox { "action": "update", "step": "download" }
toolbox { "action": "update", "step": "install" }
```

## 安全边界

- **不自己重启进程**：插件只写「需要重启」标记，重启由你决定；
- **覆盖前先备份**：现版本的文件整份拷到 `<数据目录>/updates/backup-<旧版本>-<时间戳>/`，
  想回滚直接把备份拷回去；
- **只覆盖插件本体**：`package.json`、`client.js`、`lib/`、`bin/`、`docs/`、`examples/`、`test/`、
  `scripts/`、README、CHANGELOG、LICENSE、NOTICE；**`node_modules`、`.git`、数据目录一律不碰**；
- **下载校验大小**：Release 里写了 `size` 就比对，下载不完整直接报错，不写坏文件；
- **解压失败不硬来**：Windows 用 `Expand-Archive`（PowerShell），其他平台用 `unzip`；
  失败时只保留 zip 并提示手动解压，不会假装成功。

## 版本比较

`0.10.0 > 0.9.9`，`1.0.0 > 1.0.0-rc.1`（预发布比正式低）。所以正式版发布后，装过 rc 的机器会
提示升级到正式版。

## 常见问题

**装完还是老版本？** 只刷新页面不够，前端 bundle 是启动时扫描的，必须整个关掉 DSH 再打开。

**检查失败 404？** `updateRepo` 写错了，或者这个仓库还没有 Release。

**提示「没有可下载的 zip 附件」？** 那个 Release 没上传发布包；去 Release 页面手动下载，
或者用 `git pull` 更新。

**想换回旧版本？** 拷 `<数据目录>/updates/backup-*/` 里的内容回插件目录，再重启。
