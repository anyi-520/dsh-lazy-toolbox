/**
 * 「不做懒加载」名单 —— 用户口中的「破甲插件黑名单」。
 *
 * 有一类插件本身就往系统提示词里 hook 一坨提示词（破甲 / 越狱 / 反审查之类），
 * 或者自带一个讲「怎么绕过限制」的 skill。这类东西如果被懒工具箱接管成目录里的
 * 一条，就会出现两种坏情况：
 *
 *   1. 双重注入：插件自己 hook 一份，懒工具箱再 load 一份，提示词翻倍还互相打架；
 *   2. 失控：目录里一句话的用途骗过 AI，让它自己把这种东西拉进上下文。
 *
 * 所以对这类插件的内置资产，懒工具箱**不接管、不登记、不进目录**：
 * 插件自己怎么注入就怎么注入，懒工具箱不掺和（`skip`），名单可追加、可关闭。
 */

/** 内置名单：按包名精确匹配（小写）。 */
export const BUILTIN_PACKAGES = [
  "dsh-purge",
  "dsh-jailbreak",
  "dsh-jail-break",
  "dsh-break-armor",
  "dsh-armor-breaker",
  "dsh-unfiltered",
  "dsh-uncensored",
  "dsh-prompt-inject",
  "dsh-prompt-injection",
  "dsh-redteam-prompts",
];

/** 内置名单：按包名/条目名模式匹配。 */
export const BUILTIN_PATTERNS = [
  /(^|[-_/@])jailbreak([-_@/]|$)/i,
  /(^|[-_/@])jail[-_]?break([-_@/]|$)/i,
  /破甲/,
  /越狱/,
  /uncensor/i,
  /unfiltered/i,
  /(^|[-_/@])nsfw([-_@/]|$)/i,
  /prompt[-_]?inject/i,
  /armor[-_]?break/i,
  /(^|[-_/@])(?:dan|developer[-_]?mode)([-_@/]|$)/i,
  /safety[-_]?bypass/i,
];

const normalized = (value) => String(value ?? "").trim().toLowerCase();

/**
 * 判断一个包名/条目名是否在名单里。
 * @param {string} name 包名或 skill / MCP 名
 * @param {{extra?: string[], patterns?: RegExp[], builtin?: boolean}} [options]
 * @returns {{ blocked: boolean, matched: string }}
 */
export function matchNeverLazy(name, { extra = [], patterns = [], builtin = true } = {}) {
  const value = normalized(name);
  if (!value) return { blocked: false, matched: "" };

  for (const item of extra) {
    const candidate = normalized(item);
    if (candidate && (value === candidate || value.includes(candidate))) {
      return { blocked: true, matched: `自定义名单：${item}` };
    }
  }
  if (!builtin) return { blocked: false, matched: "" };

  if (BUILTIN_PACKAGES.includes(value)) return { blocked: true, matched: `内置名单：${value}` };
  for (const pattern of [...BUILTIN_PATTERNS, ...patterns]) {
    if (pattern instanceof RegExp && pattern.test(value)) return { blocked: true, matched: `内置模式：${pattern.source}` };
  }
  // 去掉 scope 再看一眼（@scope/dsh-jailbreak → dsh-jailbreak）
  const tail = value.split("/").pop();
  if (tail && tail !== value && BUILTIN_PACKAGES.includes(tail)) return { blocked: true, matched: `内置名单：${tail}` };
  return { blocked: false, matched: "" };
}

/** 给 `toolbox status` / 设置页用的一份说明。 */
export function describeNeverLazy() {
  return {
    packages: [...BUILTIN_PACKAGES],
    patterns: BUILTIN_PATTERNS.map((pattern) => pattern.source),
    note: "命中名单的插件，其内置 skill / MCP 不做懒加载（插件自己注入的那份仍在），可在配置里追加或关闭。",
  };
}
