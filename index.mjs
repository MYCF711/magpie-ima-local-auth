// magpie / OpenCode provider plugin — ima.copilot 本机客户端版
//
// 九个钩子都在这里装配；协议、模型、登录各自在 src/。
// 入口只导出工厂函数和 _internal（对象，不会被 magpie 当插件调用）。

import {
  BASE,
  CLIENT_VERSION,
  HOST,
  ICON,
  MODELS,
  PROVIDER,
  PROVIDER_NAME,
  REFRESH_LEAD_MS,
  SDK,
  staticModels,
} from "./src/context.mjs"
import {
  ImaError,
  ask,
  initSession,
  readBalance,
  readModels,
  refreshToken,
} from "./src/api.mjs"
import {
  aggregateOpenAI,
  conversationOf,
  errorResponse,
  lastUser,
  streamOpenAI,
  systemText,
  transcript,
} from "./src/chat.mjs"
import { buildModels } from "./src/models.mjs"
import { importLocalLogin, saveSeed } from "./src/login.mjs"

const SESSION_TTL_MS = 30 * 60 * 1000
const ROTATE_AT = 60
const CATALOG_TTL_MS = 10 * 60 * 1000
const AUTH_SKEW_MS = 5 * 60 * 1000

const sessions = new Map()
let catalog = new Map()
let catalogAt = 0
const refreshing = new Map()

const staticIndex = () =>
  new Map(MODELS.map(([id, name, type, modelId, thinking]) => [id, { id, name, type, modelId, thinking }]))

const modelOf = (id) => {
  const clean = String(id ?? "").replace(new RegExp(`^${PROVIDER}/`), "")
  return catalog.get(clean) || staticIndex().get(clean) || null
}

function putSession(key, entry) {
  sessions.set(key, entry)
  if (sessions.size > 256) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) sessions.delete(oldest[0])
  }
}

function getSession(key) {
  const e = sessions.get(key)
  if (!e) return null
  if (Date.now() - e.at > SESSION_TTL_MS) {
    sessions.delete(key)
    return null
  }
  e.at = Date.now()
  return e
}

/** 单飞续期：同一个 refresh token 同时只花一次（ima 的 refresh token 会轮换） */
async function ensureFresh(auth, save) {
  if (!auth?.access) return auth
  const due = !auth.expires || Number(auth.expires) <= Date.now() + AUTH_SKEW_MS
  if (!due) return auth
  const key = String(auth.refresh || auth.access)
  let p = refreshing.get(key)
  if (!p) {
    p = refreshToken(auth)
      .then((n) => {
        const next = { ...auth, access: n.access, refresh: n.refresh, expires: n.expires }
        save?.(next)
        return next
      })
      .finally(() => refreshing.delete(key))
    refreshing.set(key, p)
  }
  return await p
}

async function ensureCatalog(auth) {
  if (!auth?.access) return
  if (Date.now() - catalogAt < CATALOG_TTL_MS) return
  try {
    const rows = await readModels(auth)
    const built = buildModels(rows)
    if (Object.keys(built.models).length) {
      catalog = built.index
      catalogAt = Date.now()
    }
  } catch {
    // 目录拉不到就用静态兜底，不让整张卡片消失
  }
}

function authError(e, message) {
  const err = Object.assign(new Error(message), { signIn: "expired" })
  err.cause = e
  return err
}

