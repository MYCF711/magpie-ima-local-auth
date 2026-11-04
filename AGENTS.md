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

禁止直接推 main。只能推功能分支，PR 的 `rules` 全绿并合并后，运行
`scripts/release.mjs`（预演 → `--yes`）；脚本会拒绝未合并 HEAD，且不推 main。
npm publish、tag + GitHub Release、五条验证一个都不能少。

## 出站 User-Agent（模板坑表第 38 条）

上游网关按 `<product>/<version>` 形态识别「第三方客户端」，命中即回
`403 {{"error_code":"TM.00000001","error_msg":"网络繁忙，请稍后重试"}}` —— **文案说的是「网络繁忙」**，
看不出是 UA 的锅。而 magpie 给插件的请求带 `User-Agent: magpie/<version>`，插件不显式设 UA 就把它透传上去，
同样命中。

两条规矩，缺一都不算过：

1. 每个打上游的 `fetch` 都**显式**带 `User-Agent`；
2. 值是**该服务官方客户端**的 UA —— 绝不写 `<包名>/<版本号>`、`node`、`Bun/…`、截断的 Mozilla。

官方 UA 按优先级取：① 仓库里已抓到的官方 UA 逐字节照抄；② 有 App / CLI / Electron 客户端的用那个客户端的
token（`WorkBuddy/<app> … CLI/<ver>`、`aipy-pro/…`、`Loomy|Desktop|Electron|macOS`、`okhttp/4.12.0`）；
③ 官方是网页的用完整 Chrome UA
`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`。

`loader` 的 `fetch` 包装里，`"user-agent"` 必须在跳过名单内，再由插件补官方值。

判据：`node scripts/check-ua.mjs` 退出 0。
