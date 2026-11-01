/**
 * 从 zip 直接装插件：解压 → 校验 → 落到插件库 → 接线到 profile。
 *
 * 官方「添加插件」只认已解压的目录（或者包名 / GitHub 地址），压缩包得先自己解开。
 * 这里把那一步省掉：给一个 `.zip`，直接装成可加载的插件，并写回 profile 的三处：
 *   1. `package.json` 的 `dependencies`（`link:<插件目录>`）
 *   2. `package.json` 的 `dsh.profile.bundles`
 *   3. `cordis.patch.yml` 里的 insert 行（取包自带的那份 `cordis.patch.yml`）
 * 外加在 profile 的 `node_modules` 里建目录链接，重启 DSH 就能解析。
 */
import fs from "node:fs";
import path from "node:path";

import { extractZip, listZipEntries } from "./zip.js";
import { readText } from "./util.js";

const MANIFEST = "package.json";

/** 名字 → 目录名（去掉 scope、留下安全字符）。 */
export function safeDirName(name, version) {
  const base = String(name || "plugin")
    .replace(/^@/, "")
    .replace(/[/\\]/g, "__")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  const suffix = String(version || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return suffix ? `${base}-${suffix}` : base;
}

/** 在解压结果里找插件根：含 package.json 的最浅那一层。 */
export function findPackageRoot(dir) {
  const queue = [{ dir, depth: 0 }];
  let best = null;
  while (queue.length > 0) {
    const current = queue.shift();
    if (current.depth > 3) continue;
    if (fs.existsSync(path.join(current.dir, MANIFEST))) {
      if (!best || current.depth < best.depth) best = current;
      continue;
    }
    for (const entry of fs.readdirSync(current.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "__MACOSX" || entry.name.startsWith(".")) continue;
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }
  return best?.dir ?? null;
}

function readManifest(dir) {
  const file = path.join(dir, MANIFEST);
  const text = readText(file, "");
  if (!text) throw new Error("压缩包里没有 package.json，不是 DSH 插件包");
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`package.json 不是合法 JSON：${error.message}`);
  }
  if (!manifest?.name) throw new Error("package.json 里没有 name，装不了");
  return manifest;
}

/** profile 里加一条依赖（按名字，幂等地改 spec）。 */
export function ensureProfileDependency(profileDir, name, spec) {
  const file = path.join(profileDir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readText(file, "") || "{}");
  } catch {
    return { ok: false, wrote: false, path: file, reason: "profile 的 package.json 读不了" };
  }
  pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : {};
  let wrote = false;
  if (pkg.dependencies[name] !== spec) {
    pkg.dependencies[name] = spec;
    wrote = true;
  }
  pkg.dsh = pkg.dsh && typeof pkg.dsh === "object" ? pkg.dsh : {};
  pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === "object" ? pkg.dsh.profile : {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  if (!bundles.includes(name)) {
    pkg.dsh.profile.bundles = [...bundles, name];
    wrote = true;
  }
  if (!wrote) return { ok: true, wrote: false, path: file };
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  return { ok: true, wrote: true, path: file };
}

/** 把插件包里自带的 cordis.patch.yml 追加到 profile 的 patch 里（已存在同名行就跳过）。 */
export function ensureProfilePatch(profileDir, pluginDir, pluginName) {
  const source = path.join(pluginDir, "cordis.patch.yml");
  const patchText = readText(source, "").trim();
  if (!patchText) return { ok: true, wrote: false, skipped: "包里没有 cordis.patch.yml" };
  const file = path.join(profileDir, "cordis.patch.yml");
  const existing = readText(file, "");
  const hasRow = new RegExp(`^\\s*name:\\s*['"]?${pluginName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]?\\s*$`, "m").test(existing);
  if (hasRow) return { ok: true, wrote: false, path: file, skipped: "已经有这一行" };
  // 包自带的 patch 可能以注释开头：只要有顶格 `- ` 就原样搬过来（注释也一起搬，方便以后看懂）
  const hasRows = /^-\s/m.test(patchText);
  const body = hasRows ? patchText : `- insert:\n    - id: ${pluginName}\n      name: ${pluginName}`;
  const text = `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${existing ? "\n" : ""}${body}\n`;
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  return { ok: true, wrote: true, path: file, from: hasRows ? source : "fallback" };
}

