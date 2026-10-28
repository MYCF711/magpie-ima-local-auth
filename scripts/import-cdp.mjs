#!/usr/bin/env node
// 从正在运行的 ima.copilot（带 CDP 端口）导入登录态 —— CDP + native bridge 路径。
//
//   node scripts/import-cdp.mjs --port 9222
//
// 它做的事：
//   1. 连 http://127.0.0.1:<port>/json，找 chrome://home/ 页面
//   2. 在该页面里执行 chrome.imaFrame.invokeWithCallback({action:'getAccountInfo'})
//      和 getDeviceInfo —— 和 ima 官方前端完全同一条 native bridge
//   3. 把 token / refresh_token / uid / guid / QUA 写成种子文件
//
// 这个脚本用于：profile 里还没有 tencent.wxlogin 凭证，但客户端正开着调试端口。
// 只打印账号与有效期，不打印 token。

import { saveSeed, SEED_FILE } from "../src/login.mjs"
import { CLIENT_TYPE } from "../src/context.mjs"

const argv = process.argv.slice(2)
const get = (name, fallback = "") => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}
const port = Number(get("--port", "9222"))
if (!Number.isFinite(port) || port <= 0) {
  console.error("用法：node scripts/import-cdp.mjs --port 9222")
  process.exit(1)
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const target = targets.find((t) => t.url === "chrome://home/") || targets.find((t) => t.type === "page")
if (!target?.webSocketDebuggerUrl) {
  console.error(`端口 ${port} 上没有 ima 的 chrome://home/ 页面。确认客户端用 --remote-debugging-port=${port} 启动。`)
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
const cmd = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const evaluate = async (expression) => {
  const r = await cmd("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text)
  return r.result?.result?.value
}

const raw = await evaluate(`(async () => {
  const invoke = (action, params = {}) => new Promise((resolve) => {
    const bridge = globalThis.chrome && globalThis.chrome.imaFrame
    if (!bridge || !bridge.invokeWithCallback) return resolve({ code: -1, msg: "imaFrame unavailable", data: "" })
    const timer = setTimeout(() => resolve({ code: 996, msg: "timeout", data: "" }), 10000)
    bridge.invokeWithCallback({ action, params: JSON.stringify(params) }, (r) => {
      clearTimeout(timer)
      resolve(r || {})
    })
  })
  const parse = (r) => { try { return typeof r.data === "string" ? JSON.parse(r.data || "{}") : (r.data || {}) } catch { return {} } }
  const account = parse(await invoke("getAccountInfo"))
  const device = parse(await invoke("getDeviceInfo"))
  const version = chrome.runtime.getManifest().version
  return JSON.stringify({ account, device, version })
})()`)
ws.close()

const { account, device, version } = JSON.parse(raw)
if (!account?.is_login || !account?.token) {
  console.error("这个 ima.copilot 页面没有登录：先在客户端里登录，再重试。")
  process.exit(1)
}
const state = {
  access: account.token,
  refresh: account.refresh_token,
  expires: Number(account.token_valid_time) * 1000,
  uid: account.user_id,
  idType: String(account.id_type ?? ""),
  tokenType: String(account.token_type ?? ""),
  guid: device?.guid || "",
  q36: device?.q36 || "",
  iua: device?.qua || "",
  extensionVersion: version,
  clientType: process.env.IMA_CLIENT_TYPE || CLIENT_TYPE,
  accountId: account?.user_info?.open_info?.nickname || "ima.copilot",
  nickname: account?.user_info?.open_info?.nickname || "",
  source: `cdp:${port}`,
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
