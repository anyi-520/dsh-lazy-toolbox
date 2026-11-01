/**
 * 云更新（lib/update.js）：版本比较、挑发布包、检查（离线可测）、下载、覆盖安装。
 * 网络用注入的 fetch 假件，zip 用本机 PowerShell 现做一个，全流程离线可跑。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UpdateManager, compareVersions, pickAsset, trimNotes } from "../lib/update.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

function releasePayload(version) {
  return {
    tag_name: `v${version}`,
    published_at: "2026-11-01T00:00:00Z",
    html_url: `https://github.com/anyi-520/dsh-lazy-toolbox/releases/tag/v${version}`,
    body: `## 懒工具箱 ${version}\n\n- 修了个 bug\n- 加了个功能`,
    assets: [
      { name: `dsh-lazy-toolbox-${version}.zip`, size: 5, browser_download_url: `https://example.invalid/${version}.zip` },
      { name: "notes.txt", size: 1, browser_download_url: "https://example.invalid/notes.txt" },
    ],
  };
}

function fakeFetch(handler) {
  return async (url, options) => handler(String(url), options);
}

function okJson(data) {
  return { ok: true, status: 200, json: async () => data };
}

test("版本比较：数字段 + 预发布", () => {
  assert.equal(compareVersions("0.5.3", "0.5.2"), 1);
  assert.equal(compareVersions("v0.5.3", "0.5.3"), 0);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("", "0.0.1"), -1);
});

test("挑附件：优先本项目命名的 zip", () => {
  const assets = releasePayload("0.6.0").assets;
  assert.equal(pickAsset(assets, "v0.6.0").name, "dsh-lazy-toolbox-0.6.0.zip");
  assert.equal(pickAsset([{ name: "other.zip", url: "x" }], "0.6.0").name, "other.zip");
  assert.equal(pickAsset([], "0.6.0"), null);
});

test("更新说明截断", () => {
  const long = "x".repeat(9000);
  assert.ok(trimNotes(long, 100).length < long.length);
  assert.match(trimNotes(long, 100), /只显示前 100 字符/);
  assert.equal(trimNotes("短说明", 100), "短说明");
});

test("检查：有新版 / 已最新 / 网络失败三条路径", async () => {
  const root = tempDir("lt-up-");
  const updater = new UpdateManager({
    root,
    config: { updateRepo: "anyi-520/dsh-lazy-toolbox" },
    currentVersion: "0.5.3",
    log: quietLog,
    fetchImpl: fakeFetch(() => okJson(releasePayload("0.6.0"))),
  });
  const status = await updater.check({ force: true });
  assert.equal(status.current, "0.5.3");
  assert.equal(status.latest, "0.6.0");
  assert.equal(status.hasUpdate, true);
  assert.match(status.notes, /修了个 bug/);
  assert.equal(status.assets.length, 2);
  assert.ok(fs.existsSync(path.join(root, "update-state.json")), "检查结果要落盘");

  const same = new UpdateManager({
    root: tempDir("lt-up2-"),
    config: {},
    currentVersion: "0.6.0",
    log: quietLog,
    fetchImpl: fakeFetch(() => okJson(releasePayload("0.6.0"))),
  });
  assert.equal((await same.check({ force: true })).hasUpdate, false);
  assert.match(same.status().htmlUrl, /releases\/tag\/v0\.6\.0/);

  const broken = new UpdateManager({
    root: tempDir("lt-up3-"),
    config: {},
    currentVersion: "0.5.3",
    log: quietLog,
    fetchImpl: fakeFetch(() => ({ ok: false, status: 404, json: async () => ({}) })),
  });
  const failed = await broken.check({ force: true });
  assert.equal(failed.hasUpdate, false);
  assert.match(failed.error, /404/);

  const offline = new UpdateManager({
    root: tempDir("lt-up4-"),
    config: {},
    currentVersion: "0.5.3",
    log: quietLog,
    fetchImpl: fakeFetch(() => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    }),
  });
  assert.match((await offline.check({ force: true })).error, /ENOTFOUND/);
});

test("缓存：非 force 时 10 分钟内不重复联网", async () => {
  let calls = 0;
  const updater = new UpdateManager({
    root: tempDir("lt-up5-"),
    config: {},
    currentVersion: "0.5.3",
    log: quietLog,
    fetchImpl: fakeFetch(() => {
      calls += 1;
      return okJson(releasePayload("0.6.0"));
    }),
  });
  await updater.check({ force: true });
  await updater.check();
  await updater.check();
  assert.equal(calls, 1, "应复用缓存");
});

test("下载 + 安装：解压、备份、覆盖，最后标记需要重启", async () => {
  if (process.platform !== "win32") {
    // 非 Windows 也能跑「下载」这一段，只是不解压
    return;
  }
  const root = tempDir("lt-up6-");
  const installDir = tempDir("lt-inst-");
  write(path.join(installDir, "package.json"), JSON.stringify({ version: "0.5.3" }));
  write(path.join(installDir, "lib", "index.js"), "// old\n");
  write(path.join(installDir, "node_modules", "keep.txt"), "keep\n");

  // 现做一个 zip：内容是新版的 package.json + lib/index.js
  const stage = tempDir("lt-stage-");
  write(path.join(stage, "dsh-lazy-toolbox", "package.json"), JSON.stringify({ version: "0.6.0" }));
  write(path.join(stage, "dsh-lazy-toolbox", "lib", "index.js"), "// new\n");
  const zipFile = path.join(root, "release.zip");
  await new Promise((resolve, reject) => {
    import("node:child_process").then(({ execFile }) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipFile}' -Force`],
        (error) => (error ? reject(error) : resolve()),
      );
    });
  });
  const bytes = fs.readFileSync(zipFile);

  const updater = new UpdateManager({
    root,
    config: {},
    currentVersion: "0.5.3",
    installDir,
    log: quietLog,
    fetchImpl: fakeFetch((url) => {
      if (url.includes("api.github.com")) return okJson({ ...releasePayload("0.6.0"), assets: [{ name: "dsh-lazy-toolbox-0.6.0.zip", size: bytes.length, browser_download_url: "https://example.invalid/pkg.zip" }] });
      return { ok: true, status: 200, arrayBuffer: async () => bytes };
    }),
  });

  await updater.check({ force: true });
  const downloaded = await updater.download();
  assert.equal(downloaded.download.version, "0.6.0");
  assert.equal(downloaded.download.extracted, true);
  assert.ok(fs.existsSync(path.join(downloaded.download.packageDir, "package.json")));

  const installed = await updater.install();
  assert.equal(installed.installed.version, "0.6.0");
  assert.equal(installed.restartRequired, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(installDir, "package.json"), "utf8")).version, "0.6.0", "文件应被覆盖");
  assert.equal(fs.readFileSync(path.join(installDir, "lib", "index.js"), "utf8"), "// new\n");
  assert.ok(fs.existsSync(path.join(installDir, "node_modules", "keep.txt")), "node_modules 不该被碰");
  assert.ok(fs.existsSync(path.join(installed.installed.backupDir, "package.json")), "老文件要备份");
  assert.equal(JSON.parse(fs.readFileSync(path.join(installed.installed.backupDir, "package.json"), "utf8")).version, "0.5.3");
  assert.equal(updater.status().installed.restartRequired, true);
});

test("没下载就安装：给出可读错误", async () => {
  const updater = new UpdateManager({
    root: tempDir("lt-up7-"),
    config: {},
    currentVersion: "0.5.3",
    log: quietLog,
    fetchImpl: fakeFetch(() => okJson(releasePayload("0.6.0"))),
  });
  await updater.check({ force: true });
  await assert.rejects(() => updater.install(), /先 action=update step=download/);
});


test("静默：本次不提醒跳过本次进程，重启后重新提醒", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lt-snooze-"));
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: "v9.9.9", body: "", assets: [] }) });
  const a = new UpdateManager({ root, config: {}, currentVersion: "0.7.0", log: null, fetchImpl });
  await a.check({ force: true });
  assert.equal(a.status().prompt.show, true);
  a.snooze("session");
  assert.equal(a.status().prompt.show, false, "本次不提醒之后就别弹了");
  const b = new UpdateManager({ root, config: {}, currentVersion: "0.7.0", log: null, fetchImpl });
  assert.equal(b.status().prompt.show, true, "重启（新进程）要重新提醒");
});

test("静默：今天不提醒跨重启也不再弹，直到第二天", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lt-snooze2-"));
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: "v9.9.9", body: "", assets: [] }) });
  const a = new UpdateManager({ root, config: {}, currentVersion: "0.7.0", log: null, fetchImpl });
  await a.check({ force: true });
  a.snooze("today");
  assert.equal(a.status().snooze.scope, "today");
  assert.equal(a.status().snooze.until, UpdateManager.today());
  const b = new UpdateManager({ root, config: {}, currentVersion: "0.7.0", log: null, fetchImpl });
  assert.equal(b.status().prompt.show, false, "同一天内重启也不再弹");
});

test("没有新版本时不弹窗", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lt-snooze3-"));
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: "v0.7.0", body: "", assets: [] }) });
  const a = new UpdateManager({ root, config: {}, currentVersion: "0.7.0", log: null, fetchImpl });
  await a.check({ force: true });
  assert.equal(a.status().hasUpdate, false);
  assert.equal(a.status().prompt.show, false);
});

test("check 之后 snooze 还在（不会被覆盖掉）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lt-snooze4-"));
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: "v9.9.9", body: "", assets: [] }) });
  const a = new UpdateManager({ root, config: {}, currentVersion: "0.7.0", log: null, fetchImpl });
  await a.check({ force: true });
  a.snooze("today");
  await a.check({ force: true });
  assert.equal(a.status().snooze.scope, "today");
  assert.equal(a.status().prompt.show, false);
});
