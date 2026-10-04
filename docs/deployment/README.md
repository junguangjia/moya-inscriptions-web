# Deployment readiness

本目录只记录由艺（Yoyi）当前仍有效的 provider-neutral deployment
safety。Repository 尚未选择、购买、provision 或部署任何 production
provider/resource；这些文档不能作为真实外部操作授权。

## Active documents

- [PostgreSQL migration and readiness baseline (supported majors 16 and 18)](postgres-18-readiness-and-migrations.md)
- [Provider-neutral deployment checklist](deployment-checklist.md)
- [Provider-neutral rollback principles](rollback-plan.md)

Active guidance 保留以下已实现或稳定边界：

- migration command 与 production startup 分离；
- required migration ledger 在 listener 启动前只读验证；
- Web、Backend Runtime/API 与 Admin 的进程和端口分离；
- release artifact、configuration revision 与 Git SHA 可追溯；
- backup/restore、forward-compatible migration 与 rollback safety principles；
- Frontend 只消费 resolved `PublicMedia.src`，不接收 object key/provider
  config。

## Provider status

没有 current provider decision，也没有 active provider-specific IaC、environment
template、Web hosting target、object storage/CDN
configuration、domain 或 credential。任何 provider selection、production
deployment、purchase、credential 或 real resource operation 都需要独立 Owner
authority。

历史 T03 CloudBase candidate、candidate checklist、rollback text 与
`infra/cloudbase` examples 已移动到
[CloudBase T03 candidate archive](../archive/deployment/cloudbase-t03-candidate/README.md)。该 archive 非执行、非当前权威，也不授权创建资源。
