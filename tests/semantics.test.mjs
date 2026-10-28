import test from "node:test"
import assert from "node:assert/strict"

import { bkn, cookieFor, defaultIua } from "../src/api.mjs"
import { normalize } from "../src/login.mjs"
import { buildModels, isFree, rateOf, slug } from "../src/models.mjs"
import {
  eventError,
  eventText,
  eventThinking,
  isContextMessage,
  lastUser,
  partText,
  systemText,
  transcript,
} from "../src/chat.mjs"

test("bkn：djb2 变体，输入为空时是 5381", () => {
  assert.equal(bkn(""), "5381")
  assert.equal(bkn("abc"), "193485963")
})

test("cookieFor：永远给 IMA-IUA，空字段不拼", () => {
  const cookie = cookieFor({ access: "tok", uid: "u1", guid: "g1", idType: "2", tokenType: "14" })
  assert.match(cookie, /IMA-TOKEN=tok/)
  assert.match(cookie, /IMA-UID=u1/)
  assert.match(cookie, /UID-TYPE=2/)
  assert.match(cookie, /TOKEN-TYPE=14/)
  assert.match(cookie, /IMA-IUA=PR%3DIMA|IMA-IUA=PR=IMA/)
  assert.doesNotMatch(cookie, /IMA-Q36=;/)
  assert.ok(defaultIua().startsWith("PR=IMA"))
})

test("normalize：token -> access，epoch 秒 -> expires 毫秒", () => {
  const s = normalize({ token: "abc", refresh_token: "r", token_valid_time: 1793173634, user_id: "u", id_type: 2, token_type: 14 })
  assert.equal(s.access, "abc")
  assert.equal(s.refresh, "r")
  assert.equal(s.uid, "u")
  assert.equal(s.expires, 1793173634 * 1000)
})

test("messages：system 合在一起，最后一条 user 才是问题", () => {
  const msgs = [
    { role: "system", content: "只输出 JSON" },
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: [{ type: "text", text: "第二问" }] },
  ]
  assert.equal(systemText(msgs), "只输出 JSON")
  assert.deepEqual(lastUser(msgs), { text: "第二问", index: 3 })
  assert.match(transcript(msgs, 3), /User: 第一问/)
})

test("DSH 的上下文注入不是问题", () => {
  const task = { role: "user", content: "只回复 DSH-IMA-OK" }
  const reminder = { role: "user", content: "<system-reminder> A skill is available: <available_skills>...</available_skills>" }
  assert.equal(isContextMessage(reminder), true)
  assert.equal(lastUser([task, reminder]).text, "只回复 DSH-IMA-OK")
  assert.equal(transcript([task, reminder], 0), "")
})

test("partText：图片变成可读标记，不是静默消失", () => {
  assert.equal(partText([{ type: "image_url", image_url: { url: "x" } }]), "[一张图片；ima 的免费模型看不到图]")
})

test("slug：与动态目录的 id 保持一致", () => {
  assert.equal(slug("Tencent HY 2.0"), "tencent-hy-2.0")
  assert.equal(slug("DeepSeek V3.2 Think"), "deepseek-v3.2-think")
})

test("免费/积分：空倍率是免费，×0.2 是积分", () => {
  assert.equal(isFree(""), true)
  assert.equal(isFree("×0.0"), true)
  assert.equal(isFree("×1.0"), false)
  assert.equal(rateOf("×4.5 闲时"), 4.5)
})

test("buildModels：目录变成 magpie 条目与索引", () => {
  const { models, index } = buildModels([
    { model_type: 3, model_id: "official_3", model_name: "DeepSeek V3.2", model_token_copywriting: "" },
    { model_type: 1, model_id: "official_1", model_name: "DeepSeek V3.2 Think", model_token_copywriting: "" },
    { model_type: 100000, model_id: "official_100000", model_name: "默认模型", model_token_copywriting: "×1.0" },
  ])
  assert.deepEqual(Object.keys(models), ["deepseek-v3.2", "deepseek-v3.2-think", "model"])
  assert.equal(models["deepseek-v3.2"].free, true)
  assert.equal(models["deepseek-v3.2-think"].capabilities.reasoning, true)
  assert.equal(models["model"].free, undefined)
  assert.equal(models["model"].rate, 1)
  assert.equal(index.get("deepseek-v3.2").modelId, "official_3")
})

test("SSE：MESSAGE 取 Text，THINKING 取 Message，业务错误看 COMPLETED", () => {
  assert.equal(eventText('{"Text":"OK"}'), "OK")
  assert.equal(eventText('{"Data":{"text_message":{"Text":"旧版"}}}'), "旧版")
  assert.equal(eventThinking('{"Message":"思考","Status":1}'), "思考")
  assert.equal(eventThinking('{"Message":"","Status":2,"Tips":"完成"}'), "")
  assert.equal(eventError("SUGGEST_QUESTION", '[{"Text":"x"}]'), null)
  assert.deepEqual(eventError("COMPLETED", '{"Code":1,"Msg":"当前版本暂不支持"}'), {
    code: 1,
    message: "当前版本暂不支持",
  })
  assert.equal(eventError("COMPLETED", '{"Code":0}'), null)
})
