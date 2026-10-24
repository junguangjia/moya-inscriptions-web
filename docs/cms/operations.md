# P2-04 部署、恢复与日常操作

状态：Payload Admin 已合入主干，Stage A 已完成；Stage
B、正式迁移与切换尚未执行。本文保留 CMS 日常操作和恢复边界；环境准备见
[development](../development.md) 与
[production](../../infra/production/README.md)。实现范围及历史证据见
[实施记录](p2-04-implementation.md)。所有示例均为占位符或虚构数据。

## 日常使用

Owner 在 Payload 原生后台编辑资料、比较版本及发布/撤回；修改后等待自动保存完成。未完成资料可以保存；发布前会列出缺失或不合法字段。释文使用纯文本，状态切换与文字必须一致。沿用既有契约的长度和首尾空白限制；非法输入会被拒绝，程序不会自动 trim 或改写原文，合法内部空白和换行按原值保存。媒体从原生上传/选择窗口加入有序快照，无需手工填写媒体身份或对象键。原图替换、删除和既有权利/顺序置信度修改被禁用；LOW 保留为提示，不由程序推测提升。

“批次审核”页列出草稿与公开版本的字段差异、缺项和修订号。Owner 选择已经检查的记录及受限自动化身份，一次批准一个明确批次。Codex 执行批准时，变化的条目单独冲突，其他仍符合批准的条目可以完成。历史恢复产生新的草稿；恢复后需重新检查并发布才影响公众。

自然语言入口示例：“把这批获准资料录入为草稿，保留原文与不确定性”；“修订这几条资料的来源说明，先让我看差异”；“上传这批已批准原图并关联到已有记录”；“执行后台已经批准的批次并报告失败项”。项目 Skill 位于
`.agents/skills/yoyi-editorial/SKILL.md`。模型负责范围、问题汇总及少量必要字段，确定性程序负责全文和文件字节。Owner 无需制作 JSON、CSV、XLSX、计算哈希或逐张执行技术操作。

## 应用与配置

保留现有 Next 16.3.0、React 19.2.8、TypeScript
6.0.3。Payload 及官方 PostgreSQL、MCP、S3、UI、翻译包固定为 3.88.0（MIT）。新增 GraphQL 仅满足官方依赖，GraphQL 管理路由关闭。Sharp
0.35.4（Apache-2.0）只用于文件核验；不配置 Payload 全局 Sharp，避免对已批准 WebP 自动再编码。Zod
3 别名用于官方 MCP 参数类型，不替换既有 Zod
4 公开契约。直接及传递版本以锁文件为准。

新增运行配置仅放在受控服务端文件/秘密管理中：
`CMS_SECRET`、`CMS_DATABASE_URL`、`CMS_MEDIA_DIR`、`CMS_STORAGE_MODE`。COS 模式另需
`CMS_COS_ENDPOINT`、`CMS_COS_REGION`、`CMS_COS_BUCKET`、
`CMS_COS_ACCESS_KEY_ID`、`CMS_COS_SECRET_ACCESS_KEY`。浏览器不接收这些值。
`CMS_ENVIRONMENT=synthetic` 只用于隔离的回环数据库验收。

预览使用 `CMS_PUBLIC_URL`（Admin 对外入口）、`CMS_PREVIEW_WEB_URL`
（Web 对外入口）和
`CMS_INTERNAL_URL`（Web 服务端到 CMS 的固定入口）。Admin 与 Web 的对外主机名必须一致，以共享 Payload
host-only 会话 Cookie；本地合成验收可使用不同端口。真实入口通过现有受限 HTTPS 反向代理分流，保持 TLS、期限和访问保护。预览不缓存，不发送公开链接或独立预览令牌。

数据库使用新数据库或事先明确隔离的结构。Payload adapter 的
`push:false`；仅运行提交的官方迁移。CMS 数据库连接上限为 5。普通用户驱动 Local
API 显式传递可信 req/user、`overrideAccess:false`，更新同时使用
`overrideLock:false`。业务修订检查使用同一 PostgreSQL 事务中的锁。

