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

    /**
     * skill 与 MCP 的开关面板：这份清单和 AI 的 toolbox action=list 同源（store.json），
     * 关掉的条目会从系统提示的目录里消失，也不再允许 load。
     */
    function InventoryCard({ inventory, busy, onToggle }) {
      const skills = inventory?.skills ?? [];
      const mcp = inventory?.mcp ?? [];
      const counts = inventory?.counts ?? { skills: 0, mcp: 0, skillsOn: 0, mcpOn: 0 };

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
                      : h("span", { style: styles.hint }, row.source || ""),
                    h(Switch, {
                      checked: row.enabled,
                      disabled: busy !== "",
                      onChange: (next) => onToggle(row.id, next),
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
          h("h3", { style: styles.title }, "skill 与 MCP 开关"),
          h(
            "span",
            { style: { ...styles.pillBase, color: counts.skillsOn + counts.mcpOn > 0 ? COLORS.ok : COLORS.off } },
            `开着 ${counts.skillsOn} skill / ${counts.mcpOn} MCP`,
          ),
        ),
        h(
          "p",
          { style: styles.desc },
          "关掉不等于卸载：文件、配置都在，只是不再出现在系统提示的目录里，AI 也不能 load。想省 token 就先关掉暂时用不到的。",
        ),
        group("skills", `${counts.skills} 个`, skills, "skill"),
        group("mcp", `${counts.mcp} 个`, mcp, "mcp"),
      );
    }

    function LazyToolboxSection() {
      const [inventory, setInventory] = useState(null);
      const [error, setError] = useState("");
      const [busy, setBusy] = useState("");

      const ingest = useCallback((data) => {
        if (!data || data.ok === false) {
          setError(data?.error || "宿主没有返回数据");
          return;
        }
        setInventory(data.inventory ?? null);
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
        h(InventoryCard, { inventory, busy, onToggle: toggle }),
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
