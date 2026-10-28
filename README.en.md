# ima.copilot (local client) for magpie

**Put the free models of the ima.copilot desktop app in front of your agent — no cookie to paste, and no ima cloud agent in the path.**

```text
Sign-in   the ima.copilot client already signed in on this machine (DPAPI profile / seed file)
Models    DeepSeek / Tencent HY, free Q&A; Copilot credit models are not listed
Streaming MESSAGE text + THINKING reasoning as SSE
Usage     free Q&A spends no 算力; the card shows the account's balance
```

## What it does

- Imports the sign-in the ima.copilot client wrote to its profile (Windows DPAPI); no DevTools cookie copying.
- Reads the account's own model catalogue from `/model_manage/get_models`; a static table covers the signed-out state.
- Streams `MESSAGE` deltas and sends `THINKING` deltas to `reasoning_content`.
- Keeps one ima session per magpie conversation (30 min TTL, 60-turn backstop), carrying recent turns into a new session.
- Uses `robot_type=10000` (plain Q&A) only. Copilot (`robot_type=15`) is ima's own cloud agent; it is neither listed nor called.

## Models

**DeepSeek / Tencent HY** — the real list follows the account and client version.

| Vendor | Model | Thinking | Billing |
|---|---|---|---|
| DeepSeek | `deepseek-v3.2` | — | free (knowledge-base Q&A) |
| DeepSeek | `deepseek-v3.2-think` | ✓ | free |
| Tencent | `tencent-hy-2.0` | — | free |
| Tencent | `tencent-hy-2.0-think` | ✓ | free |

Copilot credit models are deliberately not listed: they are an agent channel, and the client tested answers
"当前版本暂不支持" for them.

## Install

Search `magpie-ima-local-auth` under **Plugins → Discover**, then **Sign in → Use ima.copilot on this machine**.

The ima.copilot client must have been signed in once on this machine. If magpie can't find the sign-in,
run `node scripts/import-login.mjs --profile "<ima User Data directory>"` or set `IMA_COPILOT_LOGIN_FILE`.

## Limits

No tool calls, no image input, no token counts (ima reports none), Windows-only sign-in import. The model
catalogue's context window is not published by ima; `limit.context` is left 0.

## Licence

MIT. ima and ima.copilot belong to Tencent; this is a third-party plugin, not an official one.