常用受控命令：明确 `MOYA_CONTENT_SOURCE=payload` 后运行 `pnpm db:migrate`、
`pnpm --filter admin cms:types`、`pnpm --filter admin cms:importmap`、
`pnpm --filter admin build`。构建使用临时无效数据库参数，不连接运行库。部署制品须在目标平台或相同平台的构建环境生成；不能把本机 macOS 的 Sharp/Node 依赖复制到 Linux。生产运行加载真实受保护配置再启动；禁止向生产调用开发 schema
push 或合成 bootstrap。新目标先在受限网络内完成 Owner 初始化，再开放受保护入口。部署身份、内容操作身份、Public
API 只读身份与 COS 权限分别保持最小范围。

## Codex MCP 与批处理

官方 MCP 路由为
`/api/mcp`。自动化只授予查询、必要字段读取、草稿保存、批次结果及执行已有批准的工具权限；普通集合 CRUD 不暴露。原生 Users
REST API key 用于确定性批处理，官方 MCP key 用于 MCP
Bearer，两者与部署凭据分离。Owner 创建账号及工具范围，自动化不能解锁/管理其他账号。

客户端仅新增本任务服务器项；先核对并保留其他配置。模板：

```toml
[mcp_servers.yoyi_editorial]
url = "<AUTHORIZED_MCP_ENDPOINT>"
bearer_token_env_var = "YOYI_EDITORIAL_MCP_TOKEN"
enabled_tools = ["editorial_query", "editorial_read", "editorial_save_draft", "editorial_publish_approved", "editorial_batch_results"]
startup_timeout_sec = 45
tool_timeout_sec = 30
```

真实 URL/令牌不写入仓库；令牌由受控启动环境注入。持久客户端修改须有本任务的具体授权，修改后新开 Codex 会话/重启客户端，使服务器配置重新加载。工具许可提示仍须按当前客户端策略处理；不得用关闭审批绕过失败。MCP 初始化、REST 成功与 Codex 实际工具调用分别记录。

现有 HTTPS 入口若也占用 `Authorization` 做 Basic 身份验证，会与 MCP
Bearer 冲突。具体目标需核实代理配置；保留现有入口保护，把 CMS
Bearer 透传至 CMS，必要的上游身份验证使用已批准的兼容通道。不得取消 CMS 鉴权、开放原始管理端口或改用新网络平台来绕过冲突。

程序准备受保护清单后运行 `scripts/editorial/batch.mjs`：默认 dry-run；执行时增加
`--execute --config <PROTECTED_CONFIG> --receipt <PROTECTED_RECEIPT>`。每项稳定 replay
key 与业务身份分离；默认 2 并发、3 次尝试、30 秒请求超时、120 秒批次预算、最多 10000 项。成功项在恢复时跳过；失败项有限重试。正文通过文件读取原样传递，媒体通过官方 multipart 上传；不从清单 URL 取文件。回执以 0600 日志逐项同步后压缩成快照。非正常终止后，先确认记录进程已结束，再移除该回执的残留锁并续接；不自动删除对象或替换业务身份。

### Catalog 原图直传（catalog-scale-v1 增量 2）

`scripts/editorial/direct-ingest.mjs`
把 Catalog 原图（单帧 JPEG、PNG 或 WebP，最大 128 MiB、1.2 亿像素、解码后 512
MiB、每边 65,500 px，解码后每行（宽 × 通道 × 每样本字节）不超过 256
KiB，即 16 位 RGBA 的 PNG 最宽 32,768
px；JPEG 只收 8 位样本，渐进式 JPEG 的 DCT 系数缓冲（每个分量的 8×8 块数 × 128
B）不超过 512 MiB，隔行（Adam7）PNG 解码后不超过 256
MiB；每边与每行两项以及这三条由 Development 渲染实测确定，见
[catalog-scale-bench](../development/catalog-scale-bench.md)）用一次签名 PUT 直接写入私有桶的暂存键
`catalog-ingest/v1/`；原图字节不经过 artvenn.com、EdgeOne、nginx 或 CVM。Admin 只收到
`start`、`complete`（必要时
`abandon`）控制请求，由服务端读取暂存对象、校验、复制到内容寻址的 `editorial/`
键并登记，客户端不回读。Admin 须已打开 `CMS_CATALOG_INGEST`（Owner 步骤见
[production](../../infra/production/README.md)
的增量 2 一节）；开关关闭时路由不存在（404），40
MiB 以内的文件自动改走既有续传通道，更大的文件以 `MEDIA_INGEST_UNAVAILABLE`
失败。原生上传和续传通道仍是 40 MiB / 8000 万像素。

