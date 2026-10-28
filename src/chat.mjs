// src/chat.mjs —— OpenAI Chat Completions 与 ima 单问 session 之间的翻译
//
// ima 的真实形状（2026-10-28 实测）：
//   MESSAGE  {"Text":"..."}        ← 正文增量，直接拼
//   THINKING {"Message":"...","Status":1}  ← 思考增量；Status:2 是结束标记
//   COMPLETED{"Code":0,...}        ← 业务码在 200 的 body 里
//   SUGGEST_QUESTION [...]         ← 不是答案，必须忽略
//   HEARTBEAT / QA_START / SESSION_START / CLOSE
//
// 这里不读 token 计数：ima 不返回 usage。宁可写 0，也不按字符数编。

import { randomBytes } from "node:crypto"

const TEXT_KEYS = ["Text", "text", "Content", "content", "Delta", "delta", "Message", "msg", "answer", "Answer"]
const CONTROL = new Set(["COMPLETED", "CLOSE", "INNER_EXCEPTION", "ERROR", "FAILED"])

export function partText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content == null ? "" : String(content)
  return content
    .map((p) => {
      if (typeof p === "string") return p
      if (p?.type === "text" || p?.type === "input_text") return p.text ?? ""
      if (p?.type === "image_url" || p?.type === "image") return "[一张图片；ima 的免费模型看不到图]"
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

/**
 * DSH 把 AGENTS.md、运行时上下文、技能目录作为 **user 消息** 追加在真正的任务后面。
 * 这些不是问题；如果把它们当最后一问，ima 会回答“技能目录里没有任务”。
 * 供应商插件要的是模型级体验，所以把它们从问题/历史里滤掉。
 */
export function isContextMessage(m) {
  const text = partText(m?.content).trim()
  return (
    text.startsWith("<system-reminder>") ||
    text.startsWith("Current runtime context.") ||
    text.includes("<available_skills>") ||
    text.includes("The following workspace instructions are relevant")
  )
}

export function systemText(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => (m?.role === "system" || m?.role === "developer") && !isContextMessage(m))
    .map((m) => partText(m?.content))
    .filter(Boolean)
    .join("\n\n")
}

/** 最后一条有文字的 user 消息；工具回执不是问题 */
export function lastUser(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m?.role !== "user" || isContextMessage(m)) continue
    const text = partText(m?.content).trim()
    if (text) return { text, index: i }
  }
  return { text: "", index: -1 }
}

/** 新 session 时带上之前几轮，避免 TTL/重启后上下文全丢 */
export function transcript(messages, lastIndex, limit = 6) {
  const list = Array.isArray(messages) ? messages.slice(0, Math.max(0, lastIndex)) : []
  const turns = []
  for (const m of list) {
    if (m?.role !== "user" && m?.role !== "assistant") continue
    if (isContextMessage(m)) continue
    const text = partText(m?.content).trim()
    if (!text) continue
    turns.push({ role: m.role, text: text.slice(0, 2000) })
  }
  const kept = turns.slice(-limit)
  if (!kept.length) return ""
  return (
    "以下是本次对话之前的内容，供你参考：\n\n" +
    kept.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n\n") +
    "\n\n现在回答新的问题。"
  )
}

/** 一个对话的稳定 id：magpie 的 sessionID 优先，否则第一条 user 文本 */
export function conversationOf(messages, sessionId) {
  if (sessionId) return "session:" + String(sessionId).slice(0, 160)
  const list = Array.isArray(messages) ? messages : []
  const first = list.find((m) => m?.role === "user" && !isContextMessage(m) && partText(m?.content).trim())
  return first ? "first:" + partText(first.content).trim().slice(0, 400) : ""
}

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v)

function firstText(candidates) {
  for (const cand of candidates) {
    if (!isObject(cand)) continue
    for (const k of TEXT_KEYS) {
      const v = cand[k]
      if (typeof v === "string" && v) return v
    }
  }
  return ""
}

export function eventObject(raw) {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return isObject(v) ? v : null
  } catch {
    return null
  }
}

/** MESSAGE 的正文；THINKING 的 Message 不在这里读 */
export function eventText(raw) {
  const doc = eventObject(raw)
  if (!doc) return ""
  const candidates = [doc]
  const data = doc.Data ?? doc.data
  if (isObject(data)) {
    candidates.push(data)
    const tm = data.text_message ?? data.textMessage
    if (isObject(tm)) candidates.push(tm)
  }
  return firstText(candidates)
}

