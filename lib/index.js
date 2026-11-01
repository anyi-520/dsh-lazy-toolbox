/**
 * dsh-lazy-toolbox —— 把 skill 与 MCP 从「默认工具定义」改成「按需热加载」。
 *
 * 工作方式：
 *   1. 安装后把用户级 skill 目录与 profile 里的 mcp-client 条目搬进插件库；
 *      DSH 因此不再把它们的定义塞进每个对话的 tool 列表。
 *   2. 系统提示里只留一份目录（skill / mcp 分开，每条一句话用途）。
 *   3. 模型调用 `toolbox`（action=load）时，把对应定义注册进**当前 agent 的
 *      作用域**——只影响这个会话；action=unload 立刻撤掉。
 *   4. AI 之后往标准目录写的新 skill、以及新加的 mcp-client 行，会被自动搬进来。
 *   5. 设置 → 「懒工具箱」里能看到全部 skill 与 MCP，并逐个开关（关掉 = 不进
 *      目录、不能 load，文件与配置都保留）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dshHome, agentsHome, errorMessage, oneLine, readText, exists } from "./util.js";
import { Store } from "./store.js";
import { McpManager } from "./mcp.js";
import { Injector, catalogLines, catalogGroupLines } from "./inject.js";
import { listToolGroups } from "./tool-groups.js";
import { toolboxToolDefinition, inventoryForUi, setEnabledById } from "./tools.js";
import { PluginLog, nullLog } from "./log.js";
import {
  autoImportSkills,
  migrateMcpFromProfiles,
  migrateSkillsFromRoots,
} from "./migrate.js";
import { listProfiles, isProfileDir } from "./profile.js";
import { skillRoots } from "./skills.js";
import { discoverPluginAssets } from "./discover.js";
import { UpdateManager } from "./update.js";
import { readCode, revertCode, validateCode, writeCode } from "./editor.js";
import { importPluginZip, previewPluginZip } from "./importer.js";

export const name = "lazy-toolbox";
export const inject = ["systemPrompt", "tools", "webServer"];

/** 插件版本：写进日志首行，排查「哪个版本出的问题」用。 */
const PLUGIN_VERSION = (() => {
  try {
    return createRequire(import.meta.url)("../package.json").version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** 「关于」页的静态内容：介绍软件 / 感谢名单 / 制作名单。 */
const ABOUT_INTRO = [
  "懒工具箱管的是「上下文预算」。装了一堆 skill、MCP、插件工具之后，光工具定义本身就要吃掉每一轮的 token——不用的也在付钱。",
  "它把这些能力从工具定义里搬出去，只在系统提示里留一行「叫什么、干什么用」，需要时由模型自己决定装载进本会话，用完撤掉。装得越多，省得越多。",
  "零依赖、零构建，数据全在本机：skill 目录、MCP 配置、日志、备份都在数据目录里，删掉插件目录就能还原。",
].join("\n\n");

/** 「小码酱」的头像：内联 SVG（不占文件、不联网）。 */
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

/** 制作名单：安逸（人）+ 小码酱（写代码的 AI）。感谢名单暂时空着，先留位置。 */
function aboutPayload(store) {
  return {
    intro: ABOUT_INTRO,
    repo: "https://github.com/anyi-520/dsh-lazy-toolbox",
    thanks: [],
    thanksEmpty: "还空着——留给你。谁提过好用的点子、报过坑、帮忙测过，之后都记在这儿。",
    authors: [
      {
        id: "anyi",
        name: "安逸",
        badge: "作者",
        role: "需求、拍板、测试、被折腾的那个",
        avatar: "/dsh-lazy-toolbox/avatar/anyi.jpg",
        link: "https://github.com/anyi-520",
        linkText: "github.com/anyi-520",
      },
      {
        id: "xiaomajiang",
        name: "小码酱",
        badge: "实现",
        role: "写代码、改 bug、被骂了还继续写的那个 AI",
        avatar: SELF_AVATAR,
      },
    ],
    avatarDir: path.join(store.root, "assets", "avatars"),
  };
}

const DEFAULTS = {
  dataDir: "",
  autoMigrate: true,
  autoImport: true,
  autoImportProjectSkills: false,
  scanIntervalMs: 5000,
  autoUnloadOnTurnEnd: true,
  mcpIdleMs: 60000,
  maxCatalogItems: 200,
  autoDetectPluginAssets: true,
  /** skill 注入方式："index"（默认，只给大纲 + 按需取节）| "full"（整篇注入） */
  skillInjectMode: "index",
  /** 单节正文回传上限（字符），防止一次把上下文灌爆 */
  skillSectionMaxChars: 60000,
  /** 「不做懒加载」名单：true=内置名单生效；extra 额外追加包名 */
  /** 云更新：仓库地址（owner/repo）、启动时检查、间隔小时数 */
  updateRepo: "anyi-520/dsh-lazy-toolbox",
  updateCheck: true,
  updateCheckHours: 6,
  neverLazyBuiltin: true,
  neverLazyExtra: [],
  logEnabled: true,
  logDir: "",
  logLevel: "info",
  logMaxBytes: 2 * 1024 * 1024,
  logRetentionDays: 14,
};

function normalizeConfig(raw) {
  const config = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  config.scanIntervalMs = Math.max(500, number(config.scanIntervalMs, DEFAULTS.scanIntervalMs));
  config.mcpIdleMs = Math.max(0, number(config.mcpIdleMs, DEFAULTS.mcpIdleMs));
  config.maxCatalogItems = Math.max(10, number(config.maxCatalogItems, DEFAULTS.maxCatalogItems));
  config.autoMigrate = config.autoMigrate !== false;
  config.autoImport = config.autoImport !== false;
  config.autoImportProjectSkills = config.autoImportProjectSkills === true;
  config.autoDetectPluginAssets = config.autoDetectPluginAssets !== false;
  config.skillInjectMode = config.skillInjectMode === "full" ? "full" : "index";
  config.updateRepo = String(config.updateRepo ?? DEFAULTS.updateRepo).trim() || DEFAULTS.updateRepo;
  config.updateCheck = config.updateCheck !== false;
  config.updateCheckHours = Number.isFinite(Number(config.updateCheckHours)) && Number(config.updateCheckHours) > 0 ? Number(config.updateCheckHours) : 6;
  config.neverLazyBuiltin = config.neverLazyBuiltin !== false;
  config.neverLazyExtra = Array.isArray(config.neverLazyExtra) ? config.neverLazyExtra.map(String) : [];
  config.autoUnloadOnTurnEnd = config.autoUnloadOnTurnEnd !== false;
  config.dataDir = config.dataDir ? path.resolve(String(config.dataDir)) : "";
  config.logEnabled = config.logEnabled !== false;
  config.logLevel = ["debug", "info", "warn", "error"].includes(String(config.logLevel)) ? String(config.logLevel) : "info";
  config.logMaxBytes = Math.max(64 * 1024, number(config.logMaxBytes, DEFAULTS.logMaxBytes));
  config.logRetentionDays = Math.max(0, number(config.logRetentionDays, DEFAULTS.logRetentionDays));
  config.logDir = config.logDir ? path.resolve(String(config.logDir)) : "";
  return config;
}

export function apply(ctx, rawConfig = {}) {
  const startedAt = Date.now();
  const config = normalizeConfig(rawConfig);
  const logger = ctx.logger ?? console;
  const store = new Store(config.dataDir || undefined);
  const log = config.logEnabled
    ? new PluginLog({
        dir: config.logDir || path.join(store.root, "logs"),
        enabled: true,
        level: config.logLevel,
        maxBytes: config.logMaxBytes,
        retentionDays: config.logRetentionDays,
      })
    : nullLog;
  const mcp = new McpManager({ store, logger, idleMs: config.mcpIdleMs, log });
  const injector = new Injector({ store, mcp, logger, skillInjectMode: config.skillInjectMode });
  const updater = new UpdateManager({
    root: store.root,
    config,
    currentVersion: PLUGIN_VERSION,
    log,
    logger,
  });

  const runtime = {
    ctx,
    config,
    store,
    mcp,
    injector,
    updater,
    logger,
    log,
    /** 插件安装目录：设置页「来源信息」里显示，和插件管理页的 link: 一致。 */
    installDir: (() => {
      try {
        return fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]+$/, "");
      } catch {
        return "";
      }
    })(),
    /** 插件资产扫描的指纹缓存（内容没变就不重复扫）。 */
    discoverState: { signature: "" },
    /** 当前会话的工作目录（给 add_skill 解析相对路径）。 */
    async workingDirectoryFor(exec) {
      const service = typeof ctx.get === "function" ? ctx.get("workingDirectory") : undefined;
      if (service && typeof service.ensure === "function" && exec?.agent) {
        try {
          const dir = await service.ensure(exec.agent, exec.signal);
          if (typeof dir === "string" && dir) return dir;
        } catch {
          /* fall through */
        }
      }
      return process.cwd();
    },
  };

  log.record("info", "plugin.start", {
    version: PLUGIN_VERSION,
    dataDir: store.root,
    logFile: log.file || "",
    config: {
      autoMigrate: config.autoMigrate,
      autoImport: config.autoImport,
      autoUnloadOnTurnEnd: config.autoUnloadOnTurnEnd,
      mcpIdleMs: config.mcpIdleMs,
      logLevel: config.logLevel,
      logRetentionDays: config.logRetentionDays,
    },
  });

  // 常驻工具（唯一一个默认就在工具列表里的东西）
  ctx.tools.register(toolboxToolDefinition(runtime));

  // 目录：只列一句话用途，不含调用方式
  ctx.systemPrompt.section({
    name: "toolbox:catalog",
    order: ctx.systemPrompt.getSectionOrder("MCP_SERVERS") + 1,
    interpolate: false,
    text: (context) => renderCatalog(runtime, context?.scope),
  });

  // 每轮运行时上下文里的提示：本会话还没加载任何东西时提醒「这些能力不在工具列表里」。
  // 加载之后自动消失，不占常驻 token。
  ctx.systemPrompt.context({
    name: "toolbox:hint",
    order: ctx.systemPrompt.getSectionOrder("MCP_SERVERS") + 1,
    interpolate: false,
    text: (context) => renderHint(runtime, context?.scope),
  });

  // 首次安装迁移
  if (config.autoMigrate) {
    try {
      runMigration(runtime);
    } catch (error) {
      logger.warn?.(`lazy-toolbox: 迁移失败：${errorMessage(error)}`);
    }
  }

  // 插件内置资产（skill / MCP）自动接管：装了带 skill 或 mcp.json 的插件就能直接用
  if (config.autoDetectPluginAssets) {
    try {
      const result = discoverPluginAssets({
        store,
        profiles: listProfiles(dshHome()).filter((dir) => isProfileDir(dir)),
        dshHome: dshHome(),
        log,
        state: runtime.discoverState,
        neverLazy: { builtin: config.neverLazyBuiltin, extra: config.neverLazyExtra },
      });
      const added = result.skills.length + result.servers.length;
      if (added > 0) logger.info?.(`lazy-toolbox: 接管了 ${result.skills.length} 个插件内置 skill、${result.servers.length} 个 MCP 服务`);
      if (result.blocked.length > 0) {
        logger.info?.(`lazy-toolbox: 名单里的插件跳过了 ${result.blocked.length} 个（${result.blocked.map((item) => item.plugin).join(", ")}）`);
        log.info("discover.blocked", { count: result.blocked.length, plugins: result.blocked.map((item) => item.plugin) });
      }
    } catch (error) {
      logger.warn?.(`lazy-toolbox: 插件资产扫描失败：${errorMessage(error)}`);
      log.warn("discover.failed", { error });
    }
  }

  // 云更新：启动时先给出缓存结果，随后（延迟）在后台查一次，不阻塞启动
  if (config.updateCheck) {
    const cached = updater.status();
    if (cached.installed?.restartRequired) {
      logger.info?.(`lazy-toolbox: 已安装 ${cached.installed.version}，重启 DSH 生效`);
    }
    const due = !cached.checkedAt || Date.now() - new Date(cached.checkedAt).getTime() > config.updateCheckHours * 3600 * 1000;
    if (due) {
      const timer = setTimeout(() => {
        updater.check({ force: true }).then((status) => {
          if (status.hasUpdate) logger.info?.(`lazy-toolbox: 有新版本 ${status.latest}（当前 ${status.current}），设置 → 懒工具箱 里可下载`);
        }).catch(() => {});
      }, 4000);
      if (typeof timer.unref === "function") timer.unref();
    }
  }

  // 自动导入：AI 下载 skill / 新加 mcp 行之后自动搬进来
  let lastScan = 0;
  let scanning = false;
  const scan = () => {
    if (!config.autoImport && !config.autoDetectPluginAssets) return;
    if (scanning) return;
    const now = Date.now();
    if (now - lastScan < config.scanIntervalMs) return;
    lastScan = now;
    scanning = true;
    try {
      if (config.autoImport) scanOnce(runtime);
      if (config.autoDetectPluginAssets) scanPluginAssets(runtime);
    } catch (error) {
      logger.warn?.(`lazy-toolbox: 自动导入失败：${errorMessage(error)}`);
      log.warn("scan.failed", { error });
    } finally {
      scanning = false;
    }
  };
  ctx.on("agent/pre-step", async (payload, next) => {
    // 记下最近活跃的 agent：设置页的「工具」标签要能注销本会话注入的定义
    const active = payload?.agent ?? payload?.scope?.agent ?? null;
    if (active) runtime.lastAgent = active;
    scan();
    return next();
  });

  // 回合结束后自动卸载（默认开启：把工具定义还回去，减少下一轮的请求体积）
  ctx.on("session/event", (session, event) => {
    if (!config.autoUnloadOnTurnEnd) return;
    if (event?.type !== "turn/end") return;
    const sessionId = session?.id;
    if (sessionId) injector.unloadAllForSession(sessionId);
  });

  ctx.on("agent/disposed", ({ agent }) => {
    try {
      injector.unload(agent, "all");
    } catch {
      /* ignore */
    }
  });

  ctx.effect(() => () => {
    try {
      injector.unloadAll();
    } catch {
      /* ignore */
    }
    void mcp.closeAll();
    log.info("plugin.stop", { uptimeMs: Date.now() - startedAt });
  }, "lazy-toolbox.dispose");

  // ---- 设置页端点：skill / MCP 的开关清单 ----
  // 设置页和 AI（toolbox action=list / enable / disable）读的是同一份事实，
  // 所以只注册一个 HTTP 端点，两边都走它。
  // （外部工具链面板已经从本插件拆成独立插件 dsh-toolchain。）
  if (ctx.webServer && typeof ctx.webServer.register === "function") {
    ctx.effect(() => {
      const dispose = ctx.webServer.register(
        { kind: "exact", path: "/dsh-lazy-toolbox/api", handler: (request, response) => handleInventoryApi(runtime, request, response) },
        "lazy-toolbox: inventory api",
      );
      // 制作名单的头像：只读数据目录里的 assets/avatars/*，白名单后真实读取
      let disposeAvatar = () => {};
      try {
        disposeAvatar = ctx.webServer.register(
          { kind: "prefix", path: "/dsh-lazy-toolbox/avatar", handler: (request, response) => handleAvatar(runtime, request, response) },
          "lazy-toolbox: author avatars",
        );
      } catch (error) {
        logger.warn?.(`lazy-toolbox: 头像路由注册失败（${errorMessage(error)}），关于页会退回首字母方块`);
      }
      return () => {
        try {
          if (typeof dispose === "function") dispose();
        } catch {
          /* ignore */
        }
        try {
          if (typeof disposeAvatar === "function") disposeAvatar();
        } catch {
          /* ignore */
        }
      };
    }, "lazy-toolbox: http routes");
  } else {
    logger.warn?.("lazy-toolbox: webServer 不可用，设置页的开关面板拿不到数据");
  }

  logger.info?.(`lazy-toolbox: 已启用（数据目录 ${store.root}）`);
}

function renderCatalog(runtime, agent) {
  const store = runtime.store;
  const skills = store.listSkills();
  const servers = store.listServers();
  const groups = listToolGroups();
  if (skills.length === 0 && servers.length === 0 && groups.length === 0) return "";
  const lines = catalogLines({ store, mcp: runtime.mcp, agent, injector: runtime.injector });
  const groupLines = catalogGroupLines({ store, agent, injector: runtime.injector });
  const cap = runtime.config.maxCatalogItems;
  const trimmed = lines.length > cap ? [...lines.slice(0, cap), `- …还有 ${lines.length - cap} 项未显示`] : lines;
  const sections = [];
  if (trimmed.length > 0) {
    sections.push("### skill / MCP", ...trimmed);
  }
  if (groupLines.length > 0) {
    sections.push("", "### 插件工具（别的插件交出来托管的）", ...groupLines);
  }
  return [
    "## 懒工具箱（skill / MCP / 插件工具按需加载）",
    "下面这些能力**已经安装但不在当前工具列表里**（所以你看不到它们的参数）。需要时调用 `toolbox`：",
    "- `toolbox { action: \"load\", ids: [\"skill:<名字>\" 或 \"mcp:<服务>\" 或 \"mcp:<服务>:<工具>\" 或 \"group:<插件组>\" 或 \"group:<插件组>:<工具>\"] }`；",
    "- `toolbox { action: \"unload\", ids: [...] }`（或 `all: true`）把定义撤掉，减少后续请求体积；",
    "- `toolbox { action: \"list\", ids: [...] }` 展开某个 MCP 服务 / 插件组的工具清单；",
    "- 用户要求安装新的 skill / MCP 时用 `action: \"add_skill\" / \"add_mcp\"`，并给一句话 `summary`。",
    "",
    ...sections,
  ].join("\n");
}

/**
 * 运行时上下文提示：新会话一开始就告诉模型「装了懒工具箱、能力不在工具列表里」。
 * 本会话已经加载过东西、或库里没有任何启用的条目时不输出。
 */
function renderHint(runtime, agent) {
  const disabled = runtime.store.listDisabled();
  const skills = runtime.store.listSkills().filter((skill) => !disabled.skills.includes(skill.name)).length;
  const servers = runtime.store.listServers().filter((server) => !disabled.mcp.includes(server.name)).length;
  const groups = listToolGroups().filter((group) => !disabled.groups.includes(group.id)).length;
  if (skills === 0 && servers === 0 && groups === 0) return "";
  const key = runtime.injector.resolveAgent(agent);
  let loaded = [];
  try {
    loaded = key ? runtime.injector.loaded(key) : [];
  } catch {
    loaded = [];
  }
  if (loaded.length > 0) return "";
  return [
    `懒工具箱：本机还装了 ${skills} 个 skill、${servers} 个 MCP 服务` +
    (groups > 0 ? `、${groups} 组插件工具` : "") +
    `，它们**不在工具定义里**，`,
    `详情见系统提示里的目录（每条一句话用途）。只要当前任务和某条用途对得上，`,
    `先调用 \`toolbox { action: "load", ids: ["skill:<名字>"] }\`（MCP 用 "mcp:<服务>"、插件工具用 "group:<组名>"）把定义注入本会话，再动手；`,
    `不要因为工具列表里没有、就跳过它或凭记忆作答。用完用 \`toolbox { action: "unload", ... }\` 撤掉。`,
  ].join("");
}

// ------------------------------------------------------------ 设置页 HTTP API

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(body);
}

