# ima.copilot 反代价值评估

> 评估对象：`E:\ima.copilot\ima.copilot.exe`（本机 2.6.15.5280 / Chromium 150.0.7871.5469）
> 评估时间：2026-10-28。所有数字都是本机实测，不是查资料估的。

## 结论

| 反代对象 | 价值 | 判定 |
|---|---|---|
| **免费模型**（DeepSeek-V4.1-Flash / Hy3 / Hy4 preview / GLM-5.3-Flash + 4 个 Think 变体） | **高** | 4 个基础模型 + 4 个思考变体、不扣算力、支持流式；质量已接近/覆盖 CodeBuddy 免费 HY3 这一档 |
| **Copilot 积分模型**（Hy3 / Hy4 / V4.1 / MiMo / GLM / MiniMax / Kimi…） | **模型能力高，但本插件不接** | Copilot 是 ima 的云端 agent（`robot_type=15` + `command_info.type=2000`），正是 today 式结果的来源；即使能拿到完整目录也默认不列 |
| 知识库文件 / 文档管理 | 低（本次不做） | 是 ima 的知识库业务，不是模型；对 magpie 供应商没有直接价值 |
| 图片生成 / 播客等 | 低（本次不做） | 与 magpie 的 chat 供应商无关 |

**一句话：免费模型这一层的价值是真实的（V4.1-Flash / Hy3 / Hy4 / GLM-5.3 免费）；
Copilot 积分模型能力更强，但它是云端 agent，按“不能是云端 agent”的约束不接。**

## 关键发现：`CLIENT-TYPE=256021` 是指纹钥匙

同一账号、同一 token，只改 `x-ima-cookie` 里的 `CLIENT-TYPE`，`model_manage/get_models`
返回的目录完全不同：

| `CLIENT-TYPE` | `{}`（免费目录） | `{"scene":1}`（Copilot 目录） |
|---|---|---|
| `windows` | DeepSeek V3.2 / V3.2 Think / Tencent HY 2.0 / HY 2.0 Think | 只有 `默认模型 ×1.0` |
| **`256021`**（客户端实际值） | **DeepSeek-V4.1-Flash / Hy3 / Hy4 preview / GLM-5.3-Flash** | **完整：Hy3 ×0.2、Hy4 preview ×0.9、DeepSeek-V4.1-Flash ×0.4 峰时、Xiaomi MiMo、GLM-5.3、MiniMax-M3、Kimi…共 12 个** |

这正对应“像超级麦吉要组织指纹 key”的猜测：ima 的客户端类型/指纹就是 `CLIENT-TYPE=256021`。
没有它，服务端不报错，只会退回旧目录，Copilot 也只给默认模型——这就是之前
「本机 Copilot 暂不支持 / 模型只有 V3.2」现象的根因。

> 2026-10-28 从 ima 2.6.15 客户端真实请求头抓包得到；不同客户端版本可能变化，
> 可用 `IMA_CLIENT_TYPE` 覆盖。

## 实测证据

### 免费模型目录（`POST /cgi-bin/model_manage/get_models`，body `{}`，`CLIENT-TYPE=256021`）

| model_type | model_id | 显示名 | 倍率字段 |
|---|---|---|---|
| 3 | official_3 | DeepSeek-V4.1-Flash | 空 |
| 1 | official_1 | DeepSeek-V4.1-Flash Think | 空 |
| 0 | official_0 | Hy3 | 空 |
| 2 | official_2 | Hy3 Think | 空 |
| 1001 | official_1001 | Hy4 preview | 空 |
| 1002 | official_1002 | Hy4 preview Think | 空 |
| 3000 | official_3000 | GLM-5.3-Flash | 空 |
| 3001 | official_3001 | GLM-5.3-Flash Think | 空 |

`model_token_copywriting` 为空 = 不扣算力。实测问答后 `token_manager/get_balance`
仍为 500。

### Copilot 目录（`{"scene":1}`，`CLIENT-TYPE=256021`）

