#!/usr/bin/env node
// 从 ima.copilot 的 profile 导入登录态，写成插件种子文件。
//
//   node scripts/import-login.mjs --profile "<ima 的 User Data 目录>"
//   node scripts/import-login.mjs --prefs "<.../Default/Preferences>"
//
// 只打印账号与有效期，不打印 token。

import { existsSync } from "node:fs"
import { join } from "node:path"
import { loginFromPreferences, SEED_FILE, saveSeed } from "../src/login.mjs"

const argv = process.argv.slice(2)
const get = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : ""
}
const prefsArg = get("--prefs")
const profileArg = get("--profile")
const prefs = prefsArg || (profileArg ? [join(profileArg, "Default", "Preferences"), join(profileArg, "Preferences")].find((p) => existsSync(p)) : "")
if (!prefs) {
  console.error("用法：node scripts/import-login.mjs --profile \"<ima 的 User Data 目录>\"")
  process.exit(1)
}
if (!existsSync(prefs)) {
  console.error(`找不到 Preferences：${prefs}`)
  process.exit(1)
}
try {
  const state = loginFromPreferences(prefs)
  if (!state) {
    console.error("这个 profile 没有 tencent.wxlogin 登录凭证。先在 ima.copilot 里登录，再退出一次。")
    process.exit(1)
  }
  const ok = saveSeed(state)
  console.log(JSON.stringify({
    imported: true,
    seed: SEED_FILE,
    saved: ok,
    uid: state.uid,
    account: state.accountId,
    expiresAt: new Date(state.expires).toISOString(),
    hasRefresh: Boolean(state.refresh),
  }, null, 2))
} catch (e) {
  console.error(`导入失败：${e?.message ?? e}`)
  process.exit(1)
}
