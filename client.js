/**
 * dsh-lazy-toolbox —— 浏览器半（设置 →「懒工具箱」）。
 *
 * 只做一件事：skill 与 MCP 的开关面板。和 AI 看到的目录同源，
 * 关掉 = 不进系统提示的目录、不许 load；文件与配置都保留。
 * 数据来自 /dsh-lazy-toolbox/api，和 AI 用 toolbox 看到的是同一份事实。
 *
 * （外部工具链面板已经拆成独立插件 dsh-toolchain，本 bundle 不再包含它。）
 */
window.__ModuleLoader__.load({
  id: "dsh-lazy-toolbox",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;
    const { useState, useEffect, useCallback } = react;

    const API = "/dsh-lazy-toolbox/api";

    const COLORS = {
      ok: "#1f9d55",
      off: "#7a7a7a",
    };

    async function callApi(payload) {
      const options = payload
        ? {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }
        : { credentials: "same-origin", cache: "no-store" };
      const response = await fetch(API, options);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }

    const styles = {
      wrap: { display: "flex", flexDirection: "column", gap: 14, padding: "4px 0 8px" },
      card: {
        border: "0.5px solid var(--dsw-alias-settings-card-stroke, rgba(0,0,0,.1))",
        background: "var(--dsw-alias-settings-card-fill, transparent)",
        borderRadius: "var(--dsw-radius-xl, 16px)",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      },
      title: { margin: 0, fontSize: 14, fontWeight: 500, color: "var(--dsw-alias-label-primary, #111)" },
      desc: { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary, #777)" },
      pillBase: {
        fontSize: 11,
        lineHeight: "18px",
        padding: "1px 8px",
        borderRadius: 999,
        border: "0.5px solid currentColor",
        whiteSpace: "nowrap",
      },
      hint: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #888)" },
    };

    /** 一个开关：关掉 = 不进系统提示目录、不许 load，文件与配置都还在。 */
    function Switch({ checked, disabled, onChange }) {
      return h("button", {
        type: "button",
        role: "switch",
        "aria-checked": checked ? "true" : "false",
        title: checked ? "点击关闭" : "点击开启",
        disabled: Boolean(disabled),
        onClick: () => onChange(!checked),
        style: {
          width: 38,
          height: 21,
          flex: "0 0 auto",
          borderRadius: 999,
          border: "0.5px solid var(--dsw-alias-border, rgba(0,0,0,.14))",
          background: checked ? "var(--dsw-alias-button-primary-fill, #111)" : "transparent",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.5 : 1,
          padding: 0,
          position: "relative",
          transition: "background .15s",
        },
      },
        h("span", {
          style: {
            position: "absolute",
            top: 2,
            left: checked ? 19 : 2,
            width: 15,
            height: 15,
            borderRadius: "50%",
            background: checked ? "var(--dsw-alias-label-primary-foreground, #fff)" : "var(--dsw-alias-label-tertiary, #999)",
            transition: "left .15s",
          },
        }),
      );
    }


    /** 一个小按钮。 */
    function Btn({ label, onClick, disabled, primary, tone }) {
      const color = tone === "danger" ? "#b4232b" : primary ? "var(--dsw-alias-label-primary-foreground, #fff)" : "var(--dsw-alias-label-primary, #111)";
      return h(
        "button",
        {
          type: "button",
          disabled: Boolean(disabled),
          onClick,
          style: {
            fontSize: 12,
            lineHeight: "20px",
            padding: "3px 12px",
            borderRadius: 999,
            cursor: disabled ? "default" : "pointer",
            opacity: disabled ? 0.5 : 1,
            border: primary ? "none" : "0.5px solid var(--dsw-alias-border, rgba(0,0,0,.18))",
            background: primary ? "var(--dsw-alias-button-primary-fill, #111)" : "transparent",
            color,
          },
        },
        label,
      );
    }

    /**
     * 云更新：查仓库有没有新版本 → 显示更新内容 → 下载 → 覆盖安装 → 提示重启。
     * 数据来自宿主 GET /dsh-lazy-toolbox/api 的 update 字段（读的是本地缓存，不联网）。
     */
    function UpdateCard({ update, busy, onCheck, onDownload, onInstall }) {
      const state = update ?? {};
      const current = state.current ?? "?";
      const latest = state.latest ?? "";
      const installed = state.installed ?? null;
      const download = state.download ?? null;
      const restartRequired = installed?.restartRequired === true;

      return h(
        "div",
        { style: styles.card },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
          h("h3", { style: styles.title }, "云更新"),
          h(
            "span",
            { style: { ...styles.pillBase, color: state.hasUpdate ? COLORS.ok : COLORS.off } },
            state.hasUpdate ? `有新版本 ${latest}` : latest ? "已是最新" : "还没检查过",
          ),
          h("span", { style: styles.hint }, `当前 v${current}${state.checkedAt ? ` · 检查于 ${String(state.checkedAt).slice(0, 16).replace("T", " ")}` : ""}`),
        ),
        h("p", { style: styles.desc }, `从 ${state.repo ?? "仓库"} 拉 Release：只显示更新内容，下载与安装都由你点，装完提示重启。`),
        restartRequired
          ? h(
              "div",
              {
                style: {
                  fontSize: 12,
                  lineHeight: "18px",
                  padding: "8px 10px",
                  borderRadius: 10,
                  background: "rgba(180,35,43,.08)",
                  color: "#b4232b",
                },
              },
              `已安装 v${installed?.version ?? ""}（${installed?.files ?? 0} 项，备份在 ${installed?.backupDir ?? "-"}）。请关掉 DSH 再打开让新版本生效——只刷新页面不够。`,
            )
          : null,
        state.error && !latest ? h("div", { style: { ...styles.hint, color: "#b4232b" } }, `检查失败：${state.error}`) : null,
        latest && state.notes
          ? h(
              "div",
              {
                style: {
                  maxHeight: 220,
                  overflow: "auto",
                  border: "0.5px solid var(--dsw-alias-border, rgba(0,0,0,.1))",
                  borderRadius: 10,
                  padding: "8px 10px",
                  fontSize: 11.5,
                  lineHeight: "17px",
                  whiteSpace: "pre-wrap",
                  color: "var(--dsw-alias-label-secondary, #333)",
                },
              },
              state.notes,
            )
          : null,
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
          h(Btn, { label: busy === "check" ? "检查中…" : "检查更新", onClick: onCheck, disabled: Boolean(busy) }),
          state.hasUpdate
            ? h(Btn, {
                label: busy === "download" ? "下载中…" : download ? `重新下载 v${download.version}` : `下载 v${latest}`,
                onClick: onDownload,
                disabled: Boolean(busy),
              })
            : null,
          download?.extracted && state.hasUpdate
            ? h(Btn, {
                label: busy === "install" ? "安装中…" : `安装 v${download.version}`,
                onClick: onInstall,
                disabled: Boolean(busy),
                primary: true,
              })
            : null,
          h("span", { style: styles.hint }, download?.extracted ? `已下载并解压到 ${download.packageDir}` : download ? download.extractError : ""),
        ),
        state.htmlUrl
          ? h("a", {
              href: state.htmlUrl,
              target: "_blank",
              rel: "noreferrer",
              style: { fontSize: 11, color: "var(--dsw-alias-label-link, #1a6bd6)" },
            }, "在 GitHub 上查看这个 Release")
          : null,
      );
    }

    /**
     * 加载方式选择器：懒加载 / 跳过。
     * 「跳过」= 不做懒加载：不进系统提示目录、不许 load，文件与配置都还在。
     */
    function ModeSelector({ mode, disabled, onChange }) {
      const options = [
        ["lazy", "懒加载"],
        ["skip", "跳过"],
      ];
      return h(
        "div",
        {
          role: "radiogroup",
          style: {
            display: "inline-flex",
            alignItems: "stretch",
            border: "0.5px solid var(--dsw-alias-border, rgba(0,0,0,.14))",
            borderRadius: 999,
            overflow: "hidden",
            flex: "0 0 auto",
          },
        },
        ...options.map(([value, label]) =>
          h(
            "button",
            {
              key: value,
              type: "button",
              role: "radio",
              "aria-checked": mode === value ? "true" : "false",
              "data-mode": value,
              title: value === "lazy" ? "懒加载：进目录，需要时按需注入" : "跳过：不做懒加载，不进目录、不许注入",
              disabled: Boolean(disabled),
              onClick: () => {
                if (!disabled && mode !== value) onChange(value);
              },
              style: {
                fontSize: 11,
                lineHeight: "18px",
                padding: "2px 9px",
                border: "none",
                cursor: disabled ? "default" : "pointer",
                background: mode === value ? "var(--dsw-alias-button-primary-fill, #111)" : "transparent",
                color: mode === value ? "var(--dsw-alias-label-primary-foreground, #fff)" : "var(--dsw-alias-label-tertiary, #777)",
              },
            },
            label,
          ),
        ),
      );
    }

    /**
     * skill 与 MCP 的开关面板：这份清单和 AI 的 toolbox action=list 同源（store.json），
     * 关掉的条目会从系统提示的目录里消失，也不再允许 load。
     */
    function InventoryCard({ inventory, busy, onToggle, onMode }) {
      const groups = inventory?.groups ?? [];
      const skills = inventory?.skills ?? [];
      const mcp = inventory?.mcp ?? [];
      const counts = inventory?.counts ?? { groups: 0, skills: 0, mcp: 0, groupsOn: 0, skillsOn: 0, mcpOn: 0 };

      const group = (title, hint, rows, kind) =>
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 2 } },
          h(
            "div",
            { style: { display: "flex", alignItems: "baseline", gap: 8 } },
            h("h4", { style: { ...styles.title, fontSize: 13 } }, title),
            h("span", { style: styles.hint }, hint),
          ),
          rows.length === 0
            ? h("div", { style: { ...styles.hint, padding: "6px 0" } }, "（空）")
            : h("div", { style: { display: "flex", flexDirection: "column" } },
                ...rows.map((row) =>
                  h(
                    "div",
                    {
                      key: row.id,
                      style: {
                        display: "grid",
                        gridTemplateColumns: "minmax(0,1fr) auto auto",
                        gap: 10,
                        alignItems: "center",
                        padding: "8px 0",
                        borderTop: "0.5px solid var(--dsw-alias-separator, rgba(0,0,0,.06))",
                        opacity: row.enabled ? 1 : 0.55,
                      },
                    },
                    h(
                      "div",
                      { style: { minWidth: 0 } },
                      h(
                        "div",
                        { style: { fontSize: 12.5, display: "flex", alignItems: "center", gap: 6 } },
                        h("span", { style: { fontFamily: "ui-monospace, Menlo, monospace" } }, row.name),
                        row.external && row.plugin
                          ? h("span", { style: { ...styles.pillBase, color: COLORS.off, fontSize: 10 } }, `插件 ${row.plugin.replace(/^@?deepseek-ai\//, "")}`)
                          : null,
                        row.enabled ? null : h("span", { style: { ...styles.pillBase, color: COLORS.off, fontSize: 10 } }, "已关闭"),
                      ),
                      h("div", { style: { ...styles.hint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, row.summary || "（没有说明）"),
                    ),
                    kind === "mcp"
                      ? h("span", { style: styles.hint }, `${row.toolCount || 0} 个工具 · ${row.transport || "stdio"}`)
                      : kind === "plugin"
                        ? h("span", { style: styles.hint }, `托管 ${row.toolCount || 0} 个工具`)
                        : h("span", { style: styles.hint }, row.source || ""),
                    h(ModeSelector, {
                      mode: row.enabled ? "lazy" : "skip",
                      disabled: busy !== "",
                      onChange: (next) => onMode(row.id, next),
                    }),
                  ),
                ),
              ),
        );

      return h(
        "div",
        { style: styles.card },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 10 } },
          h("h3", { style: styles.title }, "插件工具 / skill / MCP 开关"),
          h(
            "span",
            {
              style: {
                ...styles.pillBase,
                color: counts.groupsOn + counts.skillsOn + counts.mcpOn > 0 ? COLORS.ok : COLORS.off,
              },
            },
            `开着 ${counts.groupsOn ?? 0} 组插件工具 / ${counts.skillsOn} skill / ${counts.mcpOn} MCP`,
          ),
        ),
        h(
          "p",
          { style: styles.desc },
          "分三类：插件工具（别的插件把工具交出来托管，默认一个都不常驻）、skills、mcp。每条右边可以选加载方式：懒加载（进目录，需要时才按需注入，skill 只给大纲）或 跳过（不做懒加载：不进目录、不许注入，文件与配置都还在）。破甲类插件自带的 skill / MCP 会自动落在「跳过」。",
        ),
        group("插件工具", `${counts.groups ?? 0} 组`, groups, "plugin"),
        group("skills", `${counts.skills} 个`, skills, "skill"),
        group("mcp", `${counts.mcp} 个`, mcp, "mcp"),
      );
    }

    /** 三个标签：懒加载 / 工具 / 关于。 */
    const TABS = [
      { id: "lazy", label: "懒加载" },
      { id: "tool", label: "工具" },
      { id: "about", label: "关于" },
    ];

    function Tabs({ tab, onChange }) {
      return h(
        "div",
        {
          role: "tablist",
          style: {
            display: "inline-flex",
            gap: 2,
            padding: 2,
            borderRadius: 999,
            background: "var(--dsw-alias-fill-quaternary, rgba(0,0,0,.04))",
          },
        },
        TABS.map((item) =>
          h(
            "button",
            {
              key: item.id,
              type: "button",
              role: "tab",
              "data-tab": item.id,
              "aria-selected": tab === item.id ? "true" : "false",
              onClick: () => onChange(item.id),
              style: {
                border: "none",
                cursor: "pointer",
                padding: "3px 12px",
                borderRadius: 999,
                fontSize: 12,
                lineHeight: "18px",
                background: tab === item.id ? "var(--dsw-alias-button-primary-fill, #111)" : "transparent",
                color: tab === item.id ? "var(--dsw-alias-label-primary-foreground, #fff)" : "var(--dsw-alias-label-secondary, #555)",
                transition: "background .15s, color .15s",
              },
            },
            item.label,
          ),
        ),
      );
    }

    /** 有新版本时的提示：`inline` 时是卡片（设置页里），否则是全局弹窗（进 DSH 就弹）。 */
    function UpdatePrompt({ update, busy, onSnooze, onUpdate, inline }) {
      if (!update?.prompt?.show) return null;
      const body = h(
        "div",
        {
          style: inline
            ? { ...styles.card, gap: 8 }
            : {
                ...styles.card,
                width: "min(420px, 88vw)",
                boxShadow: "0 18px 48px rgba(0,0,0,.28)",
                background: "var(--dsw-alias-bg-elevated, #fff)",
              },
        },
        h("h3", { style: styles.title }, "懒工具箱有新版本"),
        h(
          "p",
          { style: styles.desc },
          `现在 ${update.current ?? "?"} → 最新 ${update.latest ?? "?"}。更新只覆盖插件自己的文件，装完重启 DSH 生效。`,
        ),
        h(
          "div",
          { style: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4, flexWrap: "wrap" } },
          h(Btn, { label: "本次不提醒", onClick: () => onSnooze("session"), disabled: Boolean(busy) }),
          h(Btn, { label: "今天不提醒", onClick: () => onSnooze("today"), disabled: Boolean(busy) }),
          h(Btn, { label: "更新", primary: true, onClick: onUpdate, disabled: Boolean(busy) }),
        ),
      );
      if (inline) return body;
      return h(
        "div",
        {
          style: {
            position: "fixed",
            inset: 0,
            zIndex: 60,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,.32)",
          },
        },
        body,
      );
    }

    /**
     * 全局弹窗（挂 `shell.overlay`）：进 DSH 就自己拉一次状态，有新版本就弹。
     * 设置页里那份是内联卡片，两者共用 UpdatePrompt，静默状态在后端同一个人手里。
     */
    function UpdateDialog() {
      const [update, setUpdate] = useState(null);
      const [busy, setBusy] = useState("");
      const [hidden, setHidden] = useState(false);

      useEffect(() => {
        let alive = true;
        const pull = async () => {
          try {
            const data = await callApi();
            if (alive && data?.update) setUpdate(data.update);
          } catch {
            /* 拉不到就下次再说 */
          }
        };
        pull();
        // 宿主启动后约 4 秒才去查新版本，这里再补两次，保证「进 DSH 就能看到」
        const first = setTimeout(pull, 6000);
        const second = setTimeout(pull, 20000);
        return () => {
          alive = false;
          clearTimeout(first);
          clearTimeout(second);
        };
      }, []);

      const act = async (op, body) => {
        setBusy(op);
        try {
          const data = await callApi({ op, ...(body ?? {}) });
          if (data?.update) setUpdate(data.update);
          setHidden(true);
        } catch {
          /* 失败不打扰用户，设置页里能看到错误 */
        } finally {
          setBusy("");
        }
      };

      if (hidden) return null;
      return h(UpdatePrompt, {
        update,
        busy,
        inline: false,
        onSnooze: (scope) => act("update.snooze", { scope }),
        onUpdate: () => act("update.download"),
      });
    }

    /** 「工具」标签：扫描资产 / 撤掉注入 / 内置代码编辑器。 */
    function ToolsPanel({ busy, onDiscover, onUnloadAll, editor }) {
      const editorStyle = {
        width: "100%",
        minHeight: 180,
        resize: "vertical",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 12,
        lineHeight: "18px",
        padding: 10,
        borderRadius: 10,
        border: "0.5px solid var(--dsw-alias-border, rgba(0,0,0,.14))",
        background: "var(--dsw-alias-fill-quaternary, rgba(0,0,0,.02))",
        color: "var(--dsw-alias-label-primary, #111)",
        boxSizing: "border-box",
      };
      const inputStyle = { ...editorStyle, minHeight: 0, height: 30, padding: "4px 10px" };
      const validation = editor.result;
      return h(
        "div",
        { style: styles.card },
        h("h3", { style: styles.title }, "工具"),
        h(
          "p",
          { style: styles.desc },
          "代码编辑器：读写文件不经过终端，写之前先做语法校验（JS 走真解析器、JSON 走 JSON.parse、YAML 浅校验），不通过就不落盘，并直接给出第几行第几列。",
        ),
        h(
          "div",
          { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
          h(Btn, { label: busy === "discover" ? "扫描中…" : "扫描插件内置资产", onClick: onDiscover, disabled: Boolean(busy) }),
          h(Btn, { label: busy === "unloadAll" ? "撤销中…" : "撤掉本会话注入", onClick: onUnloadAll, disabled: Boolean(busy), tone: "danger" }),
        ),
        h(
          "div",
          { style: { display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap", alignItems: "center" } },
          h("input", {
            type: "text",
            placeholder: "文件路径（相对当前工作目录，例如 lib/index.js）",
            value: editor.file,
            "data-role": "editor-path",
            onInput: (event) => editor.onPath(event.target.value),
            style: { ...inputStyle, flex: "1 1 220px" },
          }),
          h(Btn, { label: "读取", onClick: editor.onRead, disabled: Boolean(busy) }),
          h(Btn, { label: "校验", onClick: editor.onValidate, disabled: Boolean(busy) }),
          h(Btn, { label: "保存", primary: true, onClick: editor.onSave, disabled: Boolean(busy) }),
          h(Btn, { label: "回滚", onClick: editor.onRevert, disabled: Boolean(busy), tone: "danger" }),
        ),
        h("textarea", {
          value: editor.content,
          "data-role": "editor-body",
          spellCheck: false,
          onInput: (event) => editor.onContent(event.target.value),
          style: { ...editorStyle, marginTop: 6 },
        }),
        validation
          ? h(
              "div",
              { style: { fontSize: 12, lineHeight: "18px", color: validation.ok ? COLORS.ok : "#b4232b" } },
              (validation.ok ? "✅ 校验通过" : "❌ 校验没通过") + `（${validation.kind}）`,
              (validation.errors ?? []).map((item, index) =>
                h("div", { key: `err-${index}`, style: { color: "#b4232b" } }, `第 ${item.line || "?"} 行${item.column ? ` 第 ${item.column} 列` : ""}：${item.message}`),
              ),
              (validation.notes ?? []).map((note, index) => h("div", { key: `note-${index}`, style: styles.hint }, `说明：${note}`)),
            )
          : null,
        editor.note ? h("div", { style: styles.hint }, editor.note) : null,
      );
    }

    /** 「关于」标签：版本 / 仓库 / 更新 / 数据目录。 */
    function AboutCard({ inventory, update, busy, onCheck, onDownload, onInstall }) {
      const repo = "https://github.com/anyi-520/dsh-lazy-toolbox";
      return h(
        "div",
        { style: styles.card },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 10 } },
          h("h3", { style: styles.title }, "关于懒工具箱"),
          h("span", { style: { ...styles.pillBase, color: COLORS.ok } }, `v${update?.current ?? inventory?.version ?? "?"}`),
        ),
        h(
          "p",
          { style: styles.desc },
          "skill / MCP / 插件工具默认不进工具定义，只在系统提示目录里占一行用途；需要时按需注入本会话，用完撤掉。零依赖、文件都在本地。",
        ),
        h(
          "div",
          { style: { fontSize: 12, lineHeight: "20px", color: "var(--dsw-alias-label-secondary, #555)" } },
          h("div", {}, `仓库：`, h("a", { href: repo, target: "_blank", rel: "noreferrer", style: { color: "var(--dsw-alias-brand, #2b6cff)" } }, repo)),
          h("div", {}, `数据目录：${inventory?.dataDir ?? "（见日志）"}`),
          h("div", {}, `当前托管：${inventory?.counts?.groups ?? 0} 组插件工具 / ${inventory?.counts?.skills ?? 0} skill / ${inventory?.counts?.mcp ?? 0} MCP`),
        ),
      );
    }

    /** 顶部那张「插件名片」：图标块 + 名称 + 状态标签 + 来源信息（照插件管理页的样子）。 */
    function PluginHeader({ inventory, update, busy, onCheck }) {
      const version = update?.current ?? inventory?.version ?? "?";
      const healthy = Boolean(inventory);
      const pill = (text, tone) =>
        h(
          "span",
          {
            style: {
              fontSize: 11,
              lineHeight: "18px",
              padding: "1px 8px",
              borderRadius: 6,
              border: "0.5px solid currentColor",
              color: tone === "warn" ? "#b4232b" : tone === "muted" ? "var(--dsw-alias-label-tertiary, #888)" : COLORS.ok,
              whiteSpace: "nowrap",
            },
          },
          text,
        );
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 12 } },
        h(
          "div",
          { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 } },
          h(
            "div",
            {
              style: {
                width: 48,
                height: 48,
                flex: "0 0 auto",
                borderRadius: 14,
                border: "0.5px solid var(--dsw-alias-border, rgba(0,0,0,.12))",
                background: "var(--dsw-alias-fill-quaternary, rgba(0,0,0,.03))",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              },
            },
            h(
              "div",
              {
                style: {
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: "#111",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 2,
                },
              },
              [10, 7, 4].map((width, index) =>
                h("span", {
                  key: `bar-${index}`,
                  style: { width, height: 2, borderRadius: 1, background: "#fff", opacity: 0.9 - index * 0.28 },
                }),
              ),
            ),
          ),
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 8 } },
            h(Btn, { label: busy === "check" ? "检查中…" : "检查更新", onClick: onCheck, disabled: Boolean(busy) }),
            h(Switch, {
              checked: healthy,
              disabled: true,
              onChange: () => {},
            }),
          ),
        ),
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 6 } },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
            h("h3", { style: { ...styles.title, fontSize: 18, fontWeight: 600 } }, "懒工具箱"),
            pill(healthy ? "正常" : "未就绪", healthy ? "ok" : "warn"),
            pill(`v${version}`, "muted"),
            update?.hasUpdate ? pill(`可更新 ${update.latest}`, "muted") : null,
          ),
          h(
            "div",
            { style: styles.desc },
            "skill / MCP / 插件工具默认不进工具定义，只在系统提示目录里占一行用途；需要时按需注入本会话，用完撤掉。",
          ),
        ),
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 6 } },
          h("div", { style: { fontSize: 13, fontWeight: 500, color: "var(--dsw-alias-label-primary, #111)" } }, "来源信息"),
          h(
            "div",
            { style: { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12, color: "var(--dsw-alias-label-secondary, #555)" } },
            h("span", { style: { flex: "0 0 auto" } }, "代码来源"),
            h(
              "code",
              {
                style: {
                  fontSize: 11,
                  padding: "0 6px",
                  borderRadius: 4,
                  background: "var(--dsw-alias-fill-quaternary, rgba(0,0,0,.05))",
                  color: "var(--dsw-alias-label-secondary, #555)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: "70%",
                },
              },
              inventory?.installDir ? `link:${inventory.installDir}` : "link:（未读到安装目录）",
            ),
          ),
          h(
            "div",
            { style: { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12, color: "var(--dsw-alias-label-secondary, #555)" } },
            h("span", { style: { flex: "0 0 auto" } }, "数据目录"),
            h("code", { style: { fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "70%" } }, inventory?.dataDir ?? "—"),
          ),
        ),
      );
    }

    function LazyToolboxSection() {
      const [inventory, setInventory] = useState(null);
      const [error, setError] = useState("");
      const [busy, setBusy] = useState("");
      const [update, setUpdate] = useState(null);
      const [tab, setTab] = useState("lazy");
      const [promptHidden, setPromptHidden] = useState(false);
      const [editorFile, setEditorFile] = useState("");
      const [editorContent, setEditorContent] = useState("");
      const [editorResult, setEditorResult] = useState(null);
      const [editorNote, setEditorNote] = useState("");

      const ingest = useCallback((data) => {
        if (!data || data.ok === false) {
          setError(data?.error || "宿主没有返回数据");
          return;
        }
        setInventory(data.inventory ?? null);
        if (data.update) setUpdate(data.update);
        setError("");
      }, []);

      const refresh = useCallback(async () => {
        try {
          ingest(await callApi());
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        }
      }, [ingest]);

      useEffect(() => {
        refresh();
        // 宿主启动后会异步查一次新版本（约 4 秒），再补一次拉取好让弹窗能出来
        const timer = setTimeout(() => {
          refresh();
        }, 6000);
        return () => {
          clearTimeout(timer);
        };
      }, [refresh]);

      const setMode = async (id, mode) => {
        setBusy(`mode:${id}`);
        try {
          ingest(await callApi({ op: "mode", id, mode }));
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        } finally {
          setBusy("");
        }
      };

      const runUpdate = async (op, key) => {
        setBusy(key);
        try {
          const data = await callApi({ op });
          if (data.update) setUpdate(data.update);
          ingest(data);
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        } finally {
          setBusy("");
        }
      };

      const snooze = async (scope) => {
        setBusy(`snooze:${scope}`);
        try {
          const data = await callApi({ op: "update.snooze", scope });
          if (data.update) setUpdate(data.update);
          setPromptHidden(true);
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        } finally {
          setBusy("");
        }
      };

      const toggle = async (id, next) => {
        setBusy(`toggle:${id}`);
        try {
          ingest(await callApi({ op: "toggle", id, enabled: next }));
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        } finally {
          setBusy("");
        }
      };

      const callEditor = async (op, extra) => {
        setBusy(`code:${op}`);
        setEditorNote("");
        try {
          const data = await callApi({ op, path: editorFile, ...(extra ?? {}) });
          if (op === "code.read" && data.file) {
            setEditorContent(data.file.content ?? "");
            setEditorNote(`已读取 ${data.file.file}（${data.file.lines} 行）`);
            setEditorResult(null);
          } else if (op === "code.validate" && data.validation) {
            setEditorResult(data.validation);
          } else if (op === "code.write" && data.write) {
            setEditorResult({ ok: data.write.written, kind: data.write.kind, errors: data.write.errors ?? [], notes: data.write.notes ?? [] });
            setEditorNote(data.write.message ?? "");
            if (data.write.written) setEditorContent(data.write.content ?? editorContent);
          } else if (op === "code.revert" && data.reverted) {
            setEditorNote(`已回滚到 ${data.reverted.from}`);
            await callEditor("code.read");
          }
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        } finally {
          setBusy("");
        }
      };

      const editor = {
        file: editorFile,
        content: editorContent,
        result: editorResult,
        note: editorNote,
        onPath: setEditorFile,
        onContent: setEditorContent,
        onRead: () => callEditor("code.read"),
        onValidate: () => callEditor("code.validate", { content: editorContent }),
        onSave: () => callEditor("code.write", { content: editorContent }),
        onRevert: () => callEditor("code.revert"),
      };

      const showPrompt = Boolean(update?.prompt?.show) && !promptHidden;

      return h(
        "section",
        { style: styles.wrap },
        h("div", { style: styles.card }, h(PluginHeader, { inventory, update, busy, onCheck: () => runUpdate("update.check", "check") })),
        h(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 } },
          h(Tabs, { tab, onChange: setTab }),
          h(
            "span",
            { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #888)" } },
            tab === "lazy" ? "默认全部懒加载" : tab === "tool" ? "编辑器与运维动作" : "版本与更新",
          ),
        ),
        tab === "lazy" ? h(InventoryCard, { inventory, busy, onToggle: toggle, onMode: setMode }) : null,
        tab === "tool"
          ? h(ToolsPanel, {
              busy,
              onDiscover: () => runUpdate("discover", "discover"),
              onUnloadAll: () => runUpdate("unloadAll", "unloadAll"),
              editor,
            })
          : null,
        tab === "about"
          ? h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: 14 } },
              h(AboutCard, { inventory, update, busy, onCheck: () => runUpdate("update.check", "check") }),
              h(UpdateCard, {
                update,
                busy,
                onCheck: () => runUpdate("update.check", "check"),
                onDownload: () => runUpdate("update.download", "download"),
                onInstall: () => runUpdate("update.install", "install"),
              }),
            )
          : null,
        error ? h("div", { style: { ...styles.hint, color: "#b4232b" } }, error) : null,
        showPrompt
          ? h(UpdatePrompt, {
              update,
              busy,
              inline: true,
              onSnooze: snooze,
              onUpdate: async () => {
                setTab("about");
                setPromptHidden(true);
                await runUpdate("update.download", "download");
              },
            })
          : null,
      );
    }

    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "lazy-toolbox",
            order: 60,
            label: () => "懒工具箱",
          },
          LazyToolboxSection,
        ),
      );
      // 全局层：进 DSH 就查一次新版本，有新版直接弹（不依赖用户先打开设置页）
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          {
            name: "shell.overlay",
            id: "lazy-toolbox-update",
            inject: () => ({}),
          },
          UpdateDialog,
        ),
      );
    }

    exports.name = "dsh-lazy-toolbox";
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