async function readJsonBody(request, options = {}) {
  const maxBytes = Number(options.maxBytes ?? 1_000_000);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`请求体过大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）`);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

/** 头像白名单：只认图片后缀，路径只取 basename，越不出 assets/avatars。 */
const AVATAR_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function handleAvatar(runtime, request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  let name = "";
  try {
    name = path.basename(decodeURIComponent(url.pathname));
  } catch {
    name = "";
  }
  const ext = path.extname(name).toLowerCase();
  const dir = path.join(runtime.store.root, "assets", "avatars");
  const file = path.join(dir, name);
  if (!name || !AVATAR_TYPES[ext] || !file.startsWith(dir) || !exists(file)) {
    response.statusCode = 404;
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.end("avatar not found");
    return;
  }
  try {
    const bytes = fs.readFileSync(file);
    response.statusCode = 200;
    response.setHeader("content-type", AVATAR_TYPES[ext]);
    response.setHeader("content-length", String(bytes.length));
    response.setHeader("cache-control", "public, max-age=300");
    response.end(bytes);
  } catch {
    response.statusCode = 500;
    response.end("avatar read failed");
  }
}

/**
 * 设置页用的端点：GET 清单 / POST 开关。
 * 写操作只落到 store.json（skill / mcp 的开关状态），不碰 DSH 自己的配置。
 * 外部工具链（JDK / Ghidra / JADX / IDA）已经拆到独立插件 dsh-toolchain，
 * 这里不再有 requirements 相关的 op。
 */
