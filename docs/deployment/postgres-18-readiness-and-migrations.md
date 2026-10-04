# PostgreSQL migration and readiness baseline (supported majors 16 and 18)

## Supported PostgreSQL majors

| Major | Role                               | CI test image           |
| ----- | ---------------------------------- | ----------------------- |
| 16    | minimum supported Production major | `postgres:16.15-alpine` |
| 18    | newer validated major              | `postgres:18.4-alpine`  |

Production startup（`assertPostgresStartupReady`）只接受 major
16 或 18；未经验证的 major（包括 17）在 listener 创建前失败。GitHub CI 的 `test`
job 先在 18.4 上运行完整 test milestone，再用
`node scripts/verify.mjs postgres --profile complete`
在 16.15 上运行同一套 migrations 与 PostgreSQL integration suite；`cms`
job 在两个 major 上都运行 Payload migrations/integration 与 native Owner browser
flow。本地 Compose 与 Development 仍固定 `postgres:18.4-alpine`。

Migrations、named runtime grants 与 runtime
queries 必须在 16 与 18 上都有效。只在较新 major 存在的 privilege 或语法（例如 PostgreSQL
17 起的 `MAINTAIN` privilege）只能按 `server_version_num`
条件执行；不得为此修改已记录 checksum 的 historical
migration。新增或更换 major/minor 必须作为显式 infrastructure maintenance
change，同时更新 Compose、CI、本文件与 readiness
allowlist，并在受支持的 major 上重新运行真实数据库测试。

## Deployment order

```text
explicit migration command
→ verify success
→ start production backend
→ read-only required-ledger validation
→ listener starts
```

普通production
startup不执行DDL、不创建`schema_migrations`、不自动应用migration。required
migration缺失或checksum不匹配时，listener创建前失败。数据库可以包含当前binary未知的更新ledger
row；这只说明当前binary所需migration仍存在，不代表rollback到旧binary安全。

未来schema演进必须采用经审核的backward-compatible
expand/contract策略。drop、rename、不兼容类型变化或其他destructive
migration必须经过独立compatibility checkpoint。

## Content-source routing

`pnpm db:migrate` 必须按 `MOYA_CONTENT_SOURCE` 选择唯一迁移路径：

- `legacy`：`DATABASE_URL` → `database/migrations`。
- `payload`：`CMS_DATABASE_URL` → `apps/admin/src/migrations`。

不得混用两套 schema。Payload readiness 检查其 published views；legacy
readiness 检查 legacy migration ledger。生产进程不执行 migration，也不自动 push
schema。开发配置与操作见
[development](../development.md)，正式角色/TLS 与操作顺序见
[production](../../infra/production/README.md)。

## Health semantics

Production composition把PostgreSQL readiness注入唯一的`GET /health`：

- PostgreSQL可用：`200 {"status":"ok"}`；
- PostgreSQL不可用：既有`SERVICE_UNAVAILABLE` error envelope与HTTP 503。

T05.2没有新增第二个endpoint。部署平台不得在没有独立deployment
decision的情况下把这个DB-aware readiness endpoint同时当成process liveness
probe；否则短暂数据库故障可能导致不必要的process restart。
