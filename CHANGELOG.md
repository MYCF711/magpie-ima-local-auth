# 更新记录

## 0.2.0 — 2026-10-28

- **修复客户端指纹**：`x-ima-cookie` 的 `CLIENT-TYPE` 改为 ima 2.6.15 实际值 `256021`。没有它，服务端静默退回旧目录（DeepSeek V3.2 / HY 2.0，Copilot 只有默认模型）；有了它，免费目录变为 **DeepSeek-V4.1-Flash / Hy3 / Hy4 preview / GLM-5.3-Flash（各带 Think 变体）**，Copilot `scene:1` 也能读到完整积分目录。
- 静态兜底模型同步为 V4.1-Flash / Hy3 / Hy4 preview / GLM-5.3-Flash。
- `scripts/import-cdp.mjs` 写入 `clientType`；`IMA_CLIENT_TYPE` 可覆盖指纹。
- README / docs 更正“V4.1 标签实际是 V3.2”的错误归因：那是旧 `CLIENT-TYPE` 造成的降级。

## 0.1.1 — 2026-10-28

- 兼容 ima 客户端 UI 新版的 `STRUCTURED_BLOCK` 流事件（`Data.text_message` 正文 / `Data.thinking_message` 思考），与旧版 `MESSAGE` / `THINKING` 同时支持。
- 新增 `scripts/import-cdp.mjs`：从带调试端口的 ima.copilot 走 CDP + native bridge 导入登录态。
- 补充 `docs/evaluation.md`：UI 的 V4.1-Flash 标签在测试账号实际发 `official_3` / `official_1`，账号目录对应 V3.2 / V3.2 Think。

## 0.1.0 — 2026-10-28

- 首个版本：从本机 ima.copilot 客户端导入登录态（Windows DPAPI / 种子文件），
  把账号的免费知识库模型（DeepSeek V3.2 / Tencent HY 2.0，含 Think 档）接进 magpie。
- 流式 `MESSAGE` 与思考 `THINKING` 转 OpenAI Chat Completions；支持非流式。
- 多轮 session（30 分钟 TTL、60 轮兜底）、`auth.refresh` 续期、算力余额展示。
- 不列 Copilot：ima 的 Copilot 是云端 agent，本机 2.6.15 对它的问答返回「当前版本暂不支持」。
- 不依赖 cookie 粘贴、不开 CDP；`IMA-IUA` 缺失会让 ima 把请求当匿名，插件默认补最小 IUA。
