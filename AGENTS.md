# AGENTS.md —— 给维护者的入口

这个仓库是 `magpie-plugin-scaffold` 的派生插件。动手前先读：

1. `README.md` —— 用户看什么、支持哪些模型、怎么登录。
2. `docs/internals.md` —— 协议证据、IUA 的必要性、被否掉的方案。
3. `docs/evaluation.md` —— 反代价值评估与实测数字。
4. `node scripts/check.mjs` —— 合规定稿检查，退出码必须 0。
5. `node --test` —— 语义锁（bkn / 模型 / SSE / DSH 上下文过滤）。

## 会静默出错的四条

| 症状 | 判据 | 出处 |
|---|---|---|
| 模型目录退回 V3.2 / HY2.0，Copilot `scene:1` 只有默认模型 | `CLIENT-TYPE=256021` 指纹缺失；`src/api.mjs` 的 `cookieFor()` 默认带 | `docs/internals.md` 第 3 节 |
| 模型目录退回 V4.1 / Hy3 / Hy4 / GLM（匿名默认），问答 200 但没正文 | `IMA-IUA` 缺失；`defaultIua()` 永远补 | `docs/internals.md` 第 3 节 |
| 回复答非所问，像是在回答“技能目录” | DSH 把 AGENTS/技能目录作为 user 消息追加；`isContextMessage()` 必须把它们从问题/历史里滤掉 | `src/chat.mjs`、`docs/internals.md` |
| 流式客户端报 `Stream ended without finish_reason` | `finish()` 必须先发带 `finish_reason:"stop"` 的帧，再置 `closed`；`frame()` 不能提前 return | `src/chat.mjs` |
| 登录后模型 0 个 / 401 | 用 `importLocalLogin()` 的种子或 profile；`provider.models` 调用 `ensureFresh` 后续期 | `src/login.mjs`、`src/api.mjs` |

## 发版

`scripts/release.mjs`（预演 → `--yes`），或按 scaffold 的 `UPDATING.md` 七步走。
`git push` 只是第 4 步；npm publish、tag + GitHub Release、四条验证一个都不能少。
