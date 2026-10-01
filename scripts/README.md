# Project scripts

跨工作区开发自动化脚本入口。当前没有图片处理、生产数据导入或部署脚本；新增脚本必须明确输入、输出、幂等性与密钥边界。

## Catalog Import Owner template

`generate-catalog-import-template.mjs`是dev-only、无密钥的可重复artifact
builder。输入是已build的internal `catalog-import/v1` semantic contract与
`catalog-import-xlsx/v1` layout spec；默认输出为repository中的safe blank
template，也可通过`--output`写入指定的开发临时路径。`--check`只在系统临时目录重建并比较normalized
OOXML-part fingerprint，不覆盖repository artifact。

Root scripts会自行build contracts：

- `pnpm generate:catalog-import-template`
- `pnpm check:catalog-import-template`

该脚本不读取production data、external Owner workspace、credentials或runtime
services。它只生成已实现 importer 所使用的安全空白工作簿模板，不能被apps、services或production
runtime依赖。

## Disposable test target

`disposable-test-target.mjs`是纯函数模块：一次性测试库的标记常量、只读探测 SQL、标记 SQL 与断言，不依赖任何包。`test-target.mjs`是命令入口：

- `node scripts/test-target.mjs check <VARIABLE>`：读取环境变量中的 PostgreSQL
  URL，先做静态检查（suite 名称规则、回环主机），再用已 build 的
  `services/catalog-postgres/dist` 只读探测数据库注释是否为
  `yoyi-disposable-test-target`，且连接到的库名与 URL 一致。
- `node scripts/test-target.mjs mark <VARIABLE> --yes`：显式给一个你确认可丢弃的库打标记；同样拒绝`yoyi_dev`和不含`test`/`synthetic`段的名字。

输入只有变量名，输出为一行 JSON（变量名、库名、结果或类别），从不打印连接串。幂等：重复`mark`结果相同。`verify.mjs test`、其触发的`migrate.mjs`（通过
`MOYA_EXPECT_DISPOSABLE_TARGET=1`）与`editorial/verify-cms.mjs`都在破坏性准备之前调用这些检查。

## Turbo cache prune

`turbo-cache-prune.mjs` is a dependency-free, dry-run-by-default maintenance
command for the shared local Turborepo cache (`<main checkout>/.turbo/cache`,
used by every linked worktree). `plan` (default, `pnpm cache:prune`) prints
totals; with `--plan-file` it writes a reviewable JSON plan that keeps every
archive an existing worktree currently hits (ordinary and verification runs),
every worktree HEAD's archives and recent history inside a size budget.
`apply --from-plan` deletes exactly that plan after re-checking file identity,
refuses incomplete or stale plans without an explicit flag, and is idempotent.
Path guards limit it to a real `.turbo/cache` directory and the three recognized
files per hash. Policy and limits: `docs/development/turbo-cache-retention.md`.
It never runs automatically.
