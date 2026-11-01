/**
 * ZIP 读取与「zip 直接装插件」的测试。
 * 自己写一个最小 zip 打包器（store + deflate 两种），不引依赖。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { ZIP_LIMITS, extractZip, listZipEntries, readZipFile, safeEntryPath } from "../lib/zip.js";
import { findPackageRoot, importPluginZip, previewPluginZip, safeDirName } from "../lib/importer.js";

// ── 最小 zip 打包器 ───────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** entries: [{ name, content: string|Buffer, deflate?: boolean }] */
export function createZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content), "utf8");
    const deflate = entry.deflate !== false;
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

const MANIFEST = JSON.stringify(
  {
    name: "dsh-demo-plugin",
    version: "1.2.3",
    description: "测试用插件",
    main: "index.js",
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
  },
  null,
  2,
);

const DEMO_ENTRIES = [
  { name: "dsh-demo/package.json", content: MANIFEST },
  { name: "dsh-demo/index.js", content: "export const name = 'demo';\n" },
  { name: "dsh-demo/cordis.patch.yml", content: "- insert:\n    - id: demo\n      name: dsh-demo-plugin\n" },
  { name: "dsh-demo/docs/readme.md", content: "# demo\n", deflate: false },
];

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── zip 读取 ──────────────────────────────────────────────────────────────

test("listZipEntries：认出条目名、压缩方式与目录项", () => {
  const zip = createZip([...DEMO_ENTRIES, { name: "dsh-demo/empty/", content: "" }]);
  const entries = listZipEntries(zip);
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.map((entry) => entry.name), [
    "dsh-demo/package.json",
    "dsh-demo/index.js",
    "dsh-demo/cordis.patch.yml",
    "dsh-demo/docs/readme.md",
    "dsh-demo/empty/",
  ]);
  assert.equal(entries[0].method, 8, "默认 deflate");
  assert.equal(entries[3].method, 0, "指定 store 的就是 0");
  assert.equal(entries[4].isDirectory, true);
});

test("extractZip：deflate 与 store 都能解出原字节", () => {
  const target = tempDir("lt-zip-out-");
  const zip = createZip(DEMO_ENTRIES);
  const result = extractZip(zip, target);
  assert.equal(result.files.length, 4);
  assert.equal(fs.readFileSync(path.join(target, "dsh-demo/package.json"), "utf8"), MANIFEST);
  assert.equal(fs.readFileSync(path.join(target, "dsh-demo/docs/readme.md"), "utf8"), "# demo\n");
  assert.ok(result.totalBytes > 0);
});

test("zip-slip：`../` 条目直接拒绝", () => {
  const target = tempDir("lt-zip-slip-");
  const zip = createZip([{ name: "../../evil.txt", content: "x" }]);
  assert.throws(() => extractZip(zip, target), /zip-slip/);
  assert.equal(fs.existsSync(path.join(target, "..", "..", "evil.txt")), false);
});

test("绝对路径与盘符条目也拒绝", () => {
  assert.throws(() => safeEntryPath("/etc/passwd"), /绝对路径/);
  assert.throws(() => safeEntryPath("C:\\Windows\\x.dll"), /盘符/);
  assert.equal(safeEntryPath("./a/./b.txt"), "a/b.txt");
  assert.equal(safeEntryPath("a\\b\\c.txt"), "a/b/c.txt");
});

test("体积上限生效：单文件超限就抛", () => {
  const target = tempDir("lt-zip-limit-");
  const zip = createZip([{ name: "big.bin", content: "x".repeat(2048) }]);
  assert.throws(() => extractZip(zip, target, { maxFileBytes: 1024 }), /单个文件太大/);
  assert.ok(ZIP_LIMITS.maxEntries >= 1000);
});

test("readZipFile：只取一个小文件（预览用）", () => {
  const zip = createZip(DEMO_ENTRIES);
  const manifest = readZipFile(zip, "dsh-demo/package.json");
  assert.equal(JSON.parse(manifest.toString("utf8")).name, "dsh-demo-plugin");
  assert.equal(readZipFile(zip, "不存在.txt"), null);
});

test("坏文件给出可读的错误", () => {
  assert.throws(() => listZipEntries(Buffer.from("not a zip at all")), /文件太小|中央目录/);
  const truncated = createZip(DEMO_ENTRIES).subarray(0, 40);
  assert.throws(() => listZipEntries(truncated), /zip/);
});

// ── 装插件 ────────────────────────────────────────────────────────────────

test("previewPluginZip：报条目数、文件数与清单路径", () => {
  const preview = previewPluginZip(createZip(DEMO_ENTRIES));
  assert.equal(preview.entries, 4);
  assert.equal(preview.files, 4);
  assert.equal(preview.manifestPath, "dsh-demo/package.json");
});