async function handleInventoryApi(runtime, request, response) {
  const payload = () => ({
    ok: true,
    inventory: inventoryForUi(runtime),
    version: PLUGIN_VERSION,
    update: runtime.updater?.status() ?? null,
    about: aboutPayload(runtime.store),
  });
  const log = runtime.log;
  const started = Date.now();
  let op = "";
  try {
    if (request.method === "GET") {
      sendJson(response, 200, payload());
      log?.info?.("api.request", { method: "GET", status: 200, ms: Date.now() - started });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: "method not allowed" });
      log?.warn?.("api.request", { method: request.method ?? "", status: 405, ms: Date.now() - started });
      return;
    }
    const isZipImport = request.url?.includes("plugin.import") === true;
    const body = await readJsonBody(request, isZipImport ? { maxBytes: 64 * 1024 * 1024 } : {});
    op = String(body.op || "");
    if (op === "toggle") {
      // 设置页的开关：skill / mcp 的开启与关闭
      const id = String(body.id || "");
      const enabled = body.enabled !== false;
      setEnabledById(runtime, id, enabled);
      sendJson(response, 200, { ok: true, id, enabled, ...payload() });
      log?.info?.("api.request", { method: "POST", op, id, enabled, status: 200, ms: Date.now() - started });
      return;
    }
    if (op === "mode") {
      // 加载方式：「懒加载」/「跳过」 —— 和开关是同一份事实，只是叫法更贴切
      const id = String(body.id || "");
      const mode = String(body.mode || "");
      if (mode !== "lazy" && mode !== "skip") throw new Error('mode 只能是 "lazy" 或 "skip"');
      setEnabledById(runtime, id, mode === "lazy");
      sendJson(response, 200, { ok: true, id, mode, ...payload() });
      log?.info?.("api.request", { method: "POST", op, id, mode, status: 200, ms: Date.now() - started });
      return;
    }
    if (op === "update.check" || op === "update.download" || op === "update.install" || op === "update.snooze") {
      // 云更新：检查 / 下载 / 覆盖安装（安装完只标「需要重启」，不自己重启）/ 本次或今天不提醒
      const updater = runtime.updater;
      if (!updater) throw new Error("更新管理器没有初始化");
      if (op === "update.snooze") {
        const scope = String(body.scope || "session");
        updater.snooze(scope);
        sendJson(response, 200, { ok: true, scope, ...payload() });
        log?.info?.("api.request", { method: "POST", op, scope, status: 200, ms: Date.now() - started });
        return;
      }
      if (op === "update.check") {
        const status = await updater.check({ force: true });
        sendJson(response, 200, { ok: true, update: status, version: PLUGIN_VERSION });
        log?.info?.("api.request", { method: "POST", op, latest: status.latest, hasUpdate: status.hasUpdate, status: 200, ms: Date.now() - started });
        return;
      }
      if (op === "update.download") {
        const status = await updater.download();
        sendJson(response, 200, { ok: true, update: status, version: PLUGIN_VERSION });
        log?.info?.("api.request", { method: "POST", op, downloaded: status.download?.version ?? "", status: 200, ms: Date.now() - started });
        return;
      }
      const status = await updater.install();
      sendJson(response, 200, { ok: true, update: status, restartRequired: true, version: PLUGIN_VERSION });
      log?.info?.("api.request", { method: "POST", op, installed: status.installed?.version ?? "", status: 200, ms: Date.now() - started });
      return;
    }
    if (op === "code.read" || op === "code.validate" || op === "code.write" || op === "code.revert") {
      // 内置代码编辑器：读 / 校验 / 写（先校验）/ 回滚到上一次备份
      const file = String(body.path || "").trim();
      if (!file) throw new Error("需要 path");
      const root = runtime.store.root;
      if (op === "code.read") {
        const result = readCode({ file });
        sendJson(response, 200, { ok: true, file: result });
        log?.info?.("api.request", { method: "POST", op, status: 200, ms: Date.now() - started });
        return;
      }
      if (op === "code.validate") {
        const content = typeof body.content === "string" ? body.content : readCode({ file }).content;
        const result = await validateCode({ file, content });
        sendJson(response, 200, { ok: true, validation: result });
        log?.info?.("api.request", { method: "POST", op, valid: result.ok, status: 200, ms: Date.now() - started });
        return;
      }
      if (op === "code.write") {
        if (typeof body.content !== "string") throw new Error("需要 content");
        const result = await writeCode({ root, file, content: body.content, force: body.force === true });
        sendJson(response, 200, { ok: true, write: result });
        log?.info?.("api.request", { method: "POST", op, written: result.written, status: 200, ms: Date.now() - started });
        return;
      }
      const result = revertCode({ root, file });
      sendJson(response, 200, { ok: true, reverted: result });
      log?.info?.("api.request", { method: "POST", op, status: 200, ms: Date.now() - started });
      return;
    }
    if (op === "plugin.import") {
      // 「工具」页的 zip 导入：浏览器把压缩包读成 base64 传上来，这里解压 + 校验 + 接线
      const raw = String(body.zip || "");
      const base64 = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
      if (!base64) throw new Error("没有收到 zip 内容");
      const buffer = Buffer.from(base64, "base64");
      const result = importPluginZip({
        buffer,
        profiles: listProfiles(dshHome()).filter((dir) => isProfileDir(dir)),
        installRoot: path.join(runtime.store.root, "plugins"),
        overwrite: body.overwrite !== false,
        log,
        sourceName: String(body.filename || ""),
      });
      sendJson(response, 200, { ok: true, imported: result, ...payload() });
      log?.info?.("api.request", { method: "POST", op, name: result.name, version: result.version, status: 200, ms: Date.now() - started });
      return;
    }
    if (op === "plugin.preview") {
      // 拖进来先给个回执：叫什么、多少文件、是不是组合包
      const raw = String(body.zip || "");
      const base64 = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
      if (!base64) throw new Error("没有收到 zip 内容");
      const buffer = Buffer.from(base64, "base64");
      const preview = previewPluginZip(buffer);
      sendJson(response, 200, { ok: true, preview: { ...preview, filename: String(body.filename || "") } });
      log?.info?.("api.request", { method: "POST", op, files: preview.files, status: 200, ms: Date.now() - started });
      return;
    }
    if (op === "discover") {
      // 「工具」页：手动扫一遍已安装插件自带的 skill / MCP / 工具组
      const result = discoverPluginAssets({
        store: runtime.store,
        profiles: listProfiles(dshHome()).filter((dir) => isProfileDir(dir)),
        dshHome: dshHome(),
        log,
        logger: runtime.logger,
        state: runtime.discoverState,
        neverLazy: { builtin: runtime.config.neverLazyBuiltin, extra: runtime.config.neverLazyExtra },
      });
      sendJson(response, 200, { ok: true, discover: result, ...payload() });
      log?.info?.("api.request", { method: "POST", op, adopted: result.skills.length + result.servers.length, status: 200, ms: Date.now() - started });
      return;
    }
    if (op === "unloadAll") {
      // 「工具」页：把本会话注入的工具定义全部撤掉
      const agent = runtime.lastAgent;
      let count = 0;
      if (agent) {
        const loaded = runtime.injector.loaded(agent).map((item) => item.id);
        if (loaded.length > 0) {
          const report = runtime.injector.unload(agent, loaded);
          count = report.filter((item) => item.ok).length;
        }
      }
      sendJson(response, 200, { ok: true, unloaded: count, ...payload() });
      log?.info?.("api.request", { method: "POST", op, unloaded: count, status: 200, ms: Date.now() - started });
      return;
    }
    sendJson(response, 400, { ok: false, error: `unknown op: ${op}` });
    log?.warn?.("api.request", { method: "POST", op, status: 400, ms: Date.now() - started });
  } catch (error) {
    log?.error?.("api.request", { method: request.method ?? "", op, status: 500, ms: Date.now() - started, error });
    sendJson(response, 500, { ok: false, error: errorMessage(error) });
  }
}

