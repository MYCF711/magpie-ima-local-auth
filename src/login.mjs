// src/login.mjs —— 从本机 ima.copilot 客户端导入登录态
//
// ima 把登录态放在两个地方：
//   1. 正在运行的客户端内存里（native bridge，官方前端用 chrome.imaFrame 读它）；
//   2. 客户端正常退出时，把账号凭证写进 profile 的 Preferences
//      （tencent.wxlogin.account_secret_encrypted，DPAPI 加密）。
//
// 这个文件读第 2 种，外加一个可选的明文 JSON 种子文件（IMA_COPILOT_LOGIN_FILE）。
// 不读进程内存、不开 CDP、不要求用户粘贴 cookie。
//
// ⚠ 这里会碰到 token 明文。绝不 console.log / 写进错误消息。

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import { join, delimiter } from "node:path"
import { CLIENT_VERSION } from "./context.mjs"

const CACHE_DIR = join(homedir(), ".cache", "magpie", "ima-local-auth")
export const SEED_FILE = join(CACHE_DIR, "login.json")

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

const number = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * DPAPI 解密（Windows 当前用户）。account_secret_encrypted 是 base64 的
 * CryptProtectData 输出；解出来是 { token, refresh_token, token_valid_time,
 * refresh_token_valid_time } 的 JSON。
 */
export function dpapiDecrypt(base64) {
  if (process.platform !== "win32") throw new Error("ima 的账号凭证解密目前只支持 Windows")
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$b=[Convert]::FromBase64String($env:IMA_SECRET_B64)",
    "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')",
    "[Convert]::ToBase64String($p)",
  ].join("; ")
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    env: { ...process.env, IMA_SECRET_B64: base64 },
  })
  const line = String(out ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .pop()
  if (!line) throw new Error("DPAPI 解密没有输出")
  return Buffer.from(line, "base64").toString("utf8")
}

/** 把 Preferences 里的 wxlogin 段变成插件要的登录态 */
export function loginFromPreferences(prefsPath) {
  const prefs = readJson(prefsPath)
  const wx = prefs?.tencent?.wxlogin
  if (!wx?.account_secret_encrypted) return null
  const meta = (() => {
    try {
      return JSON.parse(wx.account_meta || "{}")
    } catch {
      return {}
    }
  })()
  const secret = JSON.parse(dpapiDecrypt(String(wx.account_secret_encrypted)))
  const q36 = (() => {
    const groups = prefs?.sync?.transport_data_per_account
    if (!groups || typeof groups !== "object") return ""
    for (const v of Object.values(groups)) {
      if (v && typeof v === "object" && v["sync.cache_guid"]) return String(v["sync.cache_guid"])
    }
    return ""
  })()
  return normalize({
    ...secret,
    uid: meta.user_id,
    id_type: meta.id_type,
    token_type: meta.token_type,
    guid: meta?.user_info?.open_info?.guid,
    q36,
    accountId: meta?.user_info?.open_info?.nickname || "ima.copilot",
    extensionVersion: extensionVersionOf(prefsPath) || CLIENT_VERSION,
    source: prefsPath,
  })
}

/** 同目录的 Secure Preferences 里，copilot-v2 扩展的版本 */
function extensionVersionOf(prefsPath) {
  try {
    const secure = join(prefsPath, "..", "Secure Preferences")
    const d = readJson(secure)
    const settings = d?.extensions?.settings
    if (!settings) return ""
    for (const [id, v] of Object.entries(settings)) {
      const name = String(v?.manifest?.name ?? "")
      if (id === "ebbbfiigemhmjadjbckcodajdmnceamb" || /copilot/i.test(name)) {
        const ver = String(v?.manifest?.version ?? "")
        if (ver) return ver
      }
    }
  } catch {
    // 读不到就用默认版本
  }
  return ""
}