开关打开后 Admin 另读两个 `on`/`off`
设置：`CMS_CATALOG_INGEST_SERVER_SHA256`（默认 `on`，`complete`
读取并哈希暂存对象；`off`
时只核对 MD5/ETag、文件头和结尾，SHA-256 留给 worker 渲染前校验，决定 D9）和
`CMS_CATALOG_INGEST_STAGING_TAG`（默认 `off` 即生命周期 L2；`on`
为 L1，决定 D8）。设置无效时每个直传请求都以 503 `INGEST_CONFIGURATION_INVALID`
拒绝。L1 下 Admin 在读取或复制之前要求 COS 对暂存对象的 HEAD 报告恰好一个标签（`x-cos-tagging-count`，预演探针
`head-tag-count`）；COS 不报告时每次 `complete` 都是 503
`INGEST_CONFIGURATION_INVALID`，应改用 L2。复制使用 S3
API 写法（`x-amz-copy-source`、`x-amz-copy-source-if-match`、`x-amz-metadata-directive: COPY`，L1 下
`x-amz-tagging-directive: REPLACE`），签名 URL 带 SDK 的
`x-id=PutObject`；`COPY` 会把暂存对象的元数据原样带到原图上，所以 `complete`
在复制之前检查暂存对象的 HEAD：Content-Type 与意图不同，或出现签名 PUT 从不写入的内容（`Content-Encoding`、`-Disposition`、`-Language`、`Cache-Control`、`Expires`、用户元数据、非标准存储类型、SSE-COS（AES256）以外的加密、签名标签以外的标签）时，删除暂存对象并以422
`INGEST_STAGING_INVALID` 拒绝，`editorial/`
下什么也不写；已有的最终对象出现这些内容时不读取，直接 500
`INGEST_FINAL_INVALID`。预演由 Owner 在 CVM 上用 Admin 自己的代码运行（`apps/admin/scripts/catalog-ingest-probes.ts`，步骤见
[production](../../infra/production/README.md)）。

`CMS_CATALOG_INGEST_SERVER_SHA256=off` 时 `complete`
不计算任何哈希，直接把客户端声明的 SHA-256 登记为内容寻址键：`editorial/`
对象键和媒体记录都带这个值，字节只核对暂存 ETag（即正文的 MD5）、图像文件头和结尾。声明的 SHA-256 与字节不符时，要到 worker 渲染这张原图时才发现（`source_hash_mismatch`，不发布），而此时该 mediaId 和它的
`editorial/` 对象已被占用：媒体删除已禁用，Admin 也不能删除
`editorial/`。因此保持
`on`，除非 S0 检查表明 Admin 的 COS 主机解析到公网地址，并且 Owner 接受这一风险。

```sh
node scripts/editorial/direct-ingest.mjs --manifest <PROTECTED_MANIFEST>
node scripts/editorial/direct-ingest.mjs --manifest <PROTECTED_MANIFEST> --execute --config <PROTECTED_CONFIG> --state <PROTECTED_STATE>
node scripts/editorial/direct-ingest.mjs --manifest <PROTECTED_MANIFEST> --abandon --config <PROTECTED_CONFIG> --state <PROTECTED_STATE>
```

