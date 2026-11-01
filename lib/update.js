/**
 * 云更新：查仓库有没有新版本、把新版本下载下来、覆盖安装、提示重启。
 *
 * 只用 GitHub 的公开接口（无需自建服务器）：
 *   GET /repos/<owner>/<repo>/releases/latest   → 版本号 + 更新内容（release 正文）+ 附件
 *   附件里的 `dsh-lazy-toolbox-<版本>.zip` 就是发布包
 *
 * 设计取舍：
 *   - 检查结果落盘（`<数据目录>/update-state.json`），设置页打开就有东西看，不强依赖网络；
 *   - 下载和解压分开：装之前能先看到下载到哪、解压出什么；
 *   - 安装前把现有源码目录备份到 `<数据目录>/updates/backup-*`，出事能手动回滚；
 *   - 安装完只写「需要重启」标记，绝不自己重启进程 —— 由用户决定什么时候重启。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureDir, exists, isDirectory, nowIso, readJson, writeJsonAtomic } from "./util.js";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 这些顶层条目属于「插件本体」，更新时覆盖它们（node_modules / .git 不碰）。 */
const PLUGIN_FILES = [
  "package.json",
  "client.js",
  "lib",
  "bin",
  "scripts",
  "docs",
  "examples",
  "test",
  "README.md",
  "README.en.md",
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE",
];

/** 版本比较：1.0.0 > 0.9.9；1.0.0 > 1.0.0-rc.1（预发布更低）。 */
export function compareVersions(left, right) {
  const parse = (value) => {
    const text = String(value ?? "").trim().replace(/^v/i, "");
    const [core, pre = ""] = text.split(/-(.+)/);
    const numbers = core.split(".").map((part) => Number.parseInt(part, 10) || 0);
    while (numbers.length < 3) numbers.push(0);
    return { numbers: numbers.slice(0, 3), pre };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre > b.pre ? 1 : -1;
}

/** 从 release 里挑发布包：优先本项目命名的 zip，其次任意 zip。 */
export function pickAsset(assets, tag = "") {
  const list = Array.isArray(assets) ? assets : [];
  const version = String(tag).replace(/^v/i, "");
  const byName = (needle) => list.find((asset) => String(asset?.name ?? "").includes(needle));
  return (
    byName(version ? `-${version}.zip` : ".zip") ??
    byName("dsh-lazy-toolbox") ??
    list.find((asset) => /\.zip$/i.test(String(asset?.name ?? ""))) ??
    list.find((asset) => /\.(tar\.gz|tgz)$/i.test(String(asset?.name ?? ""))) ??
    null
  );
}

/** release 正文截断，别把一整篇塞进设置页。 */
export function trimNotes(body, limit = 8000) {
  const text = String(body ?? "").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n…（更新说明过长，只显示前 ${limit} 字符）`;
}

/**
 * 解压 zip：Windows 用 PowerShell 的 Expand-Archive，其他平台用 unzip。
 * 解压失败不吞异常，交给上层提示「手动解压」。
 */
export async function extractZip(file, targetDir) {
  ensureDir(targetDir);
  if (process.platform === "win32") {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${file.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force`],
      { windowsHide: true, timeout: 120000 },
    );
    return;
  }
  await execFileAsync("unzip", ["-oq", file, "-d", targetDir], { timeout: 120000 });
}

/** 解压出来的目录里找真正的包根（zip 通常有顶层文件夹）。 */
function locatePackageRoot(dir) {
  if (exists(path.join(dir, "package.json"))) return dir;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    if (exists(path.join(child, "package.json"))) return child;
  }
  return "";
}

export class UpdateManager {
  /**
   * @param {object} options
   * @param {string} options.root 数据目录
   * @param {object} options.config 插件配置
   * @param {string} options.currentVersion 当前版本
   * @param {string} [options.installDir] 插件安装目录（默认本包根目录）
   * @param {Function} [options.fetchImpl] 便于测试替换
   */
  constructor({ root, config = {}, currentVersion = "0.0.0", installDir = "", log = null, logger = console, fetchImpl = null }) {
    this.root = root;
    this.config = config;
    this.currentVersion = String(currentVersion).replace(/^v/i, "");
    this.installDir = installDir || path.resolve(HERE, "..");
    this.log = log;
    this.logger = logger;
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
    this.stateFile = path.join(root, "update-state.json");
    this.updatesDir = path.join(root, "updates");
    this.memory = null;
    this.inflight = null;
    /** 进程标识：用来实现「本次不提醒」——重启后这份 token 就变了。 */
    this.processToken = `${process.pid}-${Date.now()}`;
  }