/** profile 的 node_modules 里建链接。 */
export function ensureProfileLinkFor(profileDir, name, pluginDir) {
  const target = path.join(profileDir, "node_modules", name);
  try {
    const stats = fs.lstatSync(target);
    const current = stats.isSymbolicLink() ? fs.realpathSync(target) : "";
    if (current && path.resolve(current) === path.resolve(pluginDir)) return { ok: true, wrote: false, path: target };
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* 不存在，继续 */
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(path.resolve(pluginDir), target, "junction");
    return { ok: true, wrote: true, path: target };
  } catch (error) {
    return { ok: false, wrote: false, path: target, reason: error.message };
  }
}

/** 只看不装：读一眼 zip 里的 name / version / 有没有 dsh.bundle。 */
export function previewPluginZip(buffer) {
  const entries = listZipEntries(buffer);
  // 条目名可能带反斜杠（Windows 打的包），先统一成正斜杠再比深度
  const files = entries
    .filter((entry) => !entry.isDirectory)
    .map((entry) => String(entry.name).replace(/\\/g, "/"));
  const manifestName = files
    .filter((name) => name === MANIFEST || name.endsWith(`/${MANIFEST}`))
    .sort((a, b) => a.split("/").length - b.split("/").length)[0];
  if (!manifestName) throw new Error("压缩包里没有 package.json");
  return {
    entries: entries.length,
    files: files.length,
    manifestPath: manifestName,
    bytes: buffer.length,
  };
}

/**
 * 主流程：zip 字节 → 装好的插件目录 + profile 接线结果。
 * @param options.buffer - zip 内容
 * @param options.profiles - 要接线进去的 profile 目录（空数组就只落地不接线）
 * @param options.installRoot - 插件装到哪（默认 `<数据目录>/plugins`）
 * @param options.overwrite - 同名同版本已存在时是否覆盖（默认 true）
 * @param options.log - 可选日志器
 */
export function importPluginZip({
  buffer,
  profiles = [],
  installRoot,
  overwrite = true,
  log = null,
  sourceName = "",
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("没有收到 zip 内容");
  if (!installRoot) throw new Error("缺少 installRoot");
  fs.mkdirSync(installRoot, { recursive: true });

  const staging = path.join(installRoot, `.staging-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  let result;
  try {
    const extracted = extractZip(buffer, staging);
    const root = findPackageRoot(staging);
    if (!root) throw new Error("压缩包里没找到 package.json（插件根目录）");
    const manifest = readManifest(root);
    const name = String(manifest.name);
    const version = String(manifest.version ?? "0.0.0");
    const hasBundle = typeof manifest.dsh?.bundle?.patch === "string";

    const dirName = safeDirName(name, version);
    const target = path.join(installRoot, dirName);
    if (fs.existsSync(target)) {
      if (!overwrite) throw new Error(`已存在同名插件目录：${target}`);
      fs.rmSync(target, { recursive: true, force: true });
    }
    fs.renameSync(root, target);
    log?.info?.("plugin.import.extracted", { name, version, dir: target, files: extracted.files.length });

    const wiring = [];
    for (const profileDir of profiles) {
      const spec = `link:${target.replace(/\\/g, "/")}`;
      const dependency = ensureProfileDependency(profileDir, name, spec);
      const link = ensureProfileLinkFor(profileDir, name, target);
      const patch = hasBundle ? ensureProfilePatch(profileDir, target, name) : { ok: true, wrote: false, skipped: "包里没有 dsh.bundle，需要自己加一行" };
      wiring.push({ profileDir, dependency, link, patch });
      log?.info?.("plugin.import.wired", { profileDir, name, wrote: dependency.wrote || (patch.wrote ?? false) });
    }

    result = {
      name,
      version,
      dir: target,
      hasBundle,
      description: String(manifest.description ?? ""),
      files: extracted.files.length,
      bytes: extracted.totalBytes,
      zipBytes: buffer.length,
      sourceName,
      profiles: wiring,
      restartRequired: true,
      hint: hasBundle
        ? "重启 DSH 生效；想卸载就删掉这个目录，再把它从 profile 的 bundles 里去掉。"
        : "这个包没有声明 dsh.bundle，已作为普通依赖装好；要当插件层用，得在自己的 cordis.patch.yml 里加一行。",
    };
  } finally {
    try {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  }
  return result;
}

/** 从磁盘上的 zip 路径装（CLI 用）。 */
export function importPluginFromPath({ zipPath, profiles = [], installRoot, overwrite = true, log = null }) {
  const buffer = fs.readFileSync(zipPath);
  return importPluginZip({
    buffer,
    profiles,
    installRoot,
    overwrite,
    log,
    sourceName: path.basename(zipPath),
  });
}
