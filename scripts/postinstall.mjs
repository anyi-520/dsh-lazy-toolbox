#!/usr/bin/env node
/**
 * 安装钩子：把插件接进 profile。
 *
 * pnpm / dsh plugin add 只会装包，不会替我们写 profile 的 bundles 与 insert 行，
 * 这里补上；重复执行是幂等的。
 */
import fs from "node:fs";
import path from "node:path";
import { ensureProfileBodyInsert, ensureProfileBundles, ensureProfileLink, isProfileDir } from "../lib/profile.js";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function findProfileDir() {
  const seeds = [process.env.INIT_CWD, process.env.npm_config_local_prefix, process.cwd()].filter(Boolean);
  for (const seed of seeds) {
    let dir = path.resolve(seed);
    for (let depth = 0; depth < 8; depth += 1) {
      if (isProfileDir(dir)) return dir;
      const pkg = readJson(path.join(dir, "package.json"));
      if (pkg?.name === "dsh-lazy-toolbox") {
        // 从插件自己的 node_modules 位置往上找 profile
        for (let up = dir; depth < 10; up = path.dirname(up)) {
          if (path.basename(up) === "node_modules") {
            const parent = path.dirname(up);
            if (isProfileDir(parent)) return parent;
          }
          if (path.dirname(up) === up) break;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return "";
}

function main() {
  const profileDir = findProfileDir();
  if (!profileDir) {
    process.stdout.write("dsh-lazy-toolbox: 没找到 dsh profile，跳过自动接线（可手动运行 `dsh-lazy-toolbox wire-profile`）\n");
    return;
  }
  const bundles = ensureProfileBundles(profileDir);
  const insert = ensureProfileBodyInsert(profileDir);
  const link = ensureProfileLink(profileDir);
  process.stdout.write(
    `dsh-lazy-toolbox: profile=${profileDir} bundle=${bundles.wrote ? "written" : "present"} insert=${insert.wrote ? "written" : "present"} link=${link.ok ? (link.wrote ? "created" : "present") : `failed(${link.reason})`}\n`,
  );
  process.stdout.write("dsh-lazy-toolbox: 重启 dsh 后生效；首次启动会自动迁移本机 skill 与 MCP 配置。\n");
}

main();
