/**
 * skill 的「目录页」：把一个几万 token 的 SKILL.md 拆成骨架 + 每节一句话。
 *
 * 为什么：skill 正文动辄两三万字（3 万 token 级），全部注入进对话是浪费——
 * 大部分回合只用得到其中一两节。所以 load 时只给 AI 一份**大纲**（标题 + 每节一句话），
 * 它判断要哪节，再用 `toolbox { action: "skill", section: "2.1" }` 把那节原文拉下来。
 *
 * 纯函数，不碰文件系统（方便测试）。
 */

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^\s*(```|~~~)/;
/** 标题里自带的序号（"1 立项" / "2.1. 分镜"），显示时去掉，编号由大纲自己算。 */
const ORDINAL = /^\d+(?:[.．]\d+)*[.)、:：]?[ \t]+/;

/** 去掉常见 markdown 行内标记，留下纯文本（用于生成「一句话」）。 */
export function plain(text) {
  return String(text ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** 一行里的第一个句子（中文句号、英文句点、分号、破折号都算断句）。 */
export function firstSentence(text, limit = 120) {
  const clean = plain(text);
  if (!clean) return "";
  const cut = clean.split(/(?<=[。！？；!?;])\s*|(?<=[.．])\s+|\s+—+\s+/)[0] ?? clean;
  const sentence = (cut || clean).trim();
  return sentence.length > limit ? `${sentence.slice(0, limit - 1)}…` : sentence;
}

/** 找出某段正文的第一句「有信息量」的话，跳过代码块与纯标题。 */
function gistOf(lines, from, to) {
  let insideFence = false;
  const buffer = [];
  for (let index = from; index < to; index += 1) {
    const line = lines[index];
    if (FENCE.test(line)) {
      insideFence = !insideFence;
      if (buffer.length > 0) break;
      continue;
    }
    if (insideFence) continue;
    const trimmed = line.trim();
    if (!trimmed) {
      if (buffer.length > 0) break;
      continue;
    }
    if (HEADING.test(trimmed)) break;
    if (/^(\||=|-\s*$)/.test(trimmed)) continue; // 表格、分隔线
    if (/^<!--/.test(trimmed)) continue;
    buffer.push(trimmed);
    if (buffer.join(" ").length >= 160) break;
  }
  return firstSentence(buffer.join(" "), 140);
}

/**
 * 解析大纲。
 * @param {string} markdown SKILL.md 原文
 * @returns {{ title, preamble, totalChars, totalLines, branches: object[], _marks }}
 *   branches 每项：{ id, level, title, gist, chars, lines, start, end }
 */
export function buildOutline(markdown) {
  const text = String(markdown ?? "");
  const lines = text.split(/\r?\n/);
  const offsets = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  let bodyStart = 0;
  if (lines[0]?.trim() === "---") {
    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index].trim() === "---") {
        bodyStart = index + 1;
        break;
      }
    }
  }

  const headings = [];
  let insideFence = false;
  for (let index = bodyStart; index < lines.length; index += 1) {
    const line = lines[index];
    if (FENCE.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;
    const matched = HEADING.exec(line);
    if (!matched) continue;
    const cleaned = plain(matched[2]).replace(ORDINAL, "").trim();
    headings.push({ line: index, level: matched[1].length, title: cleaned || plain(matched[2]) });
  }

  const branches = [];
  const counters = [];
  const marks = [];
  const preambleEnd = headings.length > 0 ? offsets[headings[0].line] : text.length;
  const preamble = firstSentence(text.slice(offsets[bodyStart] ?? 0, preambleEnd), 200);

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    // 层级计数：1.2.3
    counters[heading.level - 1] = (counters[heading.level - 1] ?? 0) + 1;
    for (let depth = heading.level; depth < counters.length; depth += 1) counters[depth] = 0;
    const id = counters.slice(0, heading.level).filter((value) => value > 0).join(".");

    let endLine = lines.length;
    for (let next = index + 1; next < headings.length; next += 1) {
      if (headings[next].level <= heading.level) {
        endLine = headings[next].line;
        break;
      }
    }
    const start = offsets[heading.line];
    const end = endLine < lines.length ? offsets[endLine] : text.length;
    const slice = text.slice(start, end);
    branches.push({
      id: id || `${index + 1}`,
      level: heading.level,
      title: heading.title,
      gist: gistOf(lines, heading.line + 1, endLine),
      chars: slice.length,
      lines: endLine - heading.line,
      start,
      end,
    });
    marks.push({ id: id || `${index + 1}`, start, end });
  }

  return {
    title: branches[0]?.title ?? plain(lines[0] ?? ""),
    preamble,
    totalChars: text.length,
    totalLines: lines.length,
    branches,
    _marks: marks,
    _text: text,
  };
}

/** 粗略 token 估算：中文约 1.5 字/token，英文约 4 字符/token，取折中。 */
export function estimateTokens(chars) {
  return Math.round(Number(chars || 0) / 2.6);
}

/** 大纲渲染成给 AI 看的文本。 */
export function renderOutline(name, summary, outline, { resourceDir = "", loaded = false } = {}) {
  const rows = [];
  rows.push(`# skill:${name} — ${summary || outline.title || "（没有说明）"}`);
  rows.push(
    `（当前按「大纲模式」加载：这里只有骨架，正文共 ${outline.totalLines} 行 / ${outline.totalChars} 字符 ≈ ${estimateTokens(outline.totalChars)} token，没有整篇塞进上下文。）`,
  );
  if (outline.preamble) rows.push("", `> ${outline.preamble}`);
  const branches = outline.branches.slice(0, 200);
  if (branches.length > 0) {
    rows.push("", "## 分支（每节一句话）");
    for (const branch of branches) {
      const indent = "  ".repeat(Math.max(0, branch.level - 1));
      const gist = branch.gist ? ` — ${branch.gist}` : "";
      rows.push(`- ${indent}${branch.id} ${branch.title}${gist}`);
    }
    if (outline.branches.length > branches.length) rows.push(`- …（还有 ${outline.branches.length - branches.length} 节，见完整大纲）`);
    rows.push(
      "",
      "## 要看全文怎么取",
      `- 某一节：\`toolbox { action: "skill", id: "skill:${name}", section: "${branches[0].id}" }\``,
      `- 整篇（慎用，会把全部正文拉进上下文）：\`toolbox { action: "skill", id: "skill:${name}", section: "all" }\``,
      `- 只要大纲（默认）：不要 section 参数即可`,
    );
  } else {
    // 没有标题的 skill：直接给开头一段，别让 AI 抓瞎
    rows.push("", "（这个 skill 没有分节标题，下面是开头部分；要全文用 section: \"all\"）", "", outline._text.slice(0, 1200));
  }
  if (resourceDir) rows.push("", `资源目录（附属文件都在这里，需要时用 shell 读）：${resourceDir}`);
  rows.push("", loaded ? "（用完记得 `toolbox { action: \"unload\", all: true }`）" : "");
  return rows.filter((line) => line !== undefined).join("\n").trimEnd();
}