/** THINKING 的思考文本；Status:2 / 空 Message 是结束标记 */
export function eventThinking(raw) {
  const doc = eventObject(raw)
  if (!doc) return ""
  const msg = doc.Message ?? doc.message
  if (typeof msg === "string") return msg
  const data = doc.Data ?? doc.data
  const tm = data?.thinking_message ?? data?.thinkingMessage
  return typeof tm?.Message === "string" ? tm.Message : ""
}

/** COMPLETED / ERROR 的业务错误；null 表示没出错 */
export function eventError(name, raw) {
  if (!CONTROL.has(name)) return null
  const doc = eventObject(raw) ?? {}
  const code = Number(doc.Code ?? doc.code ?? 0) || 0
  if (name === "CLOSE") return null
  if (code === 0) return null
  const msg = String(doc.Msg || doc.msg || "")
  return { code, message: msg || describeCode(code) }
}

function describeCode(code) {
  if (code === 3) return "ima 暂时没有回答（code 3，通常是短时间连问太多被限流）"
  if (code === 1411) return "这个账号不能用这个模型（code 1411）"
  return `ima 返回 code ${code}`
}

/** 逐事件读 ima 的 SSE；onEvent(name, raw) */
export async function readIMAStream(res, onEvent) {
  const reader = res.body?.getReader()
  if (!reader) throw new Error("ima 的回答没有 body")
  const dec = new TextDecoder()
  let buf = ""
  let event = ""
  let data = []
  const flush = () => {
    if (!event && !data.length) return
    const raw = data.join("\n")
    const name = event || "message"
    event = ""
    data = []
    onEvent(name, raw)
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "")
        buf = buf.slice(i + 1)
        if (!line) flush()
        else if (line.startsWith(":")) continue
        else if (line.startsWith("event:")) {
          flush()
          event = line.slice(6).trim()
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
      }
    }
    buf += dec.decode()
    if (buf.startsWith("data:")) data.push(buf.slice(5).replace(/^ /, ""))
    flush()
  } finally {
    reader.cancel().catch(() => {})
  }
}

const chunkId = () => "chatcmpl-" + randomBytes(12).toString("hex")

/** 流式：把 ima 的 MESSAGE/THINKING 转成 chat.completion.chunk */
export function streamOpenAI(res, modelId) {
  const id = chunkId()
  const created = Math.floor(Date.now() / 1000)
  const enc = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        let closed = false
        const frame = (obj) => {
          controller.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\n\n"))
        }
        const delta = (d) =>
          frame({
            id,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [{ index: 0, delta: d, finish_reason: null }],
          })
        const finish = () => {
          if (closed) return
          frame({
            id,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          })
          closed = true
          controller.enqueue(enc.encode("data: [DONE]\n\n"))
          controller.close()
        }
        const fail = (err) => {
          if (closed) return
          frame({ error: { message: String(err?.message ?? err), type: "api_error", code: null } })
          closed = true
          controller.close()
        }
        delta({ role: "assistant" })
        readIMAStream(res, (name, raw) => {
          if (closed) return
          const bad = eventError(name, raw)
          if (bad) return fail(new Error(bad.message))
          if (name === "THINKING") {
            const t = eventThinking(raw)
            if (t) delta({ reasoning_content: t })
            return
          }
          if (name === "MESSAGE") {
            const t = eventText(raw)
            if (t) delta({ content: t })
            return
          }
          if (CONTROL.has(name)) finish()
        }).then(finish, fail)
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    },
  )
}

/** 非流式：把同一个流读完，拼成 chat.completion */
export async function aggregateOpenAI(res, modelId) {
  let text = ""
  let thinking = ""
  let failed = null
  await readIMAStream(res, (name, raw) => {
    if (failed) return
    const bad = eventError(name, raw)
    if (bad) {
      failed = new Error(bad.message)
      return
    }
    if (name === "THINKING") thinking += eventThinking(raw)
    else if (name === "MESSAGE") text += eventText(raw)
  })
  if (failed) throw failed
  return {
    id: chunkId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(thinking ? { reasoning_content: thinking } : {}),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

export function errorResponse(status, message, { signIn } = {}) {
  const headers = { "content-type": "application/json; charset=utf-8" }
  if (signIn) headers["X-Magpie-Sign-In"] = signIn
  return new Response(
    JSON.stringify({ error: { message: String(message ?? "ima 请求失败"), type: "api_error", code: null } }),
    { status, headers },
  )
}

export const _chatInternal = { TEXT_KEYS, CONTROL, chunkId }
