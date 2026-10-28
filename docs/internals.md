# 内部说明：协议、证据与被否掉的方案

这份文件只记录「为什么这样做」与「怎么验证」。用户看 README；改代码前先看这里。

## 1. 这个插件反代的是什么

ima.copilot 客户端里有两套对话：

| | 问问 ima / 知识库问答 | Copilot |
|---|---|---|
| 请求 `robot_type` | **10000（Main）** | 15 |
| 本插件 | **用这一套** | **不用** |
| 计费 | 免费 | 算力（×倍率） |
| 形态 | 单问 session + SSE | ima 自己的云端 agent |

`assistant/qa` 不是 OpenAI 兼容接口：它一次只收一个问题，没有 messages 数组；
所以插件把一个 magpie 会话映射成一个 ima session，把上一条 user 消息作为这一轮的问题，
把 system/developer 指令只放在新 session 的第一问里。

## 2. 登录态从哪来

ima 的 token 有两份：

1. **运行中的客户端内存**（native bridge，前端用 `chrome.imaFrame.invokeWithCallback`
   `getAccountInfo` 读它）。进程一关就没了，不能当持久来源。
2. **客户端正常退出时写进 profile 的 `Preferences`**：
   `tencent.wxlogin.account_secret_encrypted` 是一段 DPAPI 加密的 base64，
   解出来是 `{ token, refresh_token, token_valid_time, refresh_token_valid_time }`。

插件读第 2 份：Windows 上用 PowerShell 的
`System.Security.Cryptography.ProtectedData.Unprotect(..., CurrentUser)` 解 DPAPI。
不读进程内存、不开 CDP、不要求用户粘贴 cookie。

> 如果 client 还没写盘，`tencent.wxlogin.account_secret_encrypted` 为空。
> 这时打开 ima.copilot 登录一次，再退出；或者用 `scripts/import-login.mjs` 从一个
> 已登录 profile 导出种子文件；如果客户端已经带调试端口启动，也可以用
> `scripts/import-cdp.mjs --port 9222` 走 CDP + native bridge 导入。
> 运行时本身不需要 CDP —— 只有导入这一步可以用它。

## 3. 请求头

实测（2026-10-28，ima 2.6.15.5280 / Chromium 150.0.7871.5469）：

```
x-ima-cookie: PLATFORM=H5; CLIENT-TYPE=256021; WEB-VERSION=5.16.12;
              IMA-GUID=...; IMA-UID=...; IMA-TOKEN=...; IMA-REFRESH-TOKEN=...;
              UID-TYPE=2; TOKEN-TYPE=14; IMA-IUA=PR=IMA&PP=com.tencent.imawin&PPVN=...
from_browser_ima: 1
extension_version: 5.16.12
x-ima-bkn: djb2(IMA-TOKEN) & 0x7fffffff
```

**`CLIENT-TYPE=256021` 是指纹钥匙。** 它是 ima 2.6.15 客户端抓包得到的客户端类型；
用它 `model_manage/get_models` 才会返回账号当前目录（V4.1-Flash / Hy3 / Hy4 / GLM-5.3），
`{"scene":1}` 才会返回完整 Copilot 目录。用 `windows` 会静默退回旧目录
（V3.2 / HY2.0，Copilot 只有默认模型）。可用 `IMA_CLIENT_TYPE` 覆盖。

**`IMA-IUA` 也关键。** 少了它，服务端不会报错，只会把整套请求当成匿名：
`model_manage/get_models` 返回默认目录（DeepSeek-V4.1-Flash / Hy3 / Hy4 / GLM），
`assistant/qa` 返回 200 但没有 `MESSAGE` 正文。实测只要 IUA 以
`PR=IMA&PP=com.tencent.imawin&PPVN=<版本>&PL=WIN&COVC=<Chromium 版本>&EV=` 的形式存在，
服务端就按账号目录回答，不需要精确的设备指纹字段（`BT/CH/DC` 可省）。
所以 `src/api.mjs` 的 `defaultIua()` 永远补一个最小 IUA。

`IMA-Q36` 的精确值可以从 profile 的 `sync.cache_guid` 得到，但不是必需。