清单为 `{version: 1, batchId, items}`，最多 10000 项；每项含
`key`、`file`（清单所在目录之内的相对路径：URL 以 `MEDIA_INPUT_INVALID`
拒绝；绝对路径、跳出该目录的 `..`
和经过符号链接的目录在读取任何文件、发出任何请求之前以 `MEDIA_PATH_INVALID`
拒绝整批，目录按真实路径比对，名称须与磁盘一致（包括大小写和 Unicode 规范化形式 NFC/NFD，打包时按
`readdir`
返回的原样写目录名）；文件本身不能是符号链接）、`mimeType`、`catalogId`、`mediaId`、`sha256`、`bytes`、`width`、`height`、`alt`，以及可选的
`rights`、`orderConfidence`。读取原图时只打开检查时确定的真实目录中的文件：macOS 上整条路径都不跟随符号链接；其他系统在打开后核对目录的真实路径和文件的设备号与 inode，能写批次目录并不停来回替换其中目录的人仍有很小的机会读到目录外的文件（其大小、SHA-256 和文件头还须与清单一致），因此批次目录只应由运行者本人可写。`width`、`height`
取自打包阶段的完整本地解码（Sharp `metadata()` 加 `stats()`，`limitInputPixels`
120000000），服务端会与读到的尺寸比对；CLI 清单中二者必填，缺少时以
`MEDIA_INPUT_INVALID`
拒绝。配置文件须为 0600：`{baseURL, apiKey 或 sessionToken, cosHostSuffix}`，可选
`concurrency`（最多 4）、`completeConcurrency`（最多 2）、`attempts`（最多 3）、`budgetMs`。`cosHostSuffix`
是公共 COS API 端点主机（例如
`cos.<region>.myqcloud.com`）；只有其下桶主机上、路径为
`/catalog-ingest/v1/<2>/<64>` 的 https URL 才会收到原图字节。

默认 dry-run 只校验本地文件，不发请求。`--execute` 时最多 4 个 PUT、2 个
`complete` 同时进行（约 4×128 MiB 内存）；状态文件为 0600
JSONL，已登记项续接时跳过，上次已暂存的项续接时只调 `start` 和
`complete`，不再重传。该 mediaId 若已由续传通道或别的凭据登记，则复用该记录：`complete`
复用时服务端删除调用者自己的暂存对象；PUT 之后（含续接）`start`
就答已登记时，客户端先 `abandon`
自己的暂存键再复用（尽力而为，生命周期规则兜底）。`start`、带 forbid-overwrite 的 PUT 与
`complete` 都可安全重复：502、504 或无响应按不确定处理并重试（`complete`
等待 75 秒，超过 nginx 的 60 秒，服务端期限为 45 秒）；PUT 遇 403 或签名临近过期时重新签名，遇 409 说明已暂存，直接
`complete`。最终失败时调用 `abandon`
删除暂存对象；可重试的失败（包括 Admin 直传配额的 `INGEST_QUOTA_EXCEEDED` 和
`INGEST_BUSY`）保留暂存，项目保持待续，稍后重跑即可续接；出现
`INGEST_QUOTA_EXCEEDED` 后本次运行不再开始新项目，其余项目保持待续；`--abandon`
清理整批未登记项（L2 生命周期下每批之后运行；关闭开关或回退 Admin 之前也要先运行，之后
`abandon` 不再存在）。暂存键由 Admin 按调用者推导，所以 `--abandon`
必须用跑这一批的同一凭据和同一状态文件：输出
`abandoned`（确实删除）、`absent`（该身份下没有暂存对象）、`notStarted`，别的凭据开始的项目计为
`INGEST_ACTOR_MISMATCH` 且不动；没有状态文件时以 `STATE_NOT_FOUND`
拒绝。续接（再次
`--execute`）同样必须用开始这一批的凭据：已记录暂存键的项目若拿到别的身份的授权，以
`INGEST_ACTOR_MISMATCH`
停止，保留记录和已暂存的对象，不在新身份下 PUT、`complete` 或
`abandon`；暂存键确认已清空（最终失败时 `abandon` 成功，或 `--abandon`
成功）后才解除这一绑定。Codex 自己脚本的批次由该脚本用其身份放弃。`complete` 或
`abandon` 等不到该 mediaId 的锁（续传通道正持有）时答 409
`CONCURRENT_OPERATION_BUSY`，什么也没改变，客户端按可重试处理，不放弃暂存。每次运行在第一张新登记的原图之后，对其最终对象做一次匿名 Range
0-0
GET（期望 401 或 403）；能匿名读取时立即停止整批。标准输出只有计数和固定代码（`registered`、`pending`、`privacy`、`codes`
等）以及只含数字的 `metrics`：`putAttempts`、`failedPuts`、`largePuts`（40
MiB 以上且发过 PUT 的原图数）、`largePutsFailedOnce`（其中至少一次 PUT 失败的）、`putMiBps`、`putMs`、`completeMs`（各为中位数、最小、最大）；每张图自己的 PUT 耗时与状态、`complete`
耗时记在 0600 状态文件该项的 `metrics`。金丝雀批次据此记录（见
[production](../../infra/production/README.md)
第 6 步）。输出从不包含 URL、对象键、桶主机、凭据或响应正文；有失败、待续或隐私检查未通过时退出码为 1。`codes`
保留 Admin 的直传代码（例如
`INGEST_CONFIGURATION_INVALID`、`INGEST_STORAGE_UNAVAILABLE`、`INGEST_DEADLINE_EXCEEDED`、`INGEST_FORBIDDEN`）；其中 5xx 按不确定处理并有限重试，项目保持待续。

