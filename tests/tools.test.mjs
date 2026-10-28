import assert from "node:assert/strict"
import test from "node:test"

import {
  buildToolPrompt,
  parseToolCalls,
  toOpenAIToolCalls,
  toolEntries,
  toolNames,
} from "../src/tools.mjs"

const tools = [
  {
    type: "function",
    function: {
      name: "task_plan",
      description: "创建、更新、推进当前任务的执行计划",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["update", "advance"] },
          goal: { type: "string" },
          steps: { type: "array", items: { type: "object" } },
          current_step_id: { type: "string" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: { name: "subagent_spawn", description: "启动子代理", parameters: { type: "object", properties: {} } },
  },
]

test("toolEntries / toolNames：取 function 形状", () => {
  assert.deepEqual(toolEntries(tools).map((t) => t.name), ["task_plan", "subagent_spawn"])
  assert.deepEqual([...toolNames(tools)].sort(), ["subagent_spawn", "task_plan"])
})

test("buildToolPrompt：工具表、契约和当前问题都在", () => {
  const p = buildToolPrompt(
    [
      { role: "system", content: "你是 DSH。" },
      { role: "user", content: "帮我建计划" },
    ],
    tools,
    "auto",
  )
  assert.match(p.question, /task_plan/)
  assert.match(p.question, /subagent_spawn/)
  assert.match(p.question, /tool_calls/)
  assert.match(p.question, /帮我建计划/)
  assert.equal(p.hasToolResult, false)
})

test("buildToolPrompt：assistant tool_calls + tool result 变成续轮", () => {
  const p = buildToolPrompt(
    [
      { role: "user", content: "帮我建计划" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "task_plan", arguments: '{"action":"update"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", name: "task_plan", content: '{"ok":true,"steps":3}' },
    ],
    tools,
    "auto",
  )
  assert.equal(p.hasToolResult, true)
  assert.match(p.question, /Tool result/)
  assert.match(p.question, /ok/)
  assert.match(p.question, /工具结果已经返回/)
})

test("parseToolCalls：裸 JSON / 围栏 / 函数形状", () => {
  assert.deepEqual(parseToolCalls('{"tool_calls":[{"name":"task_plan","arguments":{"action":"update"}}]}', toolNames(tools)), {
    calls: [{ name: "task_plan", arguments: { action: "update" } }],
  })
  assert.deepEqual(
    parseToolCalls('```json\n{"tool_calls":[{"function":{"name":"subagent_spawn","arguments":"{\\"type\\":\\"research\\"}"}}]}\n```', toolNames(tools)),
    { calls: [{ name: "subagent_spawn", arguments: { type: "research" } }] },
  )
  assert.deepEqual(parseToolCalls('{"name":"task_plan","arguments":{"action":"advance","current_step_id":"x"}}', toolNames(tools)), {
    calls: [{ name: "task_plan", arguments: { action: "advance", current_step_id: "x" } }],
  })
})

test("parseToolCalls：未知工具不伪造，当正文", () => {
  assert.equal(parseToolCalls('{"tool_calls":[{"name":"mydb_query","arguments":{}}]}', toolNames(tools)), null)
  assert.equal(parseToolCalls("普通回答，不是工具", toolNames(tools)), null)
})

test("toOpenAIToolCalls：arguments 是 JSON 字符串，id 稳定形状", () => {
  const [c] = toOpenAIToolCalls([{ name: "task_plan", arguments: { action: "update" } }])
  assert.match(c.id, /^call_[0-9a-f]{24}$/)
  assert.equal(c.type, "function")
  assert.equal(c.function.name, "task_plan")
  assert.equal(JSON.parse(c.function.arguments).action, "update")
})