/**
 * 取某一节（或整篇）。
 * @param {string} markdown 原文
 * @param {string} id 分支 id（"2" / "2.1"），或 "all" 整篇，"*"/"" 大纲
 */
export function readSection(markdown, id) {
  const text = String(markdown ?? "");
  const outline = buildOutline(text);
  const wanted = String(id ?? "").trim();
  if (!wanted || wanted === "*" || wanted === "outline") return { kind: "outline", outline };
  if (wanted === "all" || wanted === "full" || wanted === "全文") return { kind: "all", text, outline };
  if (wanted === "0" || wanted === "preamble") {
    const end = outline._marks[0]?.start ?? text.length;
    return { kind: "section", id: "0", title: "开头（第一个标题之前）", text: text.slice(0, end), outline };
  }
  const exact = outline.branches.find((branch) => branch.id === wanted);
  if (exact) return { kind: "section", id: exact.id, title: exact.title, text: text.slice(exact.start, exact.end), outline };
  // 允许用标题片段查（大小写不敏感）
  const lower = wanted.toLowerCase();
  const fuzzy = outline.branches.find((branch) => branch.title.toLowerCase().includes(lower));
  if (fuzzy) return { kind: "section", id: fuzzy.id, title: fuzzy.title, text: text.slice(fuzzy.start, fuzzy.end), outline };
  return { kind: "missing", wanted, outline, available: outline.branches.map((branch) => `${branch.id} ${branch.title}`) };
}