/** 选一条 session 路径，失败时按 session/auth 各重试一次 */
async function sendTurn(auth, { model, question, conv, instructions, carried, save }) {
  const key = auth.uid + "|" + (conv || "anon")
  let entry = getSession(key)
  if (entry && entry.turns.length * 2 + 2 > ROTATE_AT) entry = null
  let res
  try {
    if (!entry) {
      const id = await initSession(auth, question)
      const opening = [carried, instructions, question].filter(Boolean).join("\n\n")
      res = await ask(auth, { sessionId: id, question: opening, model })
      entry = { id, turns: [], at: Date.now() }
      putSession(key, entry)
    } else {
      res = await ask(auth, { sessionId: entry.id, question, model })
    }
  } catch (e) {
    if (!(e instanceof ImaError)) throw e
    if (e.auth) {
      const next = await refreshToken(auth)
      save?.({ ...auth, access: next.access, refresh: next.refresh, expires: next.expires })
      return await sendTurn({ ...auth, ...next }, { model, question, conv, instructions, carried, save })
    }
    if (e.session) {
      sessions.delete(key)
      const id = await initSession(auth, question)
      const opening = [carried, instructions, question].filter(Boolean).join("\n\n")
      res = await ask(auth, { sessionId: id, question: opening, model })
      entry = { id, turns: [], at: Date.now() }
      putSession(key, entry)
    } else {
      throw e
    }
  }
  entry.turns.push({ q: question })
  return { res, entry }
}