  get repo() {
    return String(this.config.updateRepo ?? "anyi-520/dsh-lazy-toolbox").trim();
  }

  /** 本地日期（YYYY-MM-DD），用于「今天不提醒」。 */
  static today(now = new Date()) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  /** 静默：scope = "session"（本次不提醒）| "today"（今天不提醒）。 */
  snooze(scope = "session") {
    const state = this.readState();
    const next = { ...state, snooze: null };
    if (scope === "today") next.snooze = { scope: "today", until: UpdateManager.today(), at: nowIso() };
    else next.snooze = { scope: "session", session: this.processToken, at: nowIso() };
    this.writeState(next);
    this.log?.info?.("update.snooze", { scope });
    return this.#shape(next);
  }

  /** 现在该不该弹「有新版本」的窗？（不经过 #shape，避免互相递归） */
  shouldPrompt(state = this.readState()) {
    const latest = state.latest ?? "";
    if (!latest) return false;
    if (compareVersions(latest, this.currentVersion) <= 0) return false;
    const snooze = state.snooze ?? null;
    if (!snooze) return true;
    if (snooze.scope === "session" && snooze.session === this.processToken) return false;
    if (snooze.scope === "today" && snooze.until && snooze.until >= UpdateManager.today()) return false;
    return true;
  }

  readState() {
    if (this.memory) return this.memory;
    const state = readJson(this.stateFile, null);
    this.memory = state && typeof state === "object" ? state : {};
    return this.memory;
  }

  writeState(next) {
    this.memory = next;
    try {
      writeJsonAtomic(this.stateFile, next);
    } catch (error) {
      this.log?.warn?.("update.state", { error });
    }
  }

  /** 只读缓存：不联网，设置页首屏用。 */
  status() {
    const state = this.readState();
    return this.#shape(state);
  }