`自动选择最优模型 ×1.0`、`Hy3 ×0.2`、`Hy4 preview ×0.9`、`DeepSeek-V4.1-Flash ×0.4 峰时`、
`Xiaomi MiMo-V2.6-Flash ×0.2`、`Xiaomi MiMo-V2.6-Pro ×0.6`、`GLM-5.3-Flash ×0.2`、
`GLM-5.3 ×2.2`、`MiniMax-M3.1-Flash ×0.2`、`MiniMax-M3 ×0.6`、
`Kimi-K2.8-Preview ×1.9`、`Kimi-K3.1-Pro ×3.8`。

Copilot 的实际请求（抓包）：

```
POST /cgi-bin/assistant/qa
{"robot_type":15,"command_info":{"type":2000,"copilot_qa_info":{}},
 "model_info":{"model_id":"official_paid_ep-i2azx8ko","model_type":110000,"enable_enhancement":false}}
→ SSE STRUCTURED_BLOCK（blockThinking / text_message）
```

DeepSeek-V4.1-Flash 在 Copilot 里是真实模型（`official_paid_ep-i2azx8ko` / type 110000），
`STRUCTURED_BLOCK` 里能看到流式思考；但它始终是 Copilot agent。

### 问答与流式

```
POST /cgi-bin/session_logic/init_session
{"env_info":{"interact_type":2,"robot_type":10000},"name":"…","msgs_limit":20}
→ {"code":0,"session_id":"…"}

POST /cgi-bin/assistant/qa (SSE)
{"session_id":"…","robot_type":10000,"question":"…","question_type":2,
 "command_info":{"question_info":{}},"model_info":{"model_type":3,"model_id":"official_3"}}
→ MESSAGE {"Text":"…"} / STRUCTURED_BLOCK {"Data":{"text_message":{"Text":"…"}}}
→ COMPLETED {"Code":0}
```

- 多轮：同一 session 第一问“记住 7391”、第二问“刚才的数字”返回 7391。
- 长回答：多个增量事件拼出完整 1..20。
- 思考：`THINKING {"Message":"…","Status":1}` / `STRUCTURED_BLOCK.blockThinking` 增量；
  最后一条 `Status:2` 是结束标记。
- `SUGGEST_QUESTION` 是建议列表，不是答案。

### 登录态

ima 的 token 有两份：运行中客户端的内存（native bridge），以及客户端正常退出时写进
profile 的 `tencent.wxlogin.account_secret_encrypted`（DPAPI）。插件读后者，不读内存、
不开 CDP、不要求粘贴 cookie。读到的 `token` 约 2 小时，`refresh_token` 约一年；
`/auth_login/refresh` 实测可换新 token（返回相对 7200 秒）。

## UI 标签 vs 账号目录（修正）

之前用 `CLIENT-TYPE=windows` 抓包时，UI 选 V4.1-Flash 发出的 `official_3` 被账号目录标成
V3.2；把客户端真实的 `CLIENT-TYPE=256021` 带上后，同一 `official_3` 的目录名是
**DeepSeek-V4.1-Flash**。所以：

- **UI 的 V4.1-Flash 是真 V4.1**；之前的“背后是 V3.2”是**我们的请求缺客户端指纹**造成的
  服务端降级，不是 UI 造假。
- Copilot 的 V4.1（`official_paid_ep-i2azx8ko`）也是真 V4.1；两条通道不同，但都真实存在。

## 工具协议与系统提示词测试（2026-10-28）

关键修正：ima 的模型不是裸 LLM（有自己的身份/安全包装），但**正常工具契约可以工作**；
sovereign 破甲反而触发它的注入检测，不要用。