export const ImaLocalAuthPlugin = async ({ client } = {}) => {
  const log = (message, level = "info") => {
    try {
      client?.app?.log?.({ service: PROVIDER, level, message })
    } catch {}
  }

  const saveAuth = async (auth) => {
    try {
      await client?.auth?.set?.({
        path: { id: PROVIDER },
        body: {
          ...auth,
          access: auth.access,
          refresh: auth.refresh,
          expires: auth.expires,
        },
      })
    } catch {}
  }

  const readBody = async (body, req) => {
    if (body == null && req) return await req.clone().text()
    if (body == null) return ""
    if (typeof body === "string") return body
    if (body instanceof Uint8Array) return new TextDecoder().decode(body)
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body))
    if (typeof body?.getReader === "function") {
      const reader = body.getReader()
      const chunks = []
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) chunks.push(value)
      }
      const total = chunks.reduce((n, c) => n + c.byteLength, 0)
      const out = new Uint8Array(total)
      let at = 0
      for (const c of chunks) {
        out.set(c, at)
        at += c.byteLength
      }
      return new TextDecoder().decode(out)
    }
    if (typeof body?.text === "function") return await body.text()
    return String(body)
  }

  const handleChat = async (getAuth, { headers: rawHeaders, body }) => {
    let auth = await getAuth()
    if (!auth?.access) return errorResponse(401, "ima 未登录：先在 magpie 里点登录", { signIn: "expired" })
    try {
      auth = await ensureFresh(auth, saveAuth)
    } catch (e) {
      return errorResponse(401, `ima 续期失败：${e?.message ?? e}`, { signIn: "expired" })
    }
    await ensureCatalog(auth)

    const headers = new Headers(rawHeaders ?? {})
    const sessionId = String(headers.get("x-magpie-ima-session") ?? "").slice(0, 160)

    let chat = null
    try {
      chat = typeof body === "string" ? JSON.parse(body) : body
    } catch {
      chat = null
    }
    if (!chat || !Array.isArray(chat.messages)) {
      return errorResponse(400, "ima: 这个请求不是 chat.completions 形状")
    }

    const model = modelOf(chat.model)
    if (!model) {
      return errorResponse(404, `ima: 没有模型 ${String(chat.model ?? "")}`, {})
    }
    const { text, index } = lastUser(chat.messages)
    if (!text) return errorResponse(400, "ima: 这轮没有 user 消息", {})
    const instructions = systemText(chat.messages)
    const carried = transcript(chat.messages, index)
    const conv = conversationOf(chat.messages, sessionId)

    try {
      const { res } = await sendTurn(auth, { model, question: text, conv, instructions, carried, save: saveAuth })
      const modelId = model.id
      if (chat.stream === false) {
        const data = await aggregateOpenAI(res, modelId)
        return new Response(JSON.stringify(data), { headers: { "content-type": "application/json; charset=utf-8" } })
      }
      return streamOpenAI(res, modelId)
    } catch (e) {
      if (e instanceof ImaError && e.auth) {
        return errorResponse(401, `ima 登录被拒：${e.message}`, { signIn: "expired" })
      }
      return errorResponse(502, `ima: ${e?.message ?? e}`, {})
    }
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: SDK,
        api: BASE,
        models: staticModels(),
      }
    },

    "chat.headers": async (input, output) => {
      const id = input?.model?.providerID ?? input?.provider?.info?.id
      if (id !== PROVIDER || !input?.sessionID) return
      output.headers["x-magpie-ima-session"] = String(input.sessionID).slice(0, 160)
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const fallback = staticModels()
        if (!auth?.access) {
          catalog = staticIndex()
          return fallback
        }
        try {
          const fresh = await ensureFresh(auth, saveAuth)
          const rows = await readModels(fresh)
          const built = buildModels(rows)
          if (!Object.keys(built.models).length) return fallback
          catalog = built.index
          catalogAt = Date.now()
          return built.models
        } catch (e) {
          if (e instanceof ImaError && e.auth) {
            throw authError(e, "ima 登录已失效，请重新登录")
          }
          return fallback
        }
      },
    },

    auth: {
      provider: PROVIDER,
      icon: ICON,
      maxConcurrency: 2,
      refreshLead: REFRESH_LEAD_MS,
      single: true,

      methods: [
        {
          type: "oauth",
          label: "Use ima.copilot on this machine",
          async authorize() {
            return {
              url: HOST,
              instructions:
                "本机已登录的 ima.copilot 会提供登录态；点击继续，插件会读取并保存它。",
              method: "auto",
              opened: true,
              async callback() {
                try {
                  const state = importLocalLogin()
                  if (!state) {
                    return {
                      type: "failed",
                      error:
                        "没找到本机 ima.copilot 的登录态。请先打开 ima.copilot 登录；若刚退出过，再打开它一次，然后重试。",
                    }
                  }
                  saveSeed(state)
                  return {
                    type: "success",
                    access: state.access,
                    refresh: state.refresh,
                    expires: state.expires,
                    uid: state.uid,
                    guid: state.guid,
                    q36: state.q36,
                    iua: state.iua,
                    idType: state.idType,
                    tokenType: state.tokenType,
                    extensionVersion: state.extensionVersion,
                    accountId: state.accountId,
                  }
                } catch (e) {
                  return { type: "failed", error: `读取 ima 登录态失败：${e?.message ?? e}` }
                }
              },
            }
          },
        },
      ],

      async refresh(auth) {
        try {
          const next = await refreshToken(auth)
          return { access: next.access, refresh: next.refresh, expires: next.expires }
        } catch (e) {
          if (e instanceof ImaError && e.auth) throw authError(e, "ima 登录已失效，请重新登录")
          throw e
        }
      },

      async loader(getAuth) {
        return {
          baseURL: BASE,
          apiKey: "",
          headers: {},
          async fetch(input, init) {
            const req = input instanceof Request ? input : null
            const headers = new Headers(init?.headers ?? req?.headers ?? {})
            const body = await readBody(init?.body, req)
            return await handleChat(getAuth, { headers, body })
          },
        }
      },

      async usage(getAuth) {
        try {
          let auth = await getAuth()
          if (!auth?.access) return { error: "ima 未登录", windows: [] }
          auth = await ensureFresh(auth, saveAuth)
          const b = await readBalance(auth)
          const amount = b.display_amount ?? b.balance ?? b.display_activity_amount ?? 0
          return {
            plan: "ima",
            user: String(auth.uid || ""),
            balance: `${amount} 算力`,
            windows: [],
          }
        } catch (e) {
          if (e instanceof ImaError && e.auth) return { error: "ima 登录已失效", signIn: "expired", windows: [] }
          return { error: `ima: ${e?.message ?? e}`, windows: [] }
        }
      },

      async checkin() {
        return { outcome: "inactive", message: "ima 没有每日签到" }
      },
    },
  }
}

export const _internal = {
  PROVIDER,
  BASE,
  MODELS,
  staticModels,
  modelOf,
  ensureFresh,
  SESSION_TTL_MS,
  ROTATE_AT,
  CLIENT_VERSION,
  ImaError,
}