  #shape(state) {
    const latest = state.latest ?? "";
    const hasUpdate = latest ? compareVersions(latest, this.currentVersion) > 0 : false;
    return {
      repo: this.repo,
      current: this.currentVersion,
      latest,
      hasUpdate,
      publishedAt: state.publishedAt ?? "",
      htmlUrl: state.htmlUrl ?? "",
      notes: state.notes ?? "",
      assets: state.assets ?? [],
      checkedAt: state.checkedAt ?? "",
      error: state.error ?? "",
      download: state.download ?? null,
      installed: state.installed ?? null,
      installDir: this.installDir,
      snooze: state.snooze ?? null,
      /** 该不该弹窗：有新版本 + 没被「本次/今天不提醒」挡掉 */
      prompt: { show: this.shouldPrompt(state) },
    };
  }

  /**
   * 检查更新。默认 10 分钟内复用上次结果；`force: true` 强制联网。
   * 网络失败不抛：把错误写进 state，设置页能显示「检查失败」。
   */
  async check({ force = false } = {}) {
    const state = this.readState();
    if (!force && state.checkedAt) {
      const age = Date.now() - new Date(state.checkedAt).getTime();
      if (Number.isFinite(age) && age >= 0 && age < 10 * 60 * 1000) return this.#shape(state);
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.#checkOnce(state).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async #checkOnce(state) {
    const url = `https://api.github.com/repos/${this.repo}/releases/latest`;
    const headers = {
      accept: "application/vnd.github+json",
      "user-agent": "dsh-lazy-toolbox-update",
    };
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      const response = await this.fetchImpl(url, { headers });
      if (!response.ok) throw new Error(`GitHub 返回 ${response.status}${response.status === 404 ? "（仓库或 Release 不存在）" : ""}`);
      const data = await response.json();
      const tag = String(data.tag_name ?? data.name ?? "");
      const latest = tag.replace(/^v/i, "");
      if (!latest) throw new Error("Release 里没有 tag_name");
      const next = {
        checkedAt: nowIso(),
        latest,
        publishedAt: data.published_at ?? "",
        htmlUrl: data.html_url ?? "",
        notes: trimNotes(data.body ?? ""),
        assets: (data.assets ?? []).map((asset) => ({ name: asset.name, size: asset.size ?? 0, url: asset.browser_download_url ?? "" })),
        error: "",
        download: state.download?.version === latest ? state.download : null,
        installed: state.installed ?? null,
        snooze: state.snooze ?? null,
      };
      this.writeState(next);
      const shaped = this.#shape(next);
      this.log?.info?.("update.check", { current: shaped.current, latest: shaped.latest, hasUpdate: shaped.hasUpdate });
      return shaped;
    } catch (error) {
      const next = { ...state, checkedAt: nowIso(), error: String(error?.message ?? error) };
      this.writeState(next);
      this.log?.warn?.("update.check", { error: next.error });
      return this.#shape(next);
    }
  }

  /** 下载发布包到 `<数据目录>/updates/`，并解压到 `<数据目录>/updates/<版本>/`。 */
  async download({ version = "" } = {}) {
    const state = this.readState();
    const status = this.#shape(state);
    if (status.error && !status.latest) throw new Error(`先检查更新：${status.error}`);
    const target = String(version || status.latest || "").replace(/^v/i, "");
    if (!target) throw new Error("还不知道最新版本，先 action=update step=check");
    const asset = pickAsset(status.assets, target);
    if (!asset?.url) throw new Error("这个 Release 没有可下载的 zip 附件");

    ensureDir(this.updatesDir);
    const file = path.join(this.updatesDir, asset.name);
    const headers = { "user-agent": "dsh-lazy-toolbox-update", accept: "application/octet-stream" };
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await this.fetchImpl(asset.url, { headers, redirect: "follow" });
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (asset.size && buffer.length !== asset.size) {
      throw new Error(`下载不完整：期望 ${asset.size} 字节，实际 ${buffer.length} 字节`);
    }
    fs.writeFileSync(file, buffer);

    const extractDir = path.join(this.updatesDir, target);
    let packageDir = "";
    try {
      await extractZip(file, extractDir);
      packageDir = locatePackageRoot(extractDir);
    } catch (error) {
      this.log?.warn?.("update.extract", { error: String(error?.message ?? error) });
    }
    const download = {
      version: target,
      file,
      size: buffer.length,
      packageDir,
      at: nowIso(),
      extracted: Boolean(packageDir),
      extractError: packageDir ? "" : "解压失败或包里找不到 package.json：可以手动解压后再安装",
    };
    this.writeState({ ...state, download });
    this.log?.info?.("update.download", { version: target, size: buffer.length, extracted: download.extracted });
    return { ...this.#shape(this.readState()) };
  }

  /**
   * 覆盖安装：先备份现有源码目录，再把解压出来的文件拷过去，最后标记「需要重启」。
   * 不碰 node_modules / .git / 数据目录。
   */
  async install() {
    const state = this.readState();
    const download = state.download;
    if (!download?.packageDir) throw new Error("还没有解压好的新版本，先 action=update step=download");
    if (!isDirectory(download.packageDir)) throw new Error(`解压目录不见了：${download.packageDir}`);
    if (!isDirectory(this.installDir)) throw new Error(`安装目录不可用：${this.installDir}`);

    const backupDir = path.join(this.updatesDir, `backup-${this.currentVersion}-${Date.now()}`);
    ensureDir(backupDir);
    let backedUp = 0;
    for (const entry of PLUGIN_FILES) {
      const source = path.join(this.installDir, entry);
      if (!exists(source)) continue;
      fs.cpSync(source, path.join(backupDir, entry), { recursive: true, force: true });
      backedUp += 1;
    }

    let copied = 0;
    for (const entry of PLUGIN_FILES) {
      const source = path.join(download.packageDir, entry);
      if (!exists(source)) continue;
      fs.cpSync(source, path.join(this.installDir, entry), { recursive: true, force: true });
      copied += 1;
    }
    if (copied === 0) throw new Error("新版本里没有可覆盖的文件，安装中止（原文件已备份）");

    const installed = { version: download.version, at: nowIso(), restartRequired: true, backupDir, files: copied };
    this.writeState({ ...state, installed, download: null });
    this.log?.info?.("update.install", { version: download.version, files: copied, backupDir });
    return { ...this.#shape(this.readState()), restartRequired: true };
  }
}
