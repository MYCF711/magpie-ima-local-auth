// src/models.mjs —— 把 ima 的 (model_type, model_id, 名字) 变成 magpie 的模型条目
//
// 免费 / 积分不是从「倍率是否为 0」反推的：
//   model_token_copywriting 为空  → 知识库问答不扣算力 → free
//   "×0.2" / "×4.5 闲时"          → 积分模型 → rate，free 不设
// 本机账号实测 4 条免费模型，Copilot 前端返回「当前版本暂不支持」，
// 所以默认不列 Copilot；见 README 的「模型」。

import { BASE, SDK } from "./context.mjs"

export const slug = (name) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "") || "model"

export const thinkingName = (name) => /think|思考/i.test(String(name ?? ""))

/** 解析 "×0.2" / "×4.5 闲时" 里的倍率；解析不了返回 null，不猜 */
export function rateOf(copy) {
  const m = String(copy ?? "").match(/[×x]\s*(\d+(?:\.\d+)?)/i)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/**
 * 厂商自己声明的免费：倍率为空，或明确 ×0.0。
 * ⚠ 不把「没有倍率」当收费 —— 知识库模型就是空倍率且真免费。
 */
export function isFree(copy) {
  const s = String(copy ?? "").trim()
  if (!s) return true
  const r = rateOf(s)
  return r !== null && r === 0
}

function entry(id, name, thinking, { free = true, rate = null } = {}) {
  return {
    id,
    name,
    api: { id, url: BASE, npm: SDK },
    status: "active",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    // ima 的目录不告诉你上下文窗口；0 让宿主用自己的模型库，不写猜的数字。
    limit: { context: 0, output: 0 },
    capabilities: {
      temperature: false,
      reasoning: !!thinking,
      toolcall: true,
      attachment: false,
      input: { text: true, image: false },
      output: { text: true },
    },
    ...(free ? { free: true } : {}),
    ...(!free && rate !== null ? { rate } : {}),
  }
}

/**
 * 从 /model_manage/get_models 的 models[] 造条目 + id 映射。
 * 返回 { models, index }：
 *   models —— id → 条目（给 magpie）
 *   index  —— id → { id, name, type, modelId, thinking }（给 chat 发请求）
 */
export function buildModels(rows = []) {
  const models = {}
  const index = new Map()
  const used = new Set()

  for (const row of rows) {
    const type = Number(row?.model_type ?? row?.type)
    const modelId = String(row?.model_id ?? row?.id ?? "")
    const name = String(row?.model_name ?? row?.name ?? modelId ?? "").trim()
    if (!Number.isFinite(type) || !modelId || !name) continue

    let id = slug(name)
    if (used.has(id)) id = `${id}-${type}`
    used.add(id)

    const copy = row?.model_token_copywriting
    const free = isFree(copy)
    const rate = free ? null : rateOf(copy)
    const thinking = thinkingName(name)
    models[id] = entry(id, name, thinking, { free, rate })
    index.set(id, { id, name, type, modelId, thinking })

    // ima 的免费模型用 sub_model_infos 带一个深度思考变体：
    //   {"0":{model_type:3,...},"1":{model_type:1,...}}
    // 把它也做成独立模型，用户才能在 magpie 里选思考档。
    for (const sub of Object.values(row?.sub_model_infos ?? {})) {
      const subType = Number(sub?.model_type)
      const subModelId = String(sub?.model_id ?? "")
      if (!Number.isFinite(subType) || !subModelId) continue
      if (subType === type && subModelId === modelId) continue
      let subId = `${slug(name)}-think`
      if (used.has(subId)) subId = `${subId}-${subType}`
      used.add(subId)
      const subName = `${name} Think`
      models[subId] = entry(subId, subName, true, { free, rate })
      index.set(subId, { id: subId, name: subName, type: subType, modelId: subModelId, thinking: true })
    }
  }
  return { models, index }
}

export const _modelsInternal = { entry }