/** 候选种子文件（明文 JSON） */
function seedPaths() {
  const out = []
  if (process.env.IMA_COPILOT_LOGIN_FILE) out.push(process.env.IMA_COPILOT_LOGIN_FILE)
  out.push(SEED_FILE, join(homedir(), ".config", "magpie", "ima-local-auth", "login.json"))
  return out
}

/** 候选 profile 目录（每个目录下找 Default/Preferences 或 Preferences） */
function profileDirs() {
  const out = []
  const env = process.env.IMA_COPILOT_PROFILE_DIRS
  if (env) out.push(...env.split(delimiter).map((s) => s.trim()).filter(Boolean))
  const local = process.env.LOCALAPPDATA
  if (local) {
    out.push(join(local, "ima.copilot", "User Data"))
    // 某些安装会多一个 Application 子目录；Preferences 仍然在 User Data 下。
    out.push(join(local, "ima.copilot", "User Data", "Default"))
  }
  out.push(join(CACHE_DIR, "profile"))
  return [...new Set(out)]
}

function preferencesIn(dir) {
  for (const p of [join(dir, "Default", "Preferences"), join(dir, "Preferences")]) {
    if (existsSync(p)) return p
  }
  return ""
}

/** 登录态归一化：返回插件内部形状（expires 用毫秒时间戳） */
export function normalize(raw) {
  if (!raw || typeof raw !== "object") return null
  const access = String(raw.access ?? raw.token ?? "")
  const refresh = String(raw.refresh ?? raw.refresh_token ?? "")
  if (!access) return null
  let expires = number(raw.expires)
  if (!expires) {
    const t = number(raw.token_valid_time)
    if (t > 1e12) expires = t
    else if (t > 1e9) expires = t * 1000
    else if (t > 0) expires = Date.now() + t * 1000
  }
  if (!expires) expires = Date.now() + 7200 * 1000
  const uid = String(raw.uid ?? raw.user_id ?? "")
  return {
    access,
    refresh,
    expires,
    uid,
    idType: String(raw.idType ?? raw.id_type ?? ""),
    tokenType: String(raw.tokenType ?? raw.token_type ?? ""),
    guid: String(raw.guid ?? ""),
    q36: String(raw.q36 ?? ""),
    iua: String(raw.iua ?? ""),
    extensionVersion: String(raw.extensionVersion ?? raw.extension_version ?? CLIENT_VERSION),
    accountId: String(raw.accountId ?? uid ?? "ima.copilot"),
    nickname: String(raw.nickname ?? ""),
    source: String(raw.source ?? ""),
  }
}

/**
 * 找一个能用的登录态：种子文件 → 本机 ima profile。
 * @returns {object|null}
 */
export function importLocalLogin() {
  for (const file of seedPaths()) {
    if (!file || !existsSync(file)) continue
    const state = normalize(readJson(file))
    if (state) return state
  }
  for (const dir of profileDirs()) {
    const prefs = preferencesIn(dir)
    if (!prefs) continue
    try {
      const state = loginFromPreferences(prefs)
      if (state) return state
    } catch {
      // 这个 profile 没登录 / 解密失败：试下一个
    }
  }
  return null
}

/** 把登录态写成种子文件（600），供下次登录导入。 */
export function saveSeed(state) {
  if (!state?.access) return false
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(
      SEED_FILE,
      JSON.stringify(
        {
          access: state.access,
          refresh: state.refresh,
          expires: state.expires,
          uid: state.uid,
          id_type: state.idType,
          token_type: state.tokenType,
          guid: state.guid,
          q36: state.q36,
          iua: state.iua,
          extensionVersion: state.extensionVersion,
          accountId: state.accountId,
          nickname: state.nickname,
          savedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    )
    try {
      chmodSync(SEED_FILE, 0o600)
    } catch {}
    return true
  } catch {
    return false
  }
}

export const _loginInternal = { CACHE_DIR, SEED_FILE, seedPaths, profileDirs, preferencesIn }
