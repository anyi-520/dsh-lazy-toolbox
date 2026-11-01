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

    /** 把拖进来的文件读成 base64（不带 data: 前缀），交给宿主解压。 */
    function readFileAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("读文件失败"));
        reader.onload = () => {
          const result = String(reader.result ?? "");
          const comma = result.indexOf(",");
          resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.readAsDataURL(file);
      });
    }

    /** 从拖放事件里挑出第一个 zip。 */
    function pickZipFile(event) {
      const files = event?.dataTransfer?.files ?? event?.target?.files ?? [];
      for (const file of files) {
        if (/\.zip$/i.test(file?.name ?? "")) return file;
      }
      return files[0] ?? null;
    }

    /**
     * 把装好的目录填进官方「添加插件」弹窗的输入框。
     *
     * 官方那个框是受控 React 输入，直接 `input.value = x` 会在下一次渲染被覆盖回去；
     * 走原型链上的原生 value setter 再补一发 input 事件，React 才会认这次改动。
     * 找不到框（弹窗没开）就明说，不硬来。
     */
    function fillOfficialDialog(value) {
      const doc = typeof document === "undefined" ? null : document;
      if (!doc || typeof doc.querySelectorAll !== "function") return { ok: false, reason: "拿不到页面" };
      const inputs = Array.from(doc.querySelectorAll("input"));
      const lookalike = inputs.find((el) => /包名|GitHub|本地目录|whale-pet/i.test(el.placeholder ?? ""));
      const visibleText = inputs.find((el) => (el.type ?? "text") === "text" && el.offsetParent !== null);
      const target = lookalike ?? visibleText;
      if (!target) return { ok: false, reason: "没找到「添加插件」的输入框——先把那个弹窗打开再点" };
      const view = doc.defaultView ?? {};
      const setter = view.HTMLInputElement?.prototype
        ? Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value")?.set
        : null;
      if (typeof setter === "function") setter.call(target, value);
      else target.value = value;
      target.focus?.();
      for (const type of ["input", "change"]) {
        target.dispatchEvent?.(new (view.Event ?? function () {})(type, { bubbles: true }));
      }
      return { ok: true };
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

    /** 「小码酱」的头像：内联 SVG（不占文件、不联网）。和宿主给的那份一致，留着当兜底。 */
    const SELF_AVATAR =
      "data:image/svg+xml;utf8," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">' +
          '<rect width="96" height="96" rx="24" fill="#111827"/>' +
          '<circle cx="48" cy="48" r="30" fill="#1f2937"/>' +
          '<path d="M40 38 L30 48 L40 58" stroke="#7dd3fc" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
          '<path d="M56 38 L66 48 L56 58" stroke="#7dd3fc" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
          '<circle cx="48" cy="70" r="3" fill="#fbbf24"/>' +
        "</svg>",
      );

    /**
     * 安逸的头像：内联图片（base64）。宿主端点 /dsh-lazy-toolbox/avatar/anyi.jpg 是首选，
     * 这里兜住两种没端点的情况——老宿主（服务端还是 0.7.1）和刚装完还没重启。
     */
    const ANYI_AVATAR_FALLBACK = "data:image/jpeg;base64,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";

    /**
     * 「关于」页的内置兜底内容：宿主没给 about（老版本服务端）时也照常显示名单，
     * 不至于出现「制作名单：暂无」。
     */
    const DEFAULT_ABOUT = {
      intro:
        "懒工具箱管的是「上下文预算」。装了一堆 skill、MCP、插件工具之后，光工具定义本身就要吃掉每一轮的 token——不用的也在付钱。\n\n" +
        "它把这些能力从工具定义里搬出去，只在系统提示里留一行「叫什么、干什么用」，需要时由模型自己决定装载进本会话，用完撤掉。装得越多，省得越多。\n\n" +
        "零依赖、零构建，数据全在本机：skill 目录、MCP 配置、日志、备份都在数据目录里，删掉插件目录就能还原。",
      repo: "https://github.com/anyi-520/dsh-lazy-toolbox",
      thanks: [],
      thanksEmpty: "还空着——留给你。谁提过好用的点子、报过坑、帮忙测过，之后都记在这儿。",
      authors: [
        {
          id: "anyi",
          name: "安逸",
          badge: "作者",
          role: "需求、拍板、测试、被折腾的那个",
          avatar: ANYI_AVATAR_FALLBACK,
          link: "https://github.com/anyi-520",
          linkText: "github.com/anyi-520",
        },
        {
          id: "xiaomajiang",
          name: "小码酱",
          badge: "实现",
          role: "写代码、改 bug、被骂了还继续写的那个 AI",
          avatar: "SELF_AVATAR_DATA_URI",
        },
      ],
    };

    /** 把 about 和内置默认值合起来：宿主给了就用宿主的，缺字段就补默认的。 */
    function resolveAbout(about) {
      const base = DEFAULT_ABOUT;
      const authors =
        Array.isArray(about?.authors) && about.authors.length > 0
          ? about.authors
          : base.authors.map((author) =>
              author.id === "anyi" ? { ...author, avatar: about?.avatarFallback ?? ANYI_AVATAR_FALLBACK } : author,
            );
      return {
        ...base,
        ...(about ?? {}),
        authors,
        thanks: Array.isArray(about?.thanks) ? about.thanks : base.thanks,
      };
    }

    /** 名单里的头像地址：给占位符就换成内联的那两张。 */
    function avatarSrc(author) {
      const src = author?.avatar;
      if (!src || src === "ANYI_AVATAR_DATA_URI") return ANYI_AVATAR_FALLBACK;
      if (src === "SELF_AVATAR_DATA_URI") return SELF_AVATAR;
      return src;
    }

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
    function ToolsPanel({ busy, onDiscover, onUnloadAll, editor, update, onCheck, onDownload, onInstall, zip, onImport, onCopyPath, onFillDialog }) {
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
        // 云更新卡片从「关于」挪到这儿：属于运维动作，不属于「关于」。
        h(
          "div",
          { style: { marginTop: 14 } },
          h(UpdateCard, { update, busy, onCheck, onDownload, onInstall }),
        ),
        h(
          "div",
          { style: { marginTop: 14 } },
          h(ZipImportCard, { zip, onImport, onCopyPath, onFillDialog }),
        ),
      );
    }

    /** 制作名单：头像 + 名字 + 角色。头像加载失败就露出底下的首字母，不留破图。 */
    function AuthorCard({ author }) {
      const initial = (author.name ?? "?").slice(0, 1);
      const src = avatarSrc(author);
      return h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 12px",
            borderRadius: 12,
            border: "0.5px solid var(--dsw-alias-border, rgba(0,0,0,.1))",
            background: "var(--dsw-alias-fill-quaternary, rgba(0,0,0,.02))",
          },
        },
        h(
          "div",
          {
            style: {
              position: "relative",
              width: 44,
              height: 44,
              flex: "0 0 auto",
              borderRadius: 44,
              background: "#111",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              overflow: "hidden",
            },
          },
          initial,
          src
            ? h("img", {
                src,
                alt: author.name,
                width: 44,
                height: 44,
                style: {
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: 44,
                  height: 44,
                  objectFit: "cover",
                },
                onError: (event) => {
                  // 图没了就把 img 摘掉，露出底下的首字母（不显示破图图标）
                  try {
                    event?.target?.remove?.();
                  } catch {
                    /* ignore */
                  }
                },
              })
            : null,
        ),
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
            h("span", { style: { fontSize: 14, fontWeight: 600, color: "var(--dsw-alias-label-primary, #111)" } }, author.name),
            author.badge
              ? h(
                  "span",
                  { style: { ...styles.pillBase, color: "var(--dsw-alias-label-tertiary, #888)", fontSize: 11 } },
                  author.badge,
                )
              : null,
          ),
          h(
            "div",
            { style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary, #555)" } },
            author.role,
          ),
          author.link
            ? h(
                "a",
                {
                  href: author.link,
                  target: "_blank",
                  rel: "noreferrer",
                  style: { fontSize: 12, color: "var(--dsw-alias-brand, #2b6cff)", textDecoration: "none" },
                },
                author.linkText ?? author.link,
              )
            : null,
        ),
      );
    }

    /**
     * 「关于」标签：介绍软件 / 感谢名单 / 制作名单。
     * 更新相关（检查更新、云更新卡片）不在这里——名片右上角的「检查更新」和
     * 新版本弹窗管这件事，云更新卡片挪到「工具」标签里。
     */
    function AboutCard({ inventory, update, about }) {
      const version = update?.current ?? inventory?.version ?? "?";
      const data = resolveAbout(about);
      const thanks = data.thanks ?? [];
      const authors = data.authors ?? [];
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 12 } },
        // —— 介绍软件
        h(
          "div",
          { style: styles.card },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 10 } },
            h("h3", { style: styles.title }, "关于懒工具箱"),
            h("span", { style: { ...styles.pillBase, color: COLORS.ok } }, `v${version}`),
          ),
          ...String(data.intro ?? "")
            .split("\n\n")
            .map((paragraph, index) =>
              h(
                "p",
                { key: `intro-${index}`, style: { ...styles.desc, marginTop: index === 0 ? 8 : 0 } },
                paragraph,
              ),
            ),
          h(
            "div",
            { style: { fontSize: 12, lineHeight: "20px", color: "var(--dsw-alias-label-secondary, #555)", marginTop: 4 } },
            h(
              "div",
              {},
              "仓库：",
              h(
                "a",
                {
                  href: about?.repo ?? "https://github.com/anyi-520/dsh-lazy-toolbox",
                  target: "_blank",
                  rel: "noreferrer",
                  style: { color: "var(--dsw-alias-brand, #2b6cff)" },
                },
                about?.repo ?? "https://github.com/anyi-520/dsh-lazy-toolbox",
              ),
            ),
            h("div", {}, `数据目录：${inventory?.dataDir ?? "（见日志）"}`),
            h(
              "div",
              {},
              `当前托管：${inventory?.counts?.groups ?? 0} 组插件工具 / ${inventory?.counts?.skills ?? 0} skill / ${inventory?.counts?.mcp ?? 0} MCP`,
            ),
            about?.avatarDir
              ? h("div", {}, `头像目录：${about.avatarDir}（换掉里面的 anyi.jpg 就换头像，刷新生效）`)
              : null,
          ),
        ),
        // —— 感谢名单
        h(
          "div",
          { style: styles.card },
          h("h3", { style: styles.title }, "感谢名单"),
          thanks.length === 0
            ? h(
                "p",
                { style: { ...styles.desc, fontStyle: "italic" } },
                data.thanksEmpty,
              )
            : h(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: 8 } },
                ...thanks.map((item, index) =>
                  h(
                    "div",
                    { key: `thanks-${index}`, style: { fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-secondary, #555)" } },
                    typeof item === "string" ? item : `${item.name}${item.note ? `：${item.note}` : ""}`,
                  ),
                ),
              ),
        ),
        // —— 制作名单
        h(
          "div",
          { style: styles.card },
          h("h3", { style: styles.title }, "制作名单"),
          h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 10, marginTop: 8 } },
            ...authors.map((author, index) => h(AuthorCard, { key: author.id ?? `author-${index}`, author })),
          ),
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

    /**
     * 插件 zip 导入：不用先解压，压缩包直接拖进来就装。
     * 官方「添加插件」只认目录 / 包名 / 仓库地址，这里是它的补位：zip → 解压 → 校验 → 接线到 profile。
     */
    function ZipImportCard({ zip, onImport, onCopyPath, onFillDialog }) {
      const [hover, setHover] = useState(false);
      const busy = Boolean(zip?.busy);
      const imported = zip?.result ?? null;
      const tone = zip?.error ? "#b4232b" : null;
      return h(
        "div",
        { style: styles.card },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
          h("h3", { style: styles.title }, "导入插件 zip"),
          h("span", { style: { ...styles.pillBase, color: "var(--dsw-alias-label-tertiary, #888)" } }, ".zip 免解压"),
        ),
        h(
          "p",
          { style: styles.desc },
          "把插件压缩包拖到下面（或整个设置页），也可以点「选择 zip」。宿主会在本地解压、校验 package.json 与 dsh.bundle、" +
            "装进数据目录的 plugins/，再把依赖、bundles 与 cordis.patch.yml 的 insert 行一起写进 profile。装完重启 DSH 生效。",
        ),
        h(
          "div",
          {
            "data-role": "zip-drop",
            onDragOver: (event) => {
              event?.preventDefault?.();
              if (!hover) setHover(true);
            },
            onDragLeave: () => setHover(false),
            onDrop: (event) => {
              event?.preventDefault?.();
              setHover(false);
              const file = pickZipFile(event);
              if (file) onImport(file);
            },
            onClick: () => {},
            style: {
              border: `1px dashed ${hover ? "var(--dsw-alias-brand, #2b6cff)" : "var(--dsw-alias-border, rgba(0,0,0,.18))"}`,
              background: hover ? "rgba(43,108,255,.06)" : "var(--dsw-alias-fill-quaternary, rgba(0,0,0,.02))",
              borderRadius: 12,
              padding: "18px 14px",
              textAlign: "center",
              fontSize: 13,
              color: hover ? "var(--dsw-alias-brand, #2b6cff)" : "var(--dsw-alias-label-secondary, #555)",
              transition: "background .12s ease, border-color .12s ease",
            },
          },
          h("div", { style: { fontSize: 22, lineHeight: "26px" } }, "📦"),
          h("div", { style: { marginTop: 4 } }, busy ? `正在导入 ${zip?.name ?? ""}…` : hover ? "松手就开始装" : "拖 .zip 到这里"),
          h(
            "div",
            { style: { fontSize: 11, marginTop: 2, color: "var(--dsw-alias-label-tertiary, #888)" } },
            "只认 .zip；会做 zip-slip 防护与体积上限（5000 条目 / 单文件 64MB / 总计 256MB）",
          ),
        ),
        h(
          "div",
          { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
          h("input", {
            type: "file",
            accept: ".zip,application/zip",
            "data-role": "zip-input",
            disabled: busy,
            style: { display: "none" },
            onChange: (event) => {
              const file = pickZipFile(event);
              if (file) onImport(file);
            },
            id: "lazy-toolbox-zip-input",
          }),
          h(LabeledPick, { busy }),
          imported
            ? h(Btn, { label: "复制安装目录", onClick: () => onCopyPath(imported.dir), disabled: busy })
            : null,
          imported
            ? h(Btn, { label: "填进官方弹窗", onClick: () => onFillDialog(imported.dir), disabled: busy })
            : null,
        ),
        zip?.dialogNote
          ? h("div", { style: styles.hint }, zip.dialogNote)
          : null,
        zip?.error ? h("div", { style: { ...styles.hint, color: tone } }, `没装成：${zip.error}`) : null,
        imported
          ? h(
              "div",
              { style: { fontSize: 12, lineHeight: "20px", color: "var(--dsw-alias-label-secondary, #555)" } },
              h("div", { style: { color: COLORS.ok, fontWeight: 500 } }, `已装 ${imported.name}@${imported.version}`),
              h("div", {}, `目录：${imported.dir}`),
              h("div", {}, `文件：${imported.files} 个 / ${Math.round((imported.bytes ?? 0) / 1024)} KB｜组合包：${imported.hasBundle ? "有" : "没有"}`),
              ...(imported.profiles ?? []).map((item, index) =>
                h(
                  "div",
                  { key: `zip-prof-${index}` },
                  `profile ${item.profileDir}：依赖${item.dependency?.wrote ? "已写" : "未变"} / 链接${item.link?.ok ? (item.link.wrote ? "已建" : "已有") : `失败（${item.link?.reason}）`} / patch${item.patch?.wrote ? "已加" : item.patch?.skipped ? `跳过（${item.patch.skipped}）` : "未变"}`,
                ),
              ),
              h("div", { style: { marginTop: 4, color: "var(--dsw-alias-label-primary, #111)" } }, imported.hint ?? "重启 DSH 生效。"),
            )
          : null,
        zip?.preview
          ? h(
              "div",
              { style: styles.hint },
              `看得见：${zip.preview.entries} 个条目 / ${zip.preview.files} 个文件，清单在 ${zip.preview.manifestPath}`,
            )
          : null,
      );
    }

    /** 包一层「选择 zip」按钮：点它去触发隐藏的文件框。 */
    function LabeledPick({ busy }) {
      return h(
        "label",
        {
          for: "lazy-toolbox-zip-input",
          "data-role": "zip-pick",
          style: {
            fontSize: 12,
            lineHeight: "20px",
            padding: "4px 12px",
            borderRadius: 999,
            border: "0.5px solid var(--dsw-alias-border, rgba(0,0,0,.18))",
            background: "var(--dsw-alias-fill-quaternary, rgba(0,0,0,.03))",
            color: "var(--dsw-alias-label-primary, #111)",
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.5 : 1,
          },
        },
        busy ? "导入中…" : "选择 zip",
      );
    }

    function LazyToolboxSection() {
      const [inventory, setInventory] = useState(null);
      const [error, setError] = useState("");
      const [busy, setBusy] = useState("");
      const [update, setUpdate] = useState(null);
      const [about, setAbout] = useState(null);
      const [zipState, setZipState] = useState(null);
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
        if (data.about) setAbout(data.about);
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

      /** zip 导入：拖或选，直接把压缩包交给宿主解压安装。 */
      const importZip = async (file) => {
        if (!file) return;
        if (!/\.zip$/i.test(file.name ?? "")) {
          setZipState({ error: `只认 .zip，这个是 ${file.name ?? "（没名字）"}` });
          return;
        }
        setTab("tool");
        setZipState({ busy: true, name: file.name });
        try {
          const base64 = await readFileAsBase64(file);
          const data = await callApi({ op: "plugin.import", zip: base64, filename: file.name });
          if (data.ok === false) throw new Error(data.error ?? "宿主拒绝了这次导入");
          setZipState({ result: data.imported, name: file.name });
          if (data.inventory) ingest(data);
        } catch (err) {
          setZipState({ error: String(err && err.message ? err.message : err), name: file.name });
        }
      };

      const copyPath = async (value) => {
        try {
          await navigator?.clipboard?.writeText?.(String(value ?? ""));
          setZipState((previous) => ({ ...(previous ?? {}), copied: true }));
        } catch {
          /* 复制不了就算了，路径已经显示在卡片里 */
        }
      };

      const fillDialog = (dir) => {
        const outcome = fillOfficialDialog(String(dir ?? ""));
        setZipState((previous) => ({
          ...(previous ?? {}),
          dialogNote: outcome.ok
            ? "已经填进官方「添加插件」的输入框了：确认一眼，点它的「安装」。"
            : `没填成：${outcome.reason}`,
        }));
      };

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
        {
          style: styles.wrap,
          // 整个设置页都能接：把 zip 拖到窗口任意位置就装（别处不拦，只有 .zip 才接）
          onDragOver: (event) => {
            const types = event?.dataTransfer?.types;
            const hasZip = !types || Array.prototype.indexOf.call(types, "Files") >= 0;
            if (!hasZip) return;
            event?.preventDefault?.();
          },
          onDrop: (event) => {
            const file = pickZipFile(event);
            if (!file) return;
            event?.preventDefault?.();
            importZip(file);
          },
        },
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
              update,
              onCheck: () => runUpdate("update.check", "check"),
              onDownload: () => runUpdate("update.download", "download"),
              onInstall: () => runUpdate("update.install", "install"),
              zip: zipState,
              onImport: importZip,
              onCopyPath: copyPath,
              onFillDialog: fillDialog,
            })
          : null,
        tab === "about" ? h(AboutCard, { inventory, update, about }) : null,
        error ? h("div", { style: { ...styles.hint, color: "#b4232b" } }, error) : null,
        showPrompt
          ? h(UpdatePrompt, {
              update,
              busy,
              inline: true,
              onSnooze: snooze,
              onUpdate: async () => {
                setTab("tool");
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
