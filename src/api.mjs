// src/api.mjs —— 打 ima 的 CGI 接口，只有这一层知道它的形状
//
// ima 的所有接口都是 HTTPS + 私有 JSON 信封：HTTP 200 里再包一层 code/msg。
// 登录失效是 200 + code 41/600001；session 失效是 code 5/51。
// 这一层把所有网络与错误语义收在一处，钩子层不再判断 code。

import { randomUUID } from "node:crypto"
import { BASE, CLIENT_TYPE, CLIENT_VERSION, HOST, IMA_APP_VERSION, IMA_CHROMIUM_VERSION } from "./context.mjs"

export const AUTH_CODES = new Set([41, 600001])
export const SESSION_CODES = new Set([5, 51])
export const BUSY_CODE = 3
export const NOT_ALLOWED_CODE = 1411

const TIMEOUT = { short: 15_000, long: 30_000, qa: 10 * 60_000 }

export class ImaError extends Error {
  constructor(message, { code = 0, status = 0 } = {}) {
    super(message)
    this.name = "ImaError"
    this.code = Number(code) || 0
    this.status = Number(status) || 0
    this.auth = AUTH_CODES.has(this.code) || status === 401 || status === 403
    this.session = SESSION_CODES.has(this.code) || this.auth
  }
}

const truncate = (s, n = 240) => String(s ?? "").replace(/\s+/g, " ").slice(0, n)

/** ima 的 x-ima-bkn：djb2 变体，由 IMA-TOKEN 派生，必须每次算，不能抄 */
export function bkn(token) {
  let h = 5381
  const t = String(token ?? "")
  for (let i = 0; i < t.length; i++) h += (h << 5) + t.charCodeAt(i)
  return String(h & 0x7fffffff)
}

/**
 * IMA-IUA 是 app 自己拼的 QUA。实测只要格式对，服务端就会按真实账号目录回答；
 * 缺了它整套请求会被当成匿名（模型目录退回默认、问答不返回正文）。
 * 所以这里永远给一个最小 QUA，不依赖 profile 里能不能读到。
 */
export function defaultIua() {
  const platform = process.platform === "darwin" ? "MAC" : "WIN"
  const app = process.env.IMA_APP_VERSION || IMA_APP_VERSION
  const chrome = process.env.IMA_CHROMIUM_VERSION || IMA_CHROMIUM_VERSION
  return `PR=IMA&PP=com.tencent.imawin&PPVN=${app}&PL=${platform}&COVC=${chrome}&EV=`
}

/** 拼 x-ima-cookie。空字段不出现（ima 对空字段比缺字段更敏感） */
export function cookieFor(auth, clientType = auth?.clientType || process.env.IMA_CLIENT_TYPE || CLIENT_TYPE) {
  const fields = {
    PLATFORM: "H5",
    "CLIENT-TYPE": clientType,
    "WEB-VERSION": String(auth?.extensionVersion || CLIENT_VERSION),
    "IMA-GUID": String(auth?.guid || ""),
    "IMA-Q36": String(auth?.q36 || ""),
    "IMA-IUA": String(auth?.iua || defaultIua()),
    "IMA-UID": String(auth?.uid || ""),
    "IMA-TOKEN": String(auth?.access || ""),
    "IMA-REFRESH-TOKEN": String(auth?.refresh || ""),
    "UID-TYPE": String(auth?.idType || ""),
    "TOKEN-TYPE": String(auth?.tokenType || ""),
  }
  return Object.entries(fields)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("; ")
}

/** 伪装 ima 自己的客户端请求头；其余由调用方补 content-type / accept */
export function headersFor(auth, { sse = false, accept } = {}) {
  const token = String(auth?.access || "")
  return {
    "x-ima-cookie": cookieFor(auth),
    from_browser_ima: "1",
    extension_version: String(auth?.extensionVersion || CLIENT_VERSION),
    "x-ima-bkn": bkn(token),
    "content-type": "application/json; charset=utf-8",
    accept: accept || (sse ? "text/event-stream" : "application/json"),
    "user-agent": "okhttp/4.12.0",
    origin: HOST,
    referer: HOST + "/",
  }
}

function envelope(text, status, url) {
  let env = null
  try {
    env = JSON.parse(text)
  } catch {
    env = null
  }
  if (!env || typeof env !== "object") {
    throw new ImaError(`ima: ${url} 返回的不是 JSON（${String(text).slice(0, 160)}）`, { status })
  }
  const code = Number(env.code ?? env.Code ?? 0)
  if (code !== 0) {
    throw new ImaError(`ima: ${env.msg || env.Msg || "code " + code}（${code}）`, { code, status })
  }
  return env
}

