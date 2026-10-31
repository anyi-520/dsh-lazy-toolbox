import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../lib/store.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("两个 Store 指向同一目录时，后写的能被先写的看到", async () => {
  const dir = path.join(tempDir("lazy-store-fresh-"), "data");
  const a = new Store(dir);
  const b = new Store(dir);
  assert.equal(a.listServers().length, 0);

  b.putServer("demo", { summary: "第一版", transport: "stdio", command: "node", args: [], env: {} });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(a.listServers().length, 1, "另一进程写入后应该刷新可见");
  assert.equal(a.getServer("demo").summary, "第一版");

  b.putServer("demo", { ...b.getServer("demo"), summary: "第二版" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(a.getServer("demo").summary, "第二版", "内容更新也要能看到");

  b.dropServer("demo");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(a.listServers().length, 0, "删除也要能看到");
});

test("store.json 不存在时读成空库，不抛异常", () => {
  const dir = path.join(tempDir("lazy-store-missing-"), "nope");
  const store = new Store(dir);
  assert.deepEqual(store.listSkills(), []);
  assert.deepEqual(store.listServers(), []);
});
