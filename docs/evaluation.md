# ima.copilot 反代价值评估

> 评估对象：`E:\ima.copilot\ima.copilot.exe`（本机 2.6.15.5280 / Chromium 150.0.7871.5469）
> 评估时间：2026-10-28。所有数字都是本机实测，不是查资料估的。

## 结论

| 反代对象 | 价值 | 判定 |
|---|---|---|
| **免费知识库模型**（DeepSeek V3.2 / Tencent HY 2.0，含 Think 档） | **高** | 4 个模型可用、不扣算力、支持流式与思考、单问 session 能多轮；适合做 magpie 供应商 |
| **积分模型（Copilot）** | **0（在“不能是云端 agent”约束下）** | 本机 2.6.15 对 Copilot 问答直接返回 `{"Code":1,"Msg":"当前版本暂不支持"}`；即使别的版本支持，它也是 ima 自己的云端 agent（`robot_type=15`），正是 today 式结果的来源 |
| 知识库文件 / 文档管理 | 低（本次不做） | 是 ima 的知识库业务，不是模型；对 magpie 供应商没有直接价值 |
| 图片生成 / 播客等 | 低（本次不做） | 与 magpie 的 chat 供应商无关；且需要单独的计费与权限 |

**一句话：这个软件的反代价值全部集中在“免费模型”上；积分模型不是模型通道，是云端 agent，不值得为它牺牲模型级体验。**

## 实测证据

### 免费模型目录（`POST /cgi-bin/model_manage/get_models`，body `{}`）

| model_type | model_id | 显示名 | 倍率字段 |
|---|---|---|---|
| 3 | official_3 | DeepSeek V3.2 | 空 |
| 1 | official_1 | DeepSeek V3.2 Think | 空 |
| 0 | official_0 | Tencent HY 2.0 | 空 |
| 2 | official_2 | Tencent HY 2.0 Think | 空 |

`model_token_copywriting` 为空 = 知识库问答不扣算力。连续多次 `assistant/qa` 后
`token_manager/get_balance` 仍为 500，说明免费不是“暂时没扣”。

### 问答

```
POST /cgi-bin/session_logic/init_session
{"env_info":{"interact_type":2,"robot_type":10000},"name":"…","msgs_limit":20}
→ {"code":0,"session_id":"…"}

POST /cgi-bin/assistant/qa (SSE)
{"session_id":"…","robot_type":10000,"question":"…","question_type":2,
 "command_info":{"question_info":{}},"model_info":{"model_type":3,"model_id":"official_3"}}
→ MESSAGE {"Text":"DSH-IMA-OK"} … COMPLETED {"Code":0}
```

- 多轮：同一 session 第一问“记住 7391”、第二问“刚才的数字”返回 7391。
- 长回答：9 个 `MESSAGE` 增量拼出完整 1..20。
- 思考模型：`THINKING {"Message":"…","Status":1}` 增量；最后一条 `Status:2` 是结束标记。
- `SUGGEST_QUESTION` 是建议列表，不是答案。

### 登录态

ima 的 token 有两份：运行中客户端的内存（native bridge），以及客户端正常退出时写进
profile 的 `tencent.wxlogin.account_secret_encrypted`（DPAPI）。插件读后者，不读内存、
不开 CDP、不要求粘贴 cookie。读到的 `token` 约 2 小时，`refresh_token` 约一年；
`/auth_login/refresh` 实测可换新 token（返回相对 7200 秒）。

### IUA 的必要性

`x-ima-cookie` 里少了 `IMA-IUA`，服务端不报错，但会把请求当匿名：
模型目录退回默认的 DeepSeek-V4.1-Flash / Hy3 / Hy4 / GLM，`assistant/qa` 返回 200
却没有正文。补一个最小 IUA
（`PR=IMA&PP=com.tencent.imawin&PPVN=<版本>&PL=WIN&COVC=<Chromium 版本>&EV=`）
就按账号目录回答。所以插件永远补 IUA。

## 与现有实现的关系

| 实现 | 路径 | 问题 |
|---|---|---|
| `magpie-ima-auth`（npm） | 浏览器 cookie → 云端 `assistant/qa` | 登录要手工复制 `x-ima-cookie`；本质是把 ima 的云端 agent 会话包装成 chat（单问、无工具、system prompt 受限） |
| `opencli-plugin-ima` | 直接 API + WebContents/UI | 主要面向知识库问答；Windows 直接 API 遇到 600001；需要客户端/UI 自动化 |
| 本插件 | 本机客户端 profile → DPAPI 登录态 → 伪装请求头 | 不粘贴 cookie、运行时不需要 CDP；只走 `robot_type=10000` 的普通问答；模型目录/流式/思考/续期都按模型供应商做 |

## 限制（如实写）

- **单问 session**：ima 的 `assistant/qa` 一次只收一个问题，没有 messages 数组；插件用
  session 保持多轮，但 system prompt 只在 session 第一问里发。
- **没有工具调用**：ima 的问答接口没有 tool 通道；模型条目如实声明 `toolcall: false`。
- **没有 token 计数**：ima 不返回 usage；插件不按字符数编，返回 0。
- **没有上下文窗口**：模型目录不下发；`limit.context` 留 0，交给 magpie 的模型库。
- **私有接口**：随时可能变；ima 客户端升级后 IUA/字段可能需要跟着调。
- **登录导入平台**：DPAPI 解密目前只做 Windows；macOS 用种子文件 / `IMA_COPILOT_LOGIN_FILE`。
- **Copilot 不可用**：本机版本直接“暂不支持”，且它是 agent；插件默认不列。

## 已完成的验收

- `node scripts/check.mjs`：通过 29 · 警告 0 · 失败 0
- `node --test`：10/10
- magpie 0.1.1814 安装后 `ima (ima, 4 models) signed in as 001ab…`
- 网关：`POST /v1/chat/completions`（`ima/deepseek-v3.2`）返回 `GATEWAY-OK`；
  流式返回 role/content/`finish_reason:"stop"`；`ima/deepseek-v3.2-think` 返回
  `reasoning_content`。
- DSH headless（`dsh --profile headless` + patch，模型 `ima/tencent-hy-2.0`）返回
  `DSH-IMA-OK`。
