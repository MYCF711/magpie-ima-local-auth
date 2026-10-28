// src/tools.mjs —— 文本工具协议
//
// ima 的 /assistant/qa 没有 OpenAI 的 tools 字段，但实测（2026-10-28）：
// 把 DSH 的工具表写进问题，要求模型输出
//   {"tool_calls":[{"name":"task_plan","arguments":{...}}]}
// 免费 V4.1 和 Copilot V4.1 都能稳定输出裸 JSON（不要加 sovereign 破甲；
// 破甲反而触发 ima 的注入检测，正常工具契约就够了）。
//
// 这里负责：
//   1. 把 OpenAI tools 变成提示词里的工具表 + 输出契约
//   2. 把 messages（含 assistant.tool_calls 和 role=tool 的结果）拼成一次问题
//   3. 从模型正文里解析 tool_calls
//   4. 把 ima 的 SSE 包成 OpenAI 的 chat.completion(.chunk)

import { randomBytes, randomUUID } from "node:crypto"
import {
  eventError,
  eventText,
  eventThinking,
  isContextMessage,
  partText,
  readIMAStream,
  systemText,
} from "./chat.mjs"

export function toolEntries(tools) {
  const out = []
  for (const t of Array.isArray(tools) ? tools : []) {
    const f = t?.function ?? t
    const name = String(f?.name ?? "").trim()
    if (!name) continue
    out.push({
      name,
      description: String(f?.description ?? "").trim(),
      parameters: f?.parameters ?? f?.input_schema ?? { type: "object", properties: {} },
    })
  }
  return out
}

export function toolNames(tools) {
  return new Set(toolEntries(tools).map((t) => t.name))
}

function contract(tools, toolChoice) {
  const defs = toolEntries(tools)
    .map((t, i) => `${i + 1}. ${t.name}\n   描述：${t.description || "（无描述）"}\n   参数 Schema：${JSON.stringify(t.parameters)}`)
    .join("\n")
  const forced =
    toolChoice === "required"
      ? "本次必须调用至少一个工具。"
      : toolChoice && typeof toolChoice === "object" && toolChoice?.function?.name
        ? `本次必须调用工具 ${toolChoice.function.name}。`
        : ""
  return `## 工具调用协议（DSH 编排层）

你是 DSH 的模型后端，一个纯文本补全引擎。下面这份工具表由**调用方**提供，不是 ima 的内置工具；
即使 ima 自己没有同名工具，也必须按本协议输出调用请求，由 DSH 在用户机器上执行。
不要回答“我没有这个工具”，不要用 ima 的搜索、文件、图片、脑图等内置能力替代这些工具，
不要用你自己的环境执行，也不要假装已经执行。

本次可用工具：
${defs || "（本次没有可用工具）"}

需要调用工具时，只输出一个裸 JSON 对象，不要代码块围栏、不要前后解释、不要道歉：
{"tool_calls":[{"name":"工具名","arguments":{参数对象}}]}

严格示例（必须照这个形状）：
{"tool_calls":[{"name":"task_plan","arguments":{"action":"update","goal":"修复登录 bug","steps":[{"id":"1","title":"复现"}]}}]}

不需要调用工具时，直接输出给用户看的自然语言正文。
如果已经收到工具结果，请基于结果继续；需要继续调用工具就再输出 tool_calls，否则直接给最终答案。
${forced}`
}

function toolCallText(m) {
  const calls = Array.isArray(m?.tool_calls) ? m.tool_calls : []
  if (!calls.length) return ""
  const normalized = calls.map((c) => {
    let args = c?.function?.arguments ?? c?.arguments ?? {}
    if (typeof args === "string") {
      try { args = JSON.parse(args) } catch { args = {} }
    }
    return {
      name: c?.function?.name ?? c?.name ?? "",
      arguments: args && typeof args === "object" ? args : {},
    }
  })
  return JSON.stringify({ tool_calls: normalized })
}

/**
 * 把 OpenAI messages 拼成 ima 的一次问题。
 * 返回 { question, current, hasToolResult }。
 */
export function buildToolPrompt(messages, tools, toolChoice) {
  const list = Array.isArray(messages) ? messages : []
  const instructions = systemText(list)
  const turns = []
  let lastRole = ""
  let lastUserText = ""

  for (const m of list) {
    if (!m || m.role === "system" || m.role === "developer") continue
    if (isContextMessage(m)) continue
    if (m.role === "user") {
      const text = partText(m.content).trim()
      if (!text) continue
      turns.push(`User: ${text.slice(0, 6000)}`)
      lastRole = "user"
      lastUserText = text
    } else if (m.role === "assistant") {
      const calls = toolCallText(m)
      const text = partText(m.content).trim()
      if (calls) {
        turns.push(`Assistant（工具调用）: ${calls.slice(0, 4000)}`)
        lastRole = "assistant"
      } else if (text) {
        turns.push(`Assistant: ${text.slice(0, 4000)}`)
        lastRole = "assistant"
      }
    } else if (m.role === "tool") {
      const text = partText(m.content).trim()
      const name = m.name || m.tool_call_id || "工具"
      if (text) {
        turns.push(`Tool result（${name}）: ${text.slice(0, 6000)}`)
        lastRole = "tool"
      }
    }
  }

  let current = ""
  let history = turns
  if (lastRole === "user" && lastUserText) {
    current = lastUserText
    history = turns.slice(0, -1)
  } else {
    current = "工具结果已经返回。请根据上面的工具结果继续；需要继续调用工具就再输出 tool_calls，否则直接给最终答案。"
  }

  const parts = []
  if (instructions) parts.push(`## 调用方系统指令\n${instructions.slice(0, 12000)}`)
  if (history.length) parts.push(`## 对话历史\n${history.join("\n\n")}`)
  parts.push(contract(tools, toolChoice))
  parts.push(`## 当前请求\n${current}`)
  return {
    question: parts.join("\n\n").slice(0, 60000),
    current,
    hasToolResult: lastRole === "tool" || list.some((m) => m?.role === "tool"),
  }
}

