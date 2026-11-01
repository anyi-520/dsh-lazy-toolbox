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

    function LazyToolboxSection() {
      const [inventory, setInventory] = useState(null);
      const [error, setError] = useState("");
      const [busy, setBusy] = useState("");
      const [update, setUpdate] = useState(null);

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

      return h(
        "section",
        { style: styles.wrap },
        h(UpdateCard, {
          update,
          busy,
          onCheck: () => runUpdate("update.check", "check"),
          onDownload: () => runUpdate("update.download", "download"),
          onInstall: () => runUpdate("update.install", "install"),
        }),
        h(InventoryCard, { inventory, busy, onToggle: toggle, onMode: setMode }),
        error ? h("div", { style: { ...styles.hint, color: "#b4232b" } }, error) : null,
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
    }

    exports.name = "dsh-lazy-toolbox";
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
