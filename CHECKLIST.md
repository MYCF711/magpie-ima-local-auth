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