运行期间状态文件旁有 `<PROTECTED_STATE>.lock`（含 `pid`
和开始时间）。进程被强制终止后锁会残留，之后的运行以 `STATE_LOCKED`
拒绝：先确认记录的进程已结束，再删除该锁文件并续接；不要删除状态文件本身。

### 给 Codex 私有批处理脚本的修改说明

Codex 的私有批处理脚本（`execute_catalog_upload_v4.mjs`，在仓库之外）由其维护者按以下要求修改，修改后先跑 10 张金丝雀批次：

1. 许可范围：在其主机和路由白名单中只加入以下三类请求，其余 Admin 路由以及 COS 路径、方法和主机一律拒绝：
   - Admin 的
     `POST /api/editorial/media-ingest/start`、`/complete`、`/abandon`，以及第 5 项的
     `/verify`；
   - 配置的 COS API 主机后缀之下、路径为 `/catalog-ingest/v1/<2>/<64>` 的 https
     PUT：不带 Authorization、Cookie 或会话令牌，拒绝重定向，只发送 `start`
     返回的签名头，不增加任何 `x-cos-`/`x-amz-` 头；
   - 第 4 项的匿名 GET，每批恰好一次：只带
     `Range: bytes=0-0`，不带 Authorization、Cookie、会话令牌或查询串（不复用任何签名），拒绝重定向；目标只能是与本批签名暂存 URL 同一桶源（https、同一主机、默认端口）上形如
     `editorial/<64 hex>/<64 hex>-<64 hex>.(jpg|png|webp)` 的最终对象键。这与
     `createCosClient` 的 `checkPrivate` 相同。
2. 上传：改用本仓库的
   `stageMediaUpload({uploadMode: "direct-cos-v1", putObject, cosHostSuffix, ...})`（`scripts/editorial/resumable-upload.mjs`）和
   `createCosClient`（`scripts/editorial/direct-ingest.mjs`），或直接运行上面的 CLI。40
   MiB 以上的文件不再走续传通道。
3. 去掉完整回读：删除经 artvenn.com `/api/media/file/<filename>`
   的认证全字节回读（原脚本约第 320 行）。完整性由服务端在 `complete`
   时的哈希和结构检查（D9 回退时为 MD5/ETag）以及 worker 渲染前的 SHA-256 校验保证；只需把
   `complete` 返回的 `validatedBytes`、`validatedSha256`、`validatedMd5`
   与本地值比对。
4. 每批保留一次匿名 Range
   0-0 隐私检查（原脚本约第 330 行），按第 1 项许可的形式发出：对象改为本批一张新登记原图的最终对象，直接在 COS 桶主机上检查，期望 401 或 403；能匿名读取时停止整批。不要再经
   `/api/media/file/*`。CLI 已实现这一检查。
5. 需要抽样复核时，调用 Admin 的
   `POST /api/editorial/media-ingest/verify`（`{mediaId}`，服务端重算哈希，与
   `complete` 共用队列和每小时字节预算），不做客户端回读。
6. 签名 URL、对象键、桶主机和响应正文都不得写入日志、进度文件、回执或代理上下文（修正案第 17 条）；脚本的会话身份同样受 Admin 的直传配额约束（每个身份最多 32 个未完成、每小时 4
   GiB 签名字节和 4 GiB `complete` 读取字节，全局各每小时 12
   GiB；放弃或被拒的项目再次 `start` 时重新计入）；遇 `INGEST_QUOTA_EXCEEDED`
   时停止开始新项目，未开始的项目留待下一小时续接。
