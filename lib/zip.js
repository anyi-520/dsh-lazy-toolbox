/**
 * 零依赖 ZIP 读取（够导入插件包用）。
 *
 * 只做三件事：找中央目录、按条目解出字节、把条目落盘。
 * 不做的：加密包、ZIP64、多分卷、CRC 校验（导入场景里我们后面还要读 package.json 校验）。
 *
 * 安全边界（导入的是别人给的压缩包，必须设）：
 * - 条目名只允许相对路径，`..`、盘符、绝对路径直接拒绝（防 zip-slip）；
 * - 条目数、单文件字节、总字节都有上限；
 * - 符号链接条目跳过。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const SIGNATURE_LOCAL = 0x04034b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_EOCD = 0x06054b50;

export const ZIP_LIMITS = {
  maxEntries: 5000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
};

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 66000);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === SIGNATURE_EOCD) return offset;
  }
  return -1;
}

/** 解出中央目录里的条目清单（不读数据）。 */
export function listZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error("不是有效的 zip：文件太小");
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error("不是有效的 zip：找不到中央目录末尾记录");
  const total = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || total === 0xffff) throw new Error("不支持 ZIP64 压缩包");
  if (cdOffset + cdSize > buffer.length) throw new Error("zip 结构损坏：中央目录越界");

  const entries = [];
  let cursor = cdOffset;
  for (let index = 0; index < total; index += 1) {
    if (cursor + 46 > buffer.length) throw new Error("zip 结构损坏：条目头被截断");
    if (buffer.readUInt32LE(cursor) !== SIGNATURE_CENTRAL) throw new Error("zip 结构损坏：中央目录签名不对");
    const method = buffer.readUInt16LE(cursor + 10);
    const crc32 = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttrs = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    entries.push({
      name,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localOffset,
      isDirectory: name.endsWith("/") || name.endsWith("\\"),
      // 高 16 位是 unix 权限；0xA000 表示符号链接
      isSymlink: ((externalAttrs >>> 16) & 0xf000) === 0xa000,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 把条目名规范化成安全的相对路径；不安全就抛。 */
export function safeEntryPath(name) {
  const unified = String(name).replace(/\\/g, "/").replace(/^\.\//, "");
  if (!unified || unified === "/") return "";
  if (unified.startsWith("/")) throw new Error(`zip 里有绝对路径条目：${name}`);
  if (/^[a-zA-Z]:/.test(unified)) throw new Error(`zip 里有盘符条目：${name}`);
  const parts = unified.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) throw new Error(`zip 里条目试图跳出目录（zip-slip）：${name}`);
  return parts.join("/");
}

/** 取出单个条目的原始字节（处理 stored / deflate）。 */
export function readZipEntry(buffer, entry) {
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length) throw new Error("zip 结构损坏：本地头越界");
  if (buffer.readUInt32LE(offset) !== SIGNATURE_LOCAL) throw new Error("zip 结构损坏：本地头签名不对");
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw new Error("zip 结构损坏：数据越界");
  const raw = buffer.subarray(start, end);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(raw, { maxOutputLength: ZIP_LIMITS.maxFileBytes });
    } catch (error) {
      throw new Error(`解压条目失败（${entry.name}）：${error.message}`);
    }
  }
  throw new Error(`不支持的压缩方式 ${entry.method}（只认 store / deflate）：${entry.name}`);
}

/**
 * 解压到目标目录。
 * @param buffer - zip 的全部字节
 * @param targetDir - 落地目录（会自动创建）
 * @param options - 覆盖 ZIP_LIMITS 里的上限
 * @returns {{ files: Array<{path: string, bytes: number}>, entries: number, totalBytes: number }}
 */
export function extractZip(buffer, targetDir, options = {}) {
  const limits = { ...ZIP_LIMITS, ...options };
  const entries = listZipEntries(buffer);
  if (entries.length > limits.maxEntries) {
    throw new Error(`zip 条目太多（${entries.length} > ${limits.maxEntries}）`);
  }
  const files = [];
  let totalBytes = 0;
  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of entries) {
    if (entry.isSymlink) continue;
    const relative = safeEntryPath(entry.name);
    if (!relative) continue;
    const destination = path.join(targetDir, ...relative.split("/"));
    const inside = path.resolve(destination).startsWith(path.resolve(targetDir) + path.sep);
    if (!inside) throw new Error(`zip 里条目落地越界：${entry.name}`);
    if (entry.isDirectory) {
      fs.mkdirSync(destination, { recursive: true });
      continue;
    }
    const data = readZipEntry(buffer, entry);
    if (data.length > limits.maxFileBytes) {
      throw new Error(`zip 里单个文件太大（${entry.name}：${data.length} 字节）`);
    }
    totalBytes += data.length;
    if (totalBytes > limits.maxTotalBytes) throw new Error("zip 解压后总大小超限");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, data);
    files.push({ path: relative, bytes: data.length });
  }
  return { files, entries: entries.length, totalBytes };
}

/** 只读一眼：解出 package.json 之类的单个小文件（给「预览」用）。 */
export function readZipFile(buffer, wanted) {
  const entries = listZipEntries(buffer);
  const target = entries.find((entry) => safeEntryPath(entry.name) === wanted);
  if (!target) return null;
  return readZipEntry(buffer, target);
}
