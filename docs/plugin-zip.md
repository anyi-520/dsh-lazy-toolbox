# 用 zip 直接装插件

官方「插件 → 添加插件」认三种输入：包名、GitHub 仓库地址、**已解压的本地目录**。
压缩包得先自己解开，还得包里声明了 `dsh.bundle` 才能当插件层装。

懒工具箱把这一步省掉：给一个 `.zip`，本地解压、校验、装到位、接线，一条龙。

## 在界面上用

`设置 → 懒工具箱 → 工具 → 导入插件 zip`：

| 动作 | 效果 |
| --- | --- |
| 把 `.zip` 拖到虚线框 | 松手就开始装 |
| 把 `.zip` 拖到设置页任意位置 | 同上（只认 `.zip`，别的文件不理） |
| 点「选择 zip」 | 打开文件框挑一个 |
| 装完点「复制安装目录」 | 把 `plugins/<名字>-<版本>` 路径复制到剪贴板 |
| 装完点「填进官方弹窗」 | 直接把路径写进官方「添加插件」的输入框（用原生 value setter + input 事件，绕开受控 React 覆盖），然后你点它的「安装」即可 |

卡片会把结果摊开：装到哪、几个文件、是不是组合包、每个 profile 的依赖 / 链接 / patch 三件事各是什么状态，
最后一句话提示**重启 DSH 生效**。

## 在命令行用

```bash
dsh-lazy-toolbox import dsh-lazy-toolbox-0.7.3.zip            # 装
dsh-lazy-toolbox import 插件.zip --dry-run                    # 只看条目数/清单路径，不落地
dsh-lazy-toolbox import 插件.zip --profile "C:/Users/me/.dsh/profiles/desktop"
dsh-lazy-toolbox import 插件.zip --no-overwrite               # 同名同版本已存在就报错，不覆盖
```

## 它到底做了什么

```
zip 字节
  └─ lib/zip.js        读中央目录 → 逐条 store/deflate 解压（zlib.inflateRawSync）
  └─ lib/importer.js   找插件根（含 package.json 的最浅一层，zip 里多套一层也认）
                       ├─ 校验 package.json（名字、版本、dsh.bundle.patch）
                       ├─ 落地到 <数据目录>/plugins/<名字>-<版本>/
                       └─ 接线到每个 profile：
                            1. package.json → dependencies[name] = "link:<目录>"
                            2. package.json → dsh.profile.bundles += name
                            3. cordis.patch.yml ← 追加包自带的 insert 行
                            4. node_modules/<name> → 目录链接（junction）
```

装完不重启也能看到文件，但**插件要重启 DSH 才会被加载**（服务端模块是启动时读的）。

## 安全边界

导入的是别人给的压缩包，所以读的时候就把边界设死：

| 边界 | 值 | 说明 |
| --- | --- | --- |
| zip-slip | 直接拒绝 | 条目名含 `..`、以 `/` 开头、或带 `C:` 盘符，一律报错不落盘 |
| 条目数 | 5000 | 防小文件炸弹 |
| 单文件 | 64 MB | 解压后算 |
| 总计 | 256 MB | 解压后算 |
| 符号链接 | 跳过 | 不让压缩包在磁盘上放链接 |
| 暂存目录 | 用完即删 | 失败也会清理 |

另外：只认 `store` / `deflate` 两种压缩方式，不支持加密包与 ZIP64；CRC 不校验（后面还要读
`package.json` 做语义校验，坏包会在那一步暴露）。

## 已知限制（为什么不改官方那个弹窗）

官方「添加插件」的输入框是 `@deepseek-ai/dsh-client-ui-plugin-manager` 里的**受控 React 输入**，
它的值只认自己那份 state。第三方插件从外面写 DOM 的值，React 下一次渲染就会覆盖回去，
而且安装按钮的可用状态也挂在同一份 state 上——改不动、也不该改。

所以这里做成**等价的自有入口**：拖进去 → 直接装完（比「拖进来填路径再点安装」少一步），
装完把目录路径复制给你，你要走官方流程就粘过去。

## 卸掉

```bash
# 1) 从 profile 里摘掉
dsh-lazy-toolbox unwire-profile          # 只摘懒工具箱自己
# 别人的插件：手动删 profile package.json 的 dependencies / bundles 里那两项，
#             再删 profile cordis.patch.yml 里对应的 insert 行
# 2) 删插件目录
rm -rf "<数据目录>/plugins/<名字>-<版本>"
```