test("safeDirName：scope 与怪字符都能落地成安全目录名", () => {
  assert.equal(safeDirName("dsh-demo-plugin", "1.2.3"), "dsh-demo-plugin-1.2.3");
  assert.equal(safeDirName("@scope/pkg", "0.0.1"), "scope__pkg-0.0.1");
  assert.equal(safeDirName("a b/c", "1"), "a_b__c-1");
});

test("findPackageRoot：zip 里多套一层也能找到插件根", () => {
  const dir = tempDir("lt-root-");
  fs.mkdirSync(path.join(dir, "outer", "inner"), { recursive: true });
  fs.writeFileSync(path.join(dir, "outer", "inner", "package.json"), "{}");
  assert.equal(findPackageRoot(dir), path.join(dir, "outer", "inner"));
  assert.equal(findPackageRoot(tempDir("lt-root-empty-")), null);
});

test("importPluginZip：装到 plugins/ 并写回 profile 的三处", () => {
  const root = tempDir("lt-import-");
  const profileDir = path.join(root, "profiles", "desktop");
  fs.mkdirSync(path.join(profileDir, "node_modules"), { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "package.json"),
    JSON.stringify({ name: "p", private: true, dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }, null, 2),
  );
  const installRoot = path.join(root, "plugins");

  const result = importPluginZip({ buffer: createZip(DEMO_ENTRIES), profiles: [profileDir], installRoot });

  assert.equal(result.name, "dsh-demo-plugin");
  assert.equal(result.version, "1.2.3");
  assert.equal(result.hasBundle, true);
  assert.equal(result.files, 4);
  assert.equal(fs.existsSync(path.join(result.dir, "index.js")), true);
  assert.equal(path.dirname(result.dir), installRoot);

  const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, "package.json"), "utf8"));
  assert.equal(manifest.dependencies["dsh-demo-plugin"], `link:${result.dir.replace(/\\/g, "/")}`);
  assert.ok(manifest.dsh.profile.bundles.includes("dsh-demo-plugin"));

  const patch = fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8");
  assert.match(patch, /- insert:/);
  assert.match(patch, /name: dsh-demo-plugin/);

  assert.equal(fs.realpathSync(path.join(profileDir, "node_modules", "dsh-demo-plugin")), fs.realpathSync(result.dir));
  assert.equal(result.restartRequired, true);
  // 暂存目录要清干净
  assert.equal(fs.readdirSync(installRoot).filter((name) => name.startsWith(".staging")).length, 0);
});

test("importPluginZip：再装一次不会重复加 patch 行，也不会堆目录", () => {
  const root = tempDir("lt-import2-");
  const profileDir = path.join(root, "profiles", "desktop");
  fs.mkdirSync(path.join(profileDir, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(profileDir, "package.json"), JSON.stringify({ name: "p", dependencies: {} }, null, 2));
  const installRoot = path.join(root, "plugins");

  const first = importPluginZip({ buffer: createZip(DEMO_ENTRIES), profiles: [profileDir], installRoot });
  const second = importPluginZip({ buffer: createZip(DEMO_ENTRIES), profiles: [profileDir], installRoot });

  assert.equal(first.dir, second.dir);
  assert.equal(fs.readdirSync(installRoot).length, 1);
  const patch = fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8");
  assert.equal((patch.match(/name: dsh-demo-plugin/g) ?? []).length, 1, "patch 里只该有一行");
  assert.equal(second.profiles[0].patch.skipped, "已经有这一行");
});

test("importPluginZip：没声明 dsh.bundle 的包也能装，但会说明", () => {
  const root = tempDir("lt-import3-");
  const installRoot = path.join(root, "plugins");
  const plain = createZip([
    { name: "package.json", content: JSON.stringify({ name: "plain-plugin", version: "0.0.1" }) },
    { name: "index.js", content: "export const name = 'plain';\n" },
  ]);
  const result = importPluginZip({ buffer: plain, profiles: [], installRoot });
  assert.equal(result.hasBundle, false);
  assert.match(result.hint, /没有声明 dsh\.bundle/);
  assert.equal(result.profiles.length, 0);
});

test("importPluginZip：不是插件包就抛（没有 package.json）", () => {
  const root = tempDir("lt-import4-");
  const zip = createZip([{ name: "readme.txt", content: "hello" }]);
  assert.throws(() => importPluginZip({ buffer: zip, profiles: [], installRoot: path.join(root, "plugins") }), /package\.json/);
});

test("importPluginZip：坏 JSON 给出可读错误", () => {
  const root = tempDir("lt-import5-");
  const zip = createZip([{ name: "package.json", content: "{ oops" }]);
  assert.throws(() => importPluginZip({ buffer: zip, profiles: [], installRoot: path.join(root, "plugins") }), /不是合法 JSON/);
});