function runMigration(runtime) {
  const { store, logger, config, log } = runtime;
  const profiles = listProfiles(dshHome()).filter((dir) => isProfileDir(dir));
  if (profiles.length > 0) {
    const result = migrateMcpFromProfiles({ store, profiles, logger });
    for (const skip of result.skipped) logger.warn?.(`lazy-toolbox: 跳过 ${skip.profile} 的 ${skip.id}：${skip.reason}`);
    log?.info?.("migrate.mcp", { profiles: profiles.length, moved: result.moved ?? 0, skipped: result.skipped.length });
  }
  const roots = skillRoots({
    dshHome: dshHome(),
    agentsHome: agentsHome(),
    cwd: process.cwd(),
    includeProject: config.autoImportProjectSkills,
  });
  const result = migrateSkillsFromRoots({ store, roots, logger });
  for (const skip of result.skipped) logger.warn?.(`lazy-toolbox: 跳过 ${skip.path}：${skip.reason}`);
  log?.info?.("migrate.skills", { roots: roots.length, moved: result.moved ?? 0, skipped: result.skipped.length });
}

function scanOnce(runtime) {
  const { store, config, logger } = runtime;
  // 1) 新出现的用户级 skill
  const roots = skillRoots({
    dshHome: dshHome(),
    agentsHome: agentsHome(),
    cwd: process.cwd(),
    includeProject: config.autoImportProjectSkills,
  });
  const imported = autoImportSkills({ store, roots, logger });
  if (imported.moved.length > 0) {
    logger.info?.(`lazy-toolbox: 自动导入 ${imported.moved.length} 个 skill`);
  }
  // 2) 新加到 profile 的 mcp-client 行（需要重启后才会真正从全局工具里消失，
  //    但配置会先被搬进插件库，AI 用 toolbox load 可以立刻用）
  const profiles = listProfiles(dshHome()).filter((dir) => isProfileDir(dir));
  for (const profileDir of profiles) {
    try {
      const text = readText(path.join(profileDir, "cordis.patch.yml"), "");
      if (!text.includes("@deepseek-ai/dsh-mcp-client")) continue;
      const result = migrateMcpFromProfiles({ store, profiles: [profileDir], logger });
      if (result.moved.length > 0) {
        logger.info?.(`lazy-toolbox: 自动迁移了 ${result.moved.length} 个 MCP 服务`);
      }
    } catch {
      /* ignore */
    }
  }
}