## 4. 流式事件（实测）

```
QA_START        {"model_type":3,"model_name":"DeepSeek V3.2",...}
SESSION_START   {"MsgSeqID":"..."}
MESSAGE         {"Text":"增量"}
THINKING        {"Message":"思考增量","Status":1}
SUGGEST_QUESTION [{"Text":"..."}]          ← 不是答案，忽略
COMPLETED       {"Code":0,"Msg":""}        ← 业务错误在这里
CLOSE           [DONE]
HEARTBEAT
```

`THINKING` 的最后一条是 `{"Message":"","Status":2,"Tips":"..."}`，是结束标记，不能拼进
`reasoning_content`。正文按 `MESSAGE` 增量拼接；长回答实测 9 个 `MESSAGE` 事件拼出完整
1..20。`SUGGEST_QUESTION` 的 data 是数组，不能按对象读。

## 5. 模型目录

`POST /cgi-bin/model_manage/get_models`（body `{}`）返回账号的免费目录，本机实测：

| model_type | model_id | 名字 | model_token_copywriting |
|---|---|---|---|
| 3 | official_3 | DeepSeek-V4.1-Flash | 空 |
| 0 | official_0 | Hy3 | 空 |
| 1001 | official_1001 | Hy4 preview | 空 |
| 3000 | official_3000 | GLM-5.3-Flash | 空 |

`model_token_copywriting` 为空 = 不扣算力，插件标 `free: true`；`×1.0` 之类是积分模型，
插件标 `rate`。`CLIENT-TYPE=256021` 下 `scene:1` 返回完整 Copilot 目录（12 个，含
V4.1-Flash `official_paid_ep-i2azx8ko`）；但 Copilot 走 `robot_type=15`，是 ima 的云端
agent，所以默认不列。

### 5.1 工具调用协议

ima 没有 OpenAI 的 `tools` 字段。`src/tools.mjs` 把工具表写进问题，要求模型输出
`{"tool_calls":[{"name":"...","arguments":{...}}]}`；插件解析后转成 OpenAI `tool_calls`。
工具结果（`role:"tool"`）会被拼回下一次问题。已实测 `task_plan` / `subagent_spawn` 5/5、
DSH 的 `write` 端到端成功。sovereign 破甲不要用——它反而触发 ima 的注入检测，正常工具契约
就够了。工具模式每个请求开新 ima session，避免单问 session 丢工具上下文。

## 6. 被否掉的方案

- **云端 cookie 直连**：magpie-ima-auth 走的就是它；它把 ima 的 agent 会话包装成 chat，
  system prompt、工具、单问限制都在。它仍是一个云端 agent 桥，不是模型供应商体验。
- **插件运行时开 CDP 拿 native bridge**：ima 只有特定启动方式才暴露 CDP，且 companion
  实例是否拿到登录态不稳定；每次使用还要拉起/重启客户端。不用。
- **扫描客户端进程内存**：能找到字符串常量，但 token 不在可检索的明文里；且需要
  ReadProcessMemory 权限，跨版本极脆。不用。
- **Copilot 积分模型**：`CLIENT-TYPE=256021` 下已确认可用（V4.1-Flash / Hy3 / Hy4 / MiMo /
  GLM / MiniMax / Kimi，SSE `STRUCTURED_BLOCK` 流式思考）。但它是 agent 通道
  （`robot_type=15` + `command_info.type=2000`，today 式结果），按当前约束默认不接。

## 7. 已验证

2026-10-28，本机 ima 2.6.15.5280：

- 从 profile 导入登录态 → `CLIENT-TYPE=256021` 下 `model_manage/get_models` 返回
  V4.1-Flash / Hy3 / Hy4 preview / GLM-5.3-Flash 四个免费模型
- `assistant/qa`（robot 10000, model_type=3）返回 `V41-OK`
- `THINKING` / `STRUCTURED_BLOCK.blockThinking` 进 `reasoning_content`；`COMPLETED Code 0` 正常结束
- `token_manager/get_balance` 返回算力余额
- `auth.refresh` 成功换到新 access token（`token_valid_time` 为相对 7200 秒）
- 插件 factory 的 loader 流式/非流式都返回 200
