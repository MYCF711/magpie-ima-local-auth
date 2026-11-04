# CHECKLIST

## A · 交付前

- [ ] `node scripts/check.mjs` 退出码 0
- [ ] `node --test` 全绿
- [ ] `config.models` 有 4 条静态兜底
- [ ] `authorize()` 立刻返回；导入在 callback 里
- [ ] `refresh` 只返回合并字段
- [ ] `usage.windows` 没有假 `used` / 假 `limit`
- [ ] 模型级错误用 404；登录失效才用 401
- [ ] `IMA-IUA` 默认补上
- [ ] DSH 上下文消息过滤
- [ ] 流末有 `finish_reason:"stop"`

## B · 发版前

- [ ] CHANGELOG 有当前版本
- [ ] bump version
- [ ] `npm pack --dry-run` 看到 README / CHANGELOG / docs
- [ ] commit + push 功能分支，PR 的 `rules` 全绿后合并（禁止直接推 main）
- [ ] `npm publish`
- [ ] tag `v<version>` + GitHub Release
- [ ] 四条验证：npm version / tarball / magpie plugin list / Release 200

□ 1. 出站 User-Agent 是官方客户端 UA，不是我们自己的产品名
      判据：node scripts/check-ua.mjs . 退出码 = 0；
            插件里搜不到 `magpie/…` / `magpie-xxx/<ver>` / `"node"` / `Bun/…` /
            截断的 Mozilla（缺 `(KHTML, like Gecko) Chrome/… Safari/537.36`）；
            官方是网页的是完整 Chrome UA，有 App / CLI 客户端的是那个客户端的 UA；
            loader 的 `fetch` 包装里 `"user-agent"` 在跳过名单内、由插件补官方值
      出处：模板坑表第 38 条 · scripts/check-ua.mjs