/** 扫已安装插件内置的 skill / MCP（指纹没变就直接返回，不重复读盘）。 */
function scanPluginAssets(runtime) {
  const { store, logger, log } = runtime;
  const result = discoverPluginAssets({
    store,
    profiles: listProfiles(dshHome()).filter((dir) => isProfileDir(dir)),
    dshHome: dshHome(),
    log,
    state: runtime.discoverState,
    neverLazy: { builtin: runtime.config?.neverLazyBuiltin !== false, extra: runtime.config?.neverLazyExtra ?? [] },
  });
  if (result.pruned.length > 0) logger.info?.(`lazy-toolbox: 回收了 ${result.pruned.length} 个已失效的插件资产`);
  return result;
}

/** CLI 用：和插件同一份迁移逻辑。 */
export function migrateNow({ dataDir, logger = console } = {}) {
  const store = new Store(dataDir);
  const mcp = new McpManager({ store, logger });
  const runtime = { store, mcp, logger, config: { ...DEFAULTS, autoImportProjectSkills: false } };
  runMigration(runtime);
  return store;
}

/** CLI 用：扫一遍插件内置资产（--dry-run 只看不动）。 */
export function discoverNow({ dataDir, dryRun = false, logger = console } = {}) {
  const store = new Store(dataDir);
  const log = new PluginLog({ dir: path.join(store.root, "logs") });
  const result = discoverPluginAssets({
    store,
    profiles: listProfiles(dshHome()).filter((dir) => isProfileDir(dir)),
    dshHome: dshHome(),
    log,
    dryRun,
    neverLazy: { builtin: runtime.config?.neverLazyBuiltin !== false, extra: runtime.config?.neverLazyExtra ?? [] },
  });
  logger.info?.(`lazy-toolbox: 看了 ${result.candidates} 个插件包`);
  return result;
}

/** CLI 用：确认插件目录结构是否就绪。 */
export function inspectDataDir(dataDir) {
  const store = new Store(dataDir);
  return {
    root: store.root,
    exists: exists(store.root),
    skills: store.listSkills().length,
    servers: store.listServers().length,
    updatedAt: store.data.updatedAt,
  };
}

export default { name, inject, apply };