7. 准备（prepare）的节奏：正式 CLI 在 S4b 之前读不了 40
   MiB 以上的原图，含这类原图的记录只能由脚本直接调用
   `POST /api/editorial/prepare-catalog-delivery`（须经 Owner 批准）。每次准备之前先调用
   `POST /api/editorial/catalog-render-backlog`（空请求体），并与 CLI 用同一规则：前方图片数为
   `max(t0+t1+t2+t3, queued+running) + preparedSince`（`preparedSince`
   含计数时刻前 10 分钟起开始准备的意图：宁可重复计入而不漏算，前提是准备耗时加上两端时钟偏差不超过 10 分钟），按每分钟 7 张超过 720 分钟时不准备，等待至少
   `前方图片数 / 7 - 720` 分钟（不少于 5 分钟）后再读；`tiers`
   为 null（从未计数）、`countedAt`
   早于 60 分钟或比本机时钟快 5 分钟以上、或请求失败时一律不准备。Admin 本身不会因积压拒绝准备，所以这一步不能省略。

## 迁移与切换

离线转换器只接受现有表的明确导出及已有身份/媒体元数据。缺少来源映射、权利、字节校验或顺序置信度时阻断；不会从摘要重建原文或推导 SourceId。单一已存来源可直接承接；多来源需要已知主来源映射。报告只含计数、固定字段名和错误类别。真实导出、草稿内容和映射计划留在受控私有位置。

通过 `pnpm --filter admin cms:legacy`
的显式 dry-run/apply 操作执行：先验证完整输入，再检查目标 Owner 身份及既有映射；原媒体只登记元数据，不调用上传。资料默认草稿；完整正文和关系经同一服务端校验保存。重跑必须命中相同身份/内容或稳定回执；有差异时停止相关项，不覆盖未知编辑。

```sh
pnpm --silent --filter admin cms:legacy --mode dry-run --source "$CMS_LEGACY_EXPORT"
pnpm --silent --filter admin cms:legacy --mode apply --source "$CMS_LEGACY_EXPORT" --target "$CMS_LEGACY_TARGET" --settings "$CMS_LEGACY_SETTINGS"
```

上述变量由受控程序指向已批准的受限文件和目标别名，不在聊天或日志打印。
`--silent` 避免包管理器回显私有文件路径；包脚本已包含 Payload 所需的 `--`
分隔符，调用者无需再加。源文件和设置文件须由当前用户持有、权限 0600，禁止符号链接。设置格式为
`{target, baseURL, ownerApiKey, environment}`，真实值仅放在受限设置文件；
`environment` 为 `production` 或回环合成环境
`synthetic`。dry-run 不需要运行库或凭据，不会连接数据库；READY 返回 0，BLOCKED 返回非零。apply 必须先取得本节所列真实环境授权。

切换前一次确认：明确源/目标和受保护验收入口；源备份与目标恢复证据；三条资料/20 张媒体范围及逐项文本/映射/字节核验；旧写身份冻结方式；预期影响和停写窗口；回退期限、增量保存及费用。既有权利和身份无需重批。在批准前不读取未知远端库、不复制真实数据到合成库、不改真实云权限。

发布读取选定 `MOYA_CONTENT_SOURCE=payload` 后使用同库只读视图；原 Public
DTO、列表/详情/搜索/计数由已发布快照提供。Public
API 身份仅获这些视图 SELECT 权限，另仅授予 `payload_migrations` 的 `name`
列 SELECT 用于启动版本核对；不能读原生草稿表或写表。启动会检查视图及迁移版本。切换同时冻结旧导入操作身份的写权限并检查它实际不能继续写；线上依赖确认结束后才移除仅服务旧入口的正常命令/依赖。现有运行环境的内容源不由本轮更改；本地新开发环境默认 Payload。

## COS、备份与恢复