/** 一个 JSON POST，统一处理 HTTP 与业务 code */
export async function postJson(path, body, auth, { timeout = TIMEOUT.short, url } = {}) {
  const target = url ?? `${BASE}/${String(path).replace(/^\/+/, "")}`
  const res = await fetch(target, {
    method: "POST",
    headers: headersFor(auth),
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  if (!res.ok) {
    const code = (() => {
      try {
        const j = JSON.parse(text)
        return Number(j?.code ?? j?.Code ?? 0) || res.status
      } catch {
        return res.status
      }
    })()
    throw new ImaError(`ima: HTTP ${res.status} ${truncate(text) || ""}`.trim(), { code, status: res.status })
  }
  return envelope(text, res.status, target)
}

/** 一个 SSE POST，返回未读的 Response；文本由 chat.mjs 读 */
export async function postSSE(path, body, auth, { timeout = TIMEOUT.qa } = {}) {
  const target = `${BASE}/${String(path).replace(/^\/+/, "")}`
  const res = await fetch(target, {
    method: "POST",
    headers: headersFor(auth, { sse: true }),
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new ImaError(`ima: HTTP ${res.status} ${truncate(text)}`, { code: res.status, status: res.status })
  }
  return res
}

/** 换一个新 access token。refresh_token 是长效的（约一年）。 */
export async function refreshToken(auth) {
  const refresh = String(auth?.refresh || "")
  if (!refresh) throw new ImaError("ima 的登录态没有 refresh_token", { code: 41, status: 200 })
  const env = await postJson(
    "auth_login/refresh",
    { refresh_token: refresh, user_id: String(auth?.uid || ""), registration_id: "" },
    { ...auth, access: auth.access || refresh },
    { timeout: TIMEOUT.short, url: `${HOST}/auth_login/refresh` },
  )
  const token = String(env.token || env.Token || "")
  if (!token) throw new ImaError("ima 的续期没有返回 token", { code: 41, status: 200 })
  const rawTtl = Number(env.token_valid_time ?? env.TokenValidTime ?? 0) || 7200
  // 实测 /auth_login/refresh 给的是相对秒数 7200；万一是绝对时间也能认
  const expires = rawTtl > 1e12 ? rawTtl : rawTtl > 1e9 ? rawTtl * 1000 : Date.now() + rawTtl * 1000
  return {
    access: token,
    refresh: String(env.refresh_token || env.RefreshToken || refresh),
    expires,
  }
}

/** 账号自己的模型目录（免费知识库机器人那一套） */
export async function readModels(auth) {
  const env = await postJson("model_manage/get_models", {}, auth, { timeout: TIMEOUT.short })
  return Array.isArray(env.models) ? env.models : []
}

/** 算力余额（Copilot 用；免费模型不扣） */
export async function readBalance(auth) {
  return await postJson("token_manager/get_balance", {}, auth, { timeout: TIMEOUT.short })
}

/** 开一个普通问答 session（robot_type 10000 = Main，不是 Copilot 的 15） */
export async function initSession(auth, name) {
  const env = await postJson(
    "session_logic/init_session",
    {
      env_info: { interact_type: 2, robot_type: 10000 },
      name: String(name ?? "").trim().slice(0, 50) || "新对话",
      msgs_limit: 20,
    },
    auth,
    { timeout: TIMEOUT.short },
  )
  const id = String(env.session_id || env.sessionId || env.data?.session_id || "")
  if (!id) throw new ImaError("ima: init_session 没有返回 session_id", { code: 0, status: 200 })
  return id
}

/** 一问一答（SSE）；model 是 {type, modelId} */
export async function ask(auth, { sessionId, question, model }) {
  const body = {
    session_id: sessionId,
    robot_type: 10000,
    question: String(question ?? ""),
    question_type: 2,
    command_info: { question_info: {} },
    client_id: randomUUID(),
    model_info: {
      model_type: Number(model?.type ?? 0),
      model_id: String(model?.modelId ?? ""),
      enable_enhancement: false,
    },
  }
  return await postSSE("assistant/qa", body, auth, { timeout: TIMEOUT.qa })
}

export const _apiInternal = { TIMEOUT, truncate, envelope }