| 测试 | 结果 |
|---|---|
| 免费 V4.1 + `task_plan` / `subagent_spawn` 工具表 | **5/5 输出合法裸 JSON `tool_calls`**（非流式）；流式同样返回 tool_calls 帧 |
| Copilot V4.1 + 同一工具表 | 同样输出合法 `tool_calls`（`task_plan` 参数补全了 goal/steps） |
| DSH headless + `write` 工具 | 模型实际调用 DSH 的 `write`，文件被创建并回复 `DSH-BASH-OK` |
| 工具结果回灌 | assistant tool_calls + role=tool 的消息被拼回提示，模型输出最终正文 |
| sovereign 破甲 + 强制改身份 | 免费/Copilot 都识别为注入并拒绝，**不要用破甲** |

实现：`src/tools.mjs` 把 OpenAI tools 写成提示，解析 `{"tool_calls":[...]}` 转成
OpenAI tool_calls；`toolcall: true`；流式工具请求先攒后发（工具 JSON 必须完整）。
工具调用不是 ima 原生能力，是文本协议模拟，但已达到正常 API 的可用形态。

## 与 CodeBuddy / 其它免费源的对比

| 免费源 | 档位 | 接入成本 | 结论 |
|---|---|---|---|
| CodeBuddy 免费 HY3 | HY3 | 现成插件/账号 | 可作主力免费源 |
| ima 免费目录（本插件） | V4.1-Flash / Hy3 / Hy4 preview / GLM-5.3-Flash | 本插件 + 本机客户端 | **同档，多模型；有真实价值** |
| ima Copilot（积分） | V4.1 / Hy3 / Hy4 / MiMo / GLM / MiniMax / Kimi | 需要开 Copilot agent | 能力更高，但 agent 约束下不接 |

## 与现有实现的关系

| 实现 | 路径 | 问题 |
|---|---|---|
| `magpie-ima-auth`（npm） | 浏览器 cookie → 云端 `assistant/qa` | 登录要手工复制 `x-ima-cookie`；本质是把 ima 的云端 agent 会话包装成 chat（单问、无工具、system prompt 受限） |
| `opencli-plugin-ima` | 直接 API + WebContents/UI | 主要面向知识库问答；Windows 直接 API 遇到 600001；需要客户端/UI 自动化 |
| 本插件 | 本机客户端 profile → DPAPI 登录态 → 伪装请求头（含 `CLIENT-TYPE=256021`） | 不粘贴 cookie、运行时不需要 CDP；只走 `robot_type=10000` 的普通问答；模型目录/流式/思考/续期都按模型供应商做 |

## 限制（如实写）

- **单问 session**：`assistant/qa` 一次只收一个问题，没有 messages 数组；插件用 session
  保持多轮，但 system prompt 只在 session 第一问里发。
- **工具调用是文本协议模拟**：ima 没有原生 tools 字段；插件把工具表写进提示，模型输出
  `{"tool_calls":[...]}` 后转成 OpenAI `tool_calls`，工具由 DSH 执行。平台升级后需重新验证。
- **没有 token 计数**：ima 不返回 usage；插件不按字符数编，返回 0。
- **没有上下文窗口**：模型目录不下发；`limit.context` 留 0，交给 magpie 的模型库。
- **私有接口 + 指纹**：`CLIENT-TYPE=256021` 是抓包值，客户端升级可能变；可用
  `IMA_CLIENT_TYPE` 覆盖。API 本身也可能随时变。
- **登录导入平台**：DPAPI 解密目前只做 Windows；macOS 用种子文件 / `IMA_COPILOT_LOGIN_FILE`。
- **Copilot 不进默认目录**：它可用、流式思考也正常，但它是 agent，不是模型通道。

## 已完成的验收

- `node scripts/check.mjs`：通过 29 · 警告 0 · 失败 0
- `node --test`：17/17
- magpie 0.1.1814 安装后 `ima (ima, 8 models) signed in as 001ab…`
- 网关：`POST /v1/chat/completions`（`ima/deepseek-v4.1-flash`）返回 `GATEWAY-V41`；
  流式返回 role/content/`finish_reason:"stop"`；思考模型返回 `reasoning_content`。
- DSH headless（`dsh --profile headless` + patch，模型 `ima/hy3` 或 `ima/deepseek-v4.1-flash`）
  返回 `DSH-IMA-OK`。
