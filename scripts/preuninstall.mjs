#!/usr/bin/env node
/**
 * 卸载钩子：把搬进插件库的 skill 与 MCP 配置原样放回去，并摘掉 profile 接线。
 *
 * 顺序：先还原文件（否则数据目录可能被一起删掉），再摘 insert/bundles。
 */
import path from "node:path";
import process from "node:process";
import { Store, defaultDataDir } from "../lib/store.js";
import { restoreMcpProfiles, restoreSkillUnits } from "../lib/migrate.js";
import {
  isProfileDir,
  listProfiles,
  removeProfileBodyInsert,
  removeProfileBundles,
  removeProfileLink,
} from "../lib/profile.js";
import { dshHome, errorMessage } from "../lib/util.js";

function main() {
  const dataDir = process.env.DSH_LAZY_TOOLBOX_DIR
    ? path.resolve(process.env.DSH_LAZY_TOOLBOX_DIR)
    : defaultDataDir();
  const store = new Store(dataDir);
  const log = (line) => process.stdout.write(`dsh-lazy-toolbox: ${line}\n`);
  try {
    const skills = restoreSkillUnits({ store, logger: { info: log } });
    for (const item of skills) {
      log(`skill ${item.name}: ${item.ok ? "restored" : `skipped (${item.reason})`}`);
    }
    const mcp = restoreMcpProfiles({ store, logger: { info: log } });
    for (const item of mcp) log(`profile ${item.profile}: ${item.restored} MCP rows restored`);
    for (const dir of listProfiles(dshHome()).filter(isProfileDir)) {
      const insert = removeProfileBodyInsert(dir);
      const bundle = removeProfileBundles(dir);
      const link = removeProfileLink(dir);
      if (insert.removed || bundle.removed || link.removed) {
        log(`profile ${dir}: unwired (insert=${insert.removed}, bundle=${bundle.removed}, link=${link.removed})`);
      }
    }
    log("还原完成；重启 dsh 后 MCP 行重新生效。");
  } catch (error) {
    process.stderr.write(`dsh-lazy-toolbox: 还原失败：${errorMessage(error)}\n`);
  }
}

main();
