# `@moya/contracts`

跨模块公共类型和 runtime
schema 的唯一来源。本包只定义由艺（Yoyi）当前已批准的 Public DTO、transport
query、分页和安全错误，不保存或导入真实数据。

`CatalogId`、`MediaId`、两值
`CatalogKind`（`inscription | calligraphy`）、`PublicMedia`、`CatalogSummary`、
`CatalogDetail`、`CatalogPage`、`CatalogListTransportQuery`、
`CatalogContributorRole`、`CatalogContributor`、`CatalogCitationScope`和
`PublicSourceCitation`是canonical Public Contract。T04.2已删除T04.0-R的Archive
compatibility exports；新代码只使用Catalog语言。

- 根入口和 `@moya/contracts/types` 只导出 TypeScript 类型。
- `@moya/contracts/schemas` 提供固定版本的 Zod runtime schema。
- `@moya/contracts/json-schema` 提供 Draft 2020-12 JSON Schema。
  `catalogContributorRoleJsonSchema`、`catalogContributorJsonSchema`和
  `catalogCitationScopeJsonSchema`从对应Zod
  schema派生；OpenAPI继续消费派生契约，不维护第二套手写模型。
- `@moya/contracts/internal/catalog-import` 提供versioned、server-only的Catalog
  Import canonical rows、workbook/CSV specification、dry-run与batch
  contract；它不是Public DTO入口，Frontend与Public API不得导入。
- Catalog DTO不暴露内部生命周期、原始来源、审核、持久化或storage字段。
  `PublicMedia.src`只承载由后端解析的public/signed runtime URL；object
  key、bucket、provider internals和resolver配置永不进入Frontend contract。
- `CatalogListTransportQuery` 是本包唯一的Catalog list transport
  query，只表达并验证optional `kind`、`page`和`pageSize` query-string输入。
  `noQueryTransportSchema`为不声明query参数的endpoint执行strict
  validation。Normalized number形式的 `CatalogListQuery` 属于 `@moya/api`
  application layer，不从本包导出。
- transport到application的解析与规范化位于backend transport
  boundary，不在contracts或application layer内执行。
- 当前只保留基础list/detail和image
  Media读取需要的Catalog契约；搜索、分类、Site、Feed和内部生命周期由后续负责任务引入。

后续模块不得在功能目录本地重定义共享类型，也不得把数据集、审核候选或来源记录放入本包。T05.4-A只冻结Import
Contract与安全空白template；本包不读取XLSX/CSV、不访问数据库、不执行diff/apply，也不授权任何runtime
workspace读取raw production dataset。

## Catalog Content V1

[ADR 0009](../../docs/adr/0009-catalog-content-v1-contract.md)冻结Detail内容语义，不实现后端数据填充或前端展示。`CatalogSummary`保持不变；以下字段只在
`CatalogDetail`中新增，全部optional，缺失不生成占位值，`null`不是缺失值：

| 字段                | 公开语义                         | 存在时的边界                                                                                |
| ------------------- | -------------------------------- | ------------------------------------------------------------------------------------------- |
| `contributors`      | 有序的撰文者与书者               | 1–50项；`name`为1–500字符；`role`仅`textAuthor`或`calligrapher`；同一`(name, role)`不得重复 |
| `scriptStyle`       | 书体或简短的多部位混合书体描述   | 1–2,000字符的plain text；不是enum或taxonomy                                                 |
| `transcription`     | Owner批准公开的释文              | 1–100,000字符的plain text；保留有意义的内部换行                                             |
| `historicalContext` | 历史背景                         | 1–20,000字符的plain text；允许内部换行                                                      |
| `scholarlyResearch` | 学术研究史、解释、争论与研究价值 | 1–20,000字符的plain text；允许内部换行                                                      |

所有新增text沿用trimmed exact-text
policy：空字符串或首尾空白被拒绝，parser不自动修剪、填值或生成HTML、Markdown、rich
text。Contributor对象只允许`name`和
`role`；同一人可分别以两个role出现，数组保留curated display order。

`PublicSourceCitation.appliesTo?: CatalogCitationScope[]`存在时为1–5个不重复的scope：`record`、`description`、`transcription`、`historicalContext`、
`scholarlyResearch`。`record`涵盖整体Catalog及基本事实，其余scope分别支持对应内容段落。省略`appliesTo`的语义为`["record"]`，但parser不注入该属性。Contract允许partial
record，不执行内容与citation之间的publication
completeness校验；内部来源身份与metadata仍不可公开。

既有字段不重命名、不合并、不改变限制：`summary`是标题下只展示一次的短lead，
`periodLabel`是与kind一起展示的标题年代；`dynasty`/`dateText`保留为结构化事实，后续T09-F1不在基本资料重复该年代。`province`/`prefecture`/`county`仍是独立Contract字段，后续展示合成一行“地区”；`currentLocation`为“现址”，
`currentCustodian`为“现藏单位”，`description`为“简介”。这些是后续展示约束，不改变当前Web实现或现有API响应。

## Media delivery (unified-media-pipeline-v1)

`src/media-delivery.ts` depends only on Zod and defines resolved URL forms,
finite rendition lists and placeholder colours. `@moya/contracts/schemas`
re-exports its runtime schemas; the root exports the `MediaRendition` type. The
additive fields are optional. Web parses strict schemas, so Web and Backend ship
together in one release.

| Field              | Location                                        | Public meaning                                                                           |
| ------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `renditions`       | `PublicMedia`, `WorkMedia`, `ContentCard.media` | One framing, 1–8 finite candidates with the parent `src` as an anchor                    |
| `coverRenditions`  | `UserWork`                                      | Card candidates of the cover framing, including any cover crop; `coverSrc` is the anchor |
| `placeholderColor` | `PublicMedia`, `WorkMedia`, `ContentCard.media` | Lowercase `#rrggbb`, omitted for transparency                                            |

Candidates expose only `src`, actual `width` and `height` (at most 65,535), and
`contentType` (`image/webp` or `image/jpeg`). Lists ascend strictly by size,
contain no duplicate size, and share one framing within pixel rounding. A list
uses one delivery form; relay paths name one item and edit key. The parent
source is a listed candidate. Card contexts stop at that anchor; larger
candidates are Viewer levels. Cover crops and complete images have separate
lists.

Catalog and editorial URLs use `resolvedMediaUrlSchema`, preserving existing
short-lived authorized URLs. `publishedMediaUrlSchema` requires absolute HTTPS
with a path and no userinfo, query, fragment or backslash. Authorized still
relay paths use `mediaRenditionPathSchema`. Work media, motion, cover sources
and work-card anchors use authorized paths or unsigned published URLs even when
no candidate list is present. Live Photo still and motion switch delivery forms
together. Phase 4 PNG entries retain their user-media path and have no motion or
candidates.

`mediaVariantSchema` includes `viewer` for the authorized relay. Owner/MCP
shapes (`publishingMediaSrcSchema`, `PublishingMediaItem`,
`PublishingMediaSources`) and `AuthorMedia` remain unchanged; operator queues
retain their five review variants without `viewer`.

URLs arrive resolved by the Backend. Clients do not compose or sign them.
Delivery schemas carry no `.describe()` or `.meta()` text.