S3 adapter 使用 COS virtual-host
addressing、服务端上传和官方签名协议；管理侧文件由受保护接口读取。原 key 归一化或原生 filename 唯一约束不兼容时明确阻断并保留原对象，不能靠改名/重传使迁移成功。实际 COS 验收覆盖匿名拒绝、旧对象 GET/字节一致、新对象授权写入、失败恢复和 HTTPS；本地存储测试不能代替。上传与数据库不是跨系统原子事务。未知云端上传结果按同一业务身份核对续接，不能声称所有失败都没有产生对象，也不能擅自批量删除孤立对象。

备份包含一致 PostgreSQL
dump（含账号、修订、身份占用和回执）与配置版本；对象字节独立保留。备份文件、账号及配置不得进入 Git、CI 附件或诊断输出。目标恢复到隔离库，核对迁移、计数、正文、身份、修订及媒体关联后重启并实测。回退时先暂停 CMS 写入、保全切换后增量及相关对象，再恢复旧读取入口和明确批准的旧写权限。不能只恢复旧备份而丢弃新编辑。旧库删除另行授权。

## 尚待验证与 Owner 介入

真实三条资料/20 媒体与 COS 目标、受限入口认证、持久客户端接入、切换和费用，以及机器验证/独立审查后的 Owner 后台工作流验收尚待完成。本机打包运行预热后约 405
MiB RSS；整仓并行构建子进程合计峰值约 3.39
GiB。四并发写入 10000 条合成草稿用时约 33.4 秒、进程峰值约 691
MiB、数据库增长约 21.5
MiB，连接池上限 5。现有 2GB 机器容量不能由这些数值推断；构建应在已授权且有足够内存的环境完成，目标机仍需留出 PostgreSQL、Web、代理和系统余量后再决定容量。未购买任何新服务。尚未完成表格入口实际退役。

参考：[Payload 文档](https://payloadcms.com/docs/getting-started/installation)、
[官方 MCP](https://payloadcms.com/docs/plugins/mcp)、
[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、
[客户端配置](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 可重复检查与依赖限制

日常验收仍使用 `pnpm verify`，总执行预算不变（120 秒）。CMS 专项另用
`CMS_TEST_DATABASE_URL` 明确指定隔离的回环测试数据库，运行
`pnpm test:cms`；只接受专用测试参数，不回退普通运行库。首次原生浏览器验证在该库的迁移/集成检查及 Admin 构建完成后运行
`pnpm test:cms:browser`。脚本创建虚构账号及本地媒体，首次运行要求这些账号不存在；重跑使用新的隔离数据库，不能对真实库调用。CI 中的独立
`cms` job 执行这套链路，完整公开端浏览器回归仍由既有 CI 运行。

官方 MCP
SDK 的协议查询、草稿创建、必要字段读取和重放已经通过。早期 CLI 工具审批失败保留为历史记录；后续 Stage
A 已完成受限工具调用验证。Stage A 完成不代表正式内容源切换、Stage
B 或 Production 发布。

最终锁文件审计仍有三个 moderate，high/critical 为零：

- Payload
  3.88.0 的账号 unlock 权限公告：目前注册表无可安装的 3.88.1；已显式限制 Users
  unlock 为 Owner，MCP
  key 禁止 unlock，并用真实数据库验证匿名/自动化/跨账号解锁拒绝。保留上游风险，更新可用后需独立评估补丁。
- 旧 esbuild CLI
  loader 的开发服务器公告：来自官方迁移工具链，不作为公开开发服务器运行；不伪造不可安装的补丁版本。
- 既有 ExcelJS 链路的 uuid 公告：保留旧入口直到批准切换，不跨范围升级依赖主版本。

官方 MCP 包与 mcp-handler 的 SDK
peer 声明仍不完全匹配；锁定官方稳定版本后的构建和真实协议检查已通过，但 peer
warning 仍保留。Sharp 已修补至 0.35.4；DOMPurify/Nanoid 采用锁定的小版本修补。审计不是零风险证明。

公告：[Payload unlock](https://github.com/advisories/GHSA-jg8r-5jh2-v2xj)、
[esbuild](https://github.com/advisories/GHSA-67mh-4wv8-2f99)、
[uuid](https://github.com/advisories/GHSA-w5hq-g745-h8pq)。