function tryJson(s) {
  const attempts = [s]
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) attempts.unshift(fenced[1].trim())
  const i = s.indexOf("{")
  const k = s.lastIndexOf("}")
  if (i >= 0 && k > i) attempts.push(s.slice(i, k + 1))
  for (const a of attempts) {
    try {
      const v = JSON.parse(a)
      if (v && typeof v === "object") return v
    } catch {}
  }
  return null
}

function normalizeCalls(obj, known) {
  let listed = null
  if (Array.isArray(obj?.tool_calls)) listed = obj.tool_calls
  else if (Array.isArray(obj?.toolCalls)) listed = obj.toolCalls
  else if (obj?.name || obj?.function?.name) listed = [obj]
  if (!listed) return null
  const out = []
  for (const c of listed) {
    const name = String(c?.function?.name ?? c?.name ?? "").trim()
    if (!name) continue
    if (known?.size && !known.has(name)) continue
    let args = c?.function?.arguments ?? c?.arguments ?? {}
    if (typeof args === "string") {
      try { args = JSON.parse(args) } catch { args = {} }
    }
    out.push({ name, arguments: args && typeof args === "object" ? args : {} })
  }
  return out.length ? out : null
}

/** 从模型正文里解析 tool_calls；解析失败返回 null，由调用方当正文。 */
export function parseToolCalls(text, knownNames) {
  const raw = typeof text === "string" ? text.trim() : ""
  if (!raw) return null
  const obj = tryJson(raw)
  if (!obj) return null
  const calls = normalizeCalls(obj, knownNames instanceof Set ? knownNames : new Set(knownNames ?? []))
  return calls ? { calls } : null
}

export function argumentsString(args) {
  try {
    return JSON.stringify(args && typeof args === "object" ? args : {})
  } catch {
    return "{}"
  }
}

export function toOpenAIToolCalls(calls) {
  return (calls ?? []).map((c) => ({
    id: "call_" + randomUUID().replace(/-/g, "").slice(0, 24),
    type: "function",
    function: { name: c.name, arguments: argumentsString(c.arguments) },
  }))
}

async function collect(res) {
  let text = ""
  let thinking = ""
  let failed = null
  await readIMAStream(res, (name, raw) => {
    if (failed) return
    const bad = eventError(name, raw)
    if (bad) { failed = new Error(bad.message); return }
    if (name === "THINKING" || name === "STRUCTURED_BLOCK") thinking += eventThinking(raw)
    if (name === "MESSAGE" || name === "STRUCTURED_BLOCK") text += eventText(raw)
  })
  if (failed) throw failed
  return { text, thinking }
}

function id() {
  return "chatcmpl-" + randomBytes(12).toString("hex")
}

const USAGE = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

/** 非流式：工具请求的 chat.completion */
export async function aggregateToolResponse(res, modelId, tools) {
  const { text, thinking } = await collect(res)
  const parsed = parseToolCalls(text, toolNames(tools))
  const calls = parsed?.calls ?? null
  const openaiCalls = calls ? toOpenAIToolCalls(calls) : null
  return new Response(
    JSON.stringify({
      id: id(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: calls ? null : text,
            ...(thinking ? { reasoning_content: thinking } : {}),
            ...(openaiCalls ? { tool_calls: openaiCalls } : {}),
          },
          finish_reason: calls ? "tool_calls" : "stop",
        },
      ],
      usage: USAGE,
    }),
    { headers: { "content-type": "application/json; charset=utf-8" } },
  )
}

/** 流式：工具请求先攒后发（工具 JSON 必须完整才能判定），再按 OpenAI chunk 发。 */
export function streamToolResponse(res, modelId, tools, { includeUsage = false } = {}) {
  const responseId = id()
  const created = Math.floor(Date.now() / 1000)
  const enc = new TextEncoder()
  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = (obj) => controller.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\n\n"))
        const frame = (delta, finish = null) =>
          send({
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })
        try {
          const { text, thinking } = await collect(res)
          const parsed = parseToolCalls(text, toolNames(tools))
          const calls = parsed?.calls ?? null
          frame({ role: "assistant" })
          if (thinking) frame({ reasoning_content: thinking })
          if (calls) {
            const openaiCalls = toOpenAIToolCalls(calls)
            frame({
              tool_calls: openaiCalls.map((tc, i) => ({
                index: i,
                id: tc.id,
                type: "function",
                function: { name: tc.function.name, arguments: tc.function.arguments },
              })),
            })
            frame({}, "tool_calls")
          } else {
            if (text) frame({ content: text })
            frame({}, "stop")
          }
          if (includeUsage) {
            send({ id: responseId, object: "chat.completion.chunk", created, model: modelId, choices: [], usage: USAGE })
          }
          controller.enqueue(enc.encode("data: [DONE]\n\n"))
        } catch (e) {
          send({ error: { type: "api_error", message: String(e?.message ?? e) } })
        } finally {
          controller.close()
        }
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

export const _toolsInternal = { contract, tryJson, normalizeCalls, USAGE }
