# Umami 私有分析工作台部署与验收包

#330 preserves all 18 existing analysis capabilities, 26 expanded dimensions,
filters, exports and event/session/report details. Related capabilities are
composed into five peer sections instead of an 18-page selector. The original
analysis components run as a top-level, same-origin Admin surface with the
shared archive navigation and theme; the complete app is never nested in an
iframe. The existing CMS Owner session authorizes the private gateway. The
configured website is automatically entered in its actual team scope, so
administrators do not choose provider accounts or personal/team workspaces. The
existing view-only service identity reads all website analysis sections;
provisioning administrator credentials are not used by the UI. Payload retains
native IP records and collection-status pages. No statistics engine, account,
data collection, database schema or permission expansion is introduced. This
remains a development/review change, not production deployment or Owner visual
acceptance.

## 固定版本与运行边界

- Umami `v3.4.0`，上游提交 `ec0ff50388c264ed8ce46f00967e92f7e71476ae`。
- 源归档 SHA256
  `dfdc154f23fe52ffd8fbf13c0544ea880e5ef01463f57d06954512b41c50a93a`。默认 standalone 构建使用固定 digest 的 Node
  24 Bookworm Slim/glibc；备用容器目标使用固定 digest 的 Node 22
  Alpine。完整记录在 `infra/production/umami/source.json`。
- 数据库连接池的下游配置保持为 `PrismaPg` 主池及可选副本池各
  `max: 3`。固定 patch 应用前、后都校验整个源文件 SHA256，且禁用 fuzz。官方
  `@prisma/adapter-pg@7.10.0` 构造器接受
  `pg.PoolConfig`。不配置副本 URL；否则总上限成为 6。
- `BASE_PATH=/admin/analytics-workspace` 构建时固定。改变前缀需要重建。
- 默认 standalone 由现有 Node24 与独立 systemd 进程运行，固定监听
  `127.0.0.1:3010`。仅在服务器已有经审核的 Docker
  daemon 时可用备用容器目标，发布
  `127.0.0.1:3010:3000`。不为 Umami 新装 daemon、不借用媒体 worker 私有 daemon。
- 复用现有外部 PostgreSQL 的独立 database/role。不安装 PostgreSQL、Redis 或 ClickHouse。常驻进程只执行
  `node server.js`，不自动迁移或安装依赖；迁移在构建机用独立镜像、独立权限与明确私有配置执行。
- `0.5 CPU`、`768 MiB`、Node heap 512 MiB、128
  tasks 是初始保护限额，不是测得占用或容量保证。以看板峰值、PG连接数及主站接口响应判断调整；池3可能让多图请求排队。备用容器同时禁止额外 swap。

依据：[固定源码](https://github.com/umami-software/umami/tree/ec0ff50388c264ed8ce46f00967e92f7e71476ae)、[上游 Dockerfile](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/Dockerfile)、[PrismaPg 配置](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/src/lib/prisma.ts)、[固定 schema](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/prisma/schema.prisma)。

## 离机构建与默认 standalone 交付

先去掉 `--execute` 审查计划；执行时显式指定任务已授权的
`--docker-context`，防止误用其他 daemon。构建上下文仅含 Dockerfile 与固定 patch/checksum，项目代码、私有
`.env` 不进入镜像。

```sh
/opt/homebrew/bin/mise exec -- node scripts/analytics/build-umami-image.mjs --platform linux/amd64 --target standalone --tag artvenn-umami-standalone:3.4.0-review --docker-context TASK_BUILD_CONTEXT --execute
/opt/homebrew/bin/mise exec -- node scripts/analytics/build-umami-image.mjs --platform linux/amd64 --target migrator --tag artvenn-umami-migrator:3.4.0-review --docker-context TASK_BUILD_CONTEXT --execute
```

Apple Silicon 本机预览可用
`linux/arm64`；生产产物必须匹配服务器架构。保存不可变 image
ID、版本/source/basepath 标签、构建日志与校验结果。不创建 registry、不自动推送或安装 Docker，不修改媒体 worker 私有 daemon。

从 `standalone` 目标导出 `/app`。工具只接受不可变本地 image
ID，核对架构、source/basepath/glibc/Node24/pool3 标签；创建从不启动的临时容器，流式 docker
cp、gzip 和 SHA256，最后只清理本次容器。输出 archive 与 `.json`
源/镜像/架构/哈希元数据均排他创建且
`0600`，失败清理不完整输出。归档来自无私有 context 的 runtime 目录，不包含环境配置、数据库或账号材料。

```sh
/opt/homebrew/bin/mise exec -- node scripts/analytics/export-umami-runtime.mjs --image sha256:REPLACE_ME_REVIEWED_64_HEX_IMAGE_ID --platform linux/amd64 --docker-context TASK_BUILD_CONTEXT --output /absolute/private/umami-runtime.tar.gz
```

核对计划后加 `--execute`。Alpine/musl 的 node_modules 不能直接移到 Ubuntu/Debian
glibc 主机；工具拒绝没有 glibc 标记的镜像。部署负责人核验归档哈希、架构和现有 Node24 路径，审查 tar 成员仅在相对 release 路径内，再解压到新的 root 所有只读
`/srv/yoyi/umami/releases/<artifact-hash>/` 并切换
`current`；保留旧 release 供回滚，不在服务器启动时执行 pnpm/npm install。

默认 `yoyi-umami-standalone.service` 使用专用 `yoyi-umami`
账号、现有 Node24、只读 `/srv/yoyi/umami/current` 与
`StateDirectory=yoyi-umami`。批准安装时为 release 的 `.next/cache` 配置指向
`/var/lib/yoyi-umami/cache`
的符号链接；缓存独立可写，其余 release 保持服务不可写。专用账号和链接由部署负责人在批准安装时创建，模板不表示它们已存在。`PrivateTmp`
提供其余临时位置，Node 路径不同时按现有环境显式设置 PATH。

备用 `yoyi-umami.service` 仅在现有适当 Docker 中使用，此时 `UMAMI_IMAGE`
必须是经核验的 `sha256:...` 本地 image ID，不用可变 tag。Docker 目标构建时显式用
`--target runtime`。

## 独立数据库与初始化

先由部署负责人为 Umami 分配独立数据库。迁移身份拥有该数据库的 DDL 权限；运行身份仅需对应 Umami
schema 的日常读写权限。运行 role 连接上限建议 4（原生服务池 3 + 单连接维护任务），`statement_timeout=5s`；初始化迁移身份不套用这项 5 秒限制。这里不执行角色创建、授权或连接测试。

不要将 CMS/community 的角色、数据库或 URL 填入 Umami。私有运行环境从
`infra/production/env/umami.env.example` 生成，放
`/etc/yoyi/umami.env`、root 所有且 `0600`。`APP_SECRET`
使用独立随机值；数据库 URL 中的 TLS 必须按实际 CA 与主机名验证，不使用跳过验证。所有密码、URL、token 均不得打印、进入前端或 Git。

审核迁移计划后，在有受控网络访问的构建机通过专用 migrator 镜像执行
`prisma migrate deploy`，显式提供此次迁移身份的私有 env 文件。不要为迁移在生产服务器安装 daemon，不输出完整环境。启动前核对没有待执行迁移。默认模板为
`yoyi-umami-standalone.service`，备用容器模板为
`yoyi-umami.service`；部署负责人核对现有 Node 路径、账号、release/cache 链接与服务路径。本工具不自动安装、启用或启动 unit。

原生初始迁移创建默认管理员。仅在 loopback 的任务环境或批准初始化窗口使用公开默认身份，并立即更换随机密码，然后创建只读工作台身份：

1. 私有 `0600` bootstrap 配置中指定
   `ANALYTICS_TASK_ENV=synthetic|pilot|production`、`UMAMI_ORIGIN`、`UMAMI_BOOTSTRAP_USERNAME/PASSWORD`（当前密码）与
   `UMAMI_BOOTSTRAP_NEW_PASSWORD`（本机 CSPRNG 生成，至少 24 字符）。不在 shell 命令参数中放密码。
2. 运行密码轮换工具。它先试新密码以支持重跑；尚未轮换时用当前密码登录，通过原生
   `POST /api/me/password` 修改，再用新密码验证。只输出状态和账号 ID。
3. 同一配置运行 bootstrap。存在 `UMAMI_BOOTSTRAP_NEW_PASSWORD`
   时 bootstrap 使用新密码。成功后私下删除旧密码，将新密码保存为当前
   `UMAMI_BOOTSTRAP_PASSWORD` 并移除
   `NEW_PASSWORD`。初始化特权配置和账号只供控制程序使用，不给 Web/Admin 常驻进程。

```sh
/opt/homebrew/bin/mise exec -- node scripts/analytics/rotate-umami-password.mjs --config /absolute/private/bootstrap.env --environment synthetic --execute
/opt/homebrew/bin/mise exec -- node scripts/analytics/bootstrap-umami.mjs --config /absolute/private/bootstrap.env --environment synthetic --execute
```

Bootstrap 另需显式
`UMAMI_WEBSITE_ID`（UUID）、`UMAMI_WEBSITE_DOMAIN`、`UMAMI_VIEWER_USERNAME/PASSWORD`（独立随机密码至少 16 字符）；可选网站名/团队名。脚本不读取项目
`.env`、不继承进程数据库 URL，默认只打印 `PLAN_ONLY`，必须指定
`--execute`。已有网站、账号角色或报告定义与预期不一致时失败，不擅自覆盖。

Bootstrap 用 v3.4.0 原生 API 创建/复用：

- 独立网站且不创建公开分享；专用团队；`view-only` 用户和 `team-view-only`
  团队成员。
- 60 分钟窗口的 `content_impression → content_open → favorite` 保存漏斗。
- 含访客汇总、优先显示的省份/城市排行、访问趋势、事件趋势和保存漏斗的原生 Board；不创建 WorldMap 组件或主国家排行。
- 用只读身份验证网站、Board 与原生 retention
  GET 接口。留存页是原生独立视图，没有杜撰不存在的 retention Board 组件。

将返回的 `boardId` 写入 Admin 私有配置的 `UMAMI_BOARD_ID`，与 website
ID 一样验证 UUID；缺少时显示未配置，不退回带地图的网站概览。r3 使用新名称
`ArtVenn: 内容行为与省市`
创建/复用 Board，保留旧版 Board，不覆盖用户已经修改的报告。

省份、城市表统计原生
`count(distinct session_id)`，标注“去重访客”；这是 Umami 访客标识的估算去重，不是精确人数或浏览量。原生汇总的 Visitors 使用此口径，Visits 则统计
`count(distinct visit_id)`；同一访客多次访问可使 Visits 大于省市表访客数。点击省份后，全局 region 筛选会作用到城市排行。同名城市在全局视图按城市名与国家聚合，需要先筛选省份再解释。原生查询不把缺失省市计入相应排行，排行占比也不能解释为全体访问占比。工作台保留实际未知值，不用国家、注册地址或省会猜补。省市名称通过同一离线定位库的
`zh-CN`
名称表显示；缺少可靠中文名称时显示“暂无中文名称”，不猜测音译。筛选与存储仍使用原始键。台湾原始
`TW` / `TW-*` 不改写，PostgreSQL 分析查询统一派生为 `CN` /
`CN-TW`，省份显示“台湾省”；城市仍保留原始国家键用于准确翻译。所有省份/国家过滤运算、普通及展开排行和筛选候选值共享该派生规则。

结果仅含版本、ID、状态，不输出响应全文、用户名、密码、Bearer token 或 collection
cache。漏斗是同一访客会话中的事件顺序；默认没有强制相同
`target_id`，不能解释为同一篇内容的因果转化。

中文原生工作台固定 `zh-CN`，同步加载词典，不受旧浏览器语言或 URL
locale 覆盖；日期、图例、漏斗、筛选标签与事件名称均使用中文显示。原始事件名和筛选键不变，保留协议/品牌/用户内容原值。中文省市和事件搜索反查原始键，候选最多 5 个，与原生选择器上限一致。省份指标查询在现有语句里增加固定 CASE 表达式。筛选候选值用当前窗口内活动事件的 EXISTS 判断活跃访客，避免只按首次出现时间漏掉回访者；仍是按需一次查询、最多 10 条候选，无额外数据库往返。站点/日期索引仍适用，但地域尾列未保证可直接下推索引，需上线后测量，不能据此承诺零开销。

## Complete analysis gateway and shared Admin shell

The original analysis components remain responsible for queries and rendering.
Presentation changes include the unified shell, automatic fixed team/site entry,
shared canonical theme/navigation/icons, compact related content and the
requested China province map. Personal/team and service-account selectors are
not shown. Report configuration writes, account/site management, collection and
sharing retain their existing restrictions. No-data capabilities remain honest
empty states; this UI change does not enable replay, heatmap, revenue or
performance collection.

Original global Dashboard, Boards, Websites, Links and Pixels entry points and
their readable details remain reachable as secondary data resources.
Website/Board/Link/Pixel choices are business data scopes, not login identities.
Their existing service-role/team permissions and honest empty states remain.
Only the old team Link/Pixel page aliases and corresponding list GET routing
gaps are closed; no account, Share, collection or configuration-write surface is
opened.

The main entry is `/admin/analytics`; the configured Board remains
`/admin/analytics/board`; IP and collector status remain `/admin/analytics/ips`
and `/admin/analytics/status`. The main entry uses a document navigation to the
protected analysis surface so two application routers are not nested. Only the
existing Owner role reaches the upstream. Service credentials and bearer
material stay on the server.

### Compact analysis composition

| Peer section | Existing capabilities                             |
| ------------ | ------------------------------------------------- |
| 访问概况     | Overview, comparison, performance and breakdown   |
| 访客动态     | Sessions, realtime, replays, segments and cohorts |
| 内容互动     | Events, event properties and heatmaps             |
| 目标与回访   | Goals, funnels, journeys and retention            |
| 来源与收益   | UTM, revenue and attribution                      |

Related small summaries and lists share a section. Heavy graphs, recordings and
property tools open in place and mount only when needed. A shared control bar
and detail surfaces avoid duplicated forms and modals. Existing URLs still open
the correct section and capability; valid date, filter, detail and local list
state retain their original scope. Component-local presentation state does not
alter statistics, permissions or persisted data.

Realtime retains its independent live window and retention retains its monthly
controls; neither is silently interpreted as the page's ordinary historical date
range. Event-property filters keep their event scope. Comparison dimensions and
the expanded metrics view do not overwrite each other's state.

In the grouped view, retention stores its selected calendar month separately in
`retentionMonth`. Its first month comes from the existing date range for legacy
links; subsequent month changes leave the historical `date` and `offset`
unchanged. Editing the shared historical range does not overwrite an already
selected retention month. Browser history restores both selections.

Ordinary cards and empty states size to their content. Data, controls and
section headings use the canonical interface font; the brand and main title
retain the editorial font. Hour labels use unambiguous 24-hour notation and
avoid wrapping. The map and related geography lists share a padded section
without cropping the boundary geometry. Geography uses one search and an
in-place expansion rather than repeated 100-row page changes. Expanded rows and
CSV retain the original maximum of 500 matching items; a narrower date range or
filter can reduce that scope. Large record histories retain their existing
count-aware pagination. When a shared record filter or date range changes,
composed lists return to the first page while retaining their searches and the
exact filter values. Merely opening a tool or changing a chart dimension does
not reset a list. Browser history keeps the previous criteria and page state.

Admin 运行配置只持有 `UMAMI_ORIGIN`、`UMAMI_WEBSITE_ID`、`UMAMI_BOARD_ID`、专用
`UMAMI_VIEWER_USERNAME/PASSWORD`。所有工作台 HTML、RSC、静态资源和 API 都经过现有 Owner 权限检查。代理丢弃客户端 Umami
Authorization，服务端登录并替换为短期缓存的专用只读 token；不得返回登录接口或将 token 写进浏览器 localStorage。Owner 权限检查只读取 Payload 会话 Cookie，先移除原生客户端自己的 Authorization，避免它遮蔽后台会话。`/api/me`、团队和网站读取仅投影必要字段，不透传认证上下文、团队邀请 accessCode 或网站 shareId。设备退出接口按已验证的
`CMS_PUBLIC_URL` 公网 origin 检查来源，避免 Next 内部 HTTP origin 导致误拒绝。

Nginx 的工作台专用 location 将原生 RSC/Next-Router 头与 `_rsc` 查询值封装到固定
`X-Moya-Umami-*`
头，清除原头后进入 Payload；Owner 代理再还原给 Umami。这避免外层 Next 消耗内层 Next 的路由状态并造成预加载重定向循环。此 location 与代理代码必须一起部署；本机原生验收须经等价的前置桥接，不能仅直连 Payload。没有关闭任一 Next 服务的 RSC 校验或缓存安全设置。

Umami v3.4.0 的登录是 Bearer token + localStorage；原生 UI 冷启动会
`POST /api/auth/verify`，可由代理固定 `{}`
body 并注入只读 token。现代网站图表/漏斗/retention 使用 GET，兼容旧版的 POST
reports 接口无需开放。允许 GET/HEAD 与固定 auth
verify 之外的写接口均拒绝。公网同时拒绝 send/batch/script/replay/heatmap、share、login、账号管理及配置写接口。采集仅由 Backend
worker 直连 loopback 固定 `/admin/analytics-workspace/api/batch`。

If the existing service account requires unfinished two-factor setup, the
private archive shell shows its service-unavailable state instead of an
unfinishable setup dialog. Account setup remains outside this read-only gateway;
the original upstream setup flow and the gateway's write restrictions are
unchanged.

The primary complete interface is top-level and uses one shared Admin shell.
Existing browser security headers remain; no iframe is required. The provider
account chrome is not mounted. Owner entry, anonymous refusals, path encoding,
full section/detail navigation and unavailable states require browser
validation.

依据：[原生 auth login](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/src/app/api/auth/login/route.ts)、[原生 Board API](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/src/app/api/boards/route.ts)、[原生漏斗 API](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/src/app/api/websites/%5BwebsiteId%5D/funnels/route.ts)。

## 合成数据与真实界面验收

`seed-synthetic-umami.mjs` 只接受 `ANALYTICS_TASK_ENV=synthetic`、loopback
origin 和 `localhost`/`.invalid` 网站域名。额外提供合成 `UMAMI_SYNTHETIC_RUN_ID`
UUID。工具验证只读身份和网站后，向专用任务数据库对应的内网 collector 发送两日 20 条合成事件：8 页面访问、6 曝光、4 打开、2 收藏。GeoIP 用四个公开 DNS
resolver 地址作为合成地址 fixture；并非真实访客或真实用户位置，地域标签取决于打包 GeoIP 库，不预设精确城市。

```sh
/opt/homebrew/bin/mise exec -- node scripts/analytics/seed-synthetic-umami.mjs --config /absolute/private/bootstrap.env --environment synthetic --execute
/opt/homebrew/bin/mise exec -- node --test scripts/analytics/*.test.mjs
```

原生 collect
API 不是幂等事件 upsert；seed 每个全新 disposable 数据库只执行一次，不自动重试。它只报告接收数量和 stats 接口可读性，不能替代浏览器验收。

## 城市级离线定位与精度边界

现有固定 Umami 的 `getLocation` 支持本地 MaxMind-compatible City MMDB，读取
`country.iso_code`、`subdivisions[0].iso_code`、`city.names.en`。本项目 Worker 明确传可信
`payload.ip`，使用本地查库，不按每次访问调用外部定位 API；支持 IPv4/IPv6，不新增常驻服务或数据库查询。数据本身可能缺失或不准确，移动网络/VPN 通常表示运营商/代理出口，不能保证是用户实际所在城市，也不产生 GPS 定位。

本次实际 linux/amd64 交付包里的 `GeoLite2-City.mmdb` 为 50,901,339
bytes，数据构建时间 `2026-10-16T18:58:36Z`，SHA256
`fd112e5b13ca19e8bb0bf2e1902fb0694f6ba1940bef916e0d8d9d9346f4e029`。只读离线 fixture 核验得到
`223.5.5.5 → CN-ZJ / Hangzhou`、
`1.12.12.12 → CN-GD / Guangzhou`、`140.112.2.2 → TW-TPE / Taipei`、`2400:3200::1 → CN-ZJ / Hangzhou`；
`114.114.114.114` 与 `180.76.76.76`
仅有国家，没有省市。这些都是公开 DNS 地址的合成测试，绝不是实际访客或其物理位置的证明。

r4 构建显式固定公开 GeoIP 归档提交 `e26a98449d33ab0639d555b736898d4f55623c82`
与归档 SHA256
`46df66d141c04e4920e00b5e4bbfc4445178adc11de9a8b2900bcea79c100c0e`，同时核对上述 MMDB 哈希，并跳过上游随时间变化的下载。中文名称表从这一份公共数据库离线生成，保留来源与冲突统计。无每访问外部 API、额外数据库查找或常驻服务。定位数据包含 MaxMind
GeoLite 数据（https://www.maxmind.com）及
GeoNames 地理数据（https://www.geonames.org）。保留随库的版权/许可文件，派生中文名称在构建时生成，不写入
Git 历史。更新维护须遵循
[GeoLite EULA](https://www.maxmind.com/en/geolite/eula)，包括新版发布后的旧版使用/删除期限；数据更新需要同步审核库哈希、中文表和 fixture，按受控发布替换后重启验证，不静默热换。

依据：[固定定位源码](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/src/lib/detect.ts)、
[固定构建脚本](https://github.com/umami-software/umami/blob/ec0ff50388c264ed8ce46f00967e92f7e71476ae/scripts/build-geo.js)、
[MaxMind 定位精度说明](https://support.maxmind.com/knowledge-base/articles/maxmind-geolocation-accuracy)。

验收须记录：任务数据库/网站归属、固定 image
ID、初始化结果 ID、原生 overview/Board/漏斗/retention/地域页面截图、只读导航及匿名/非 Owner/伪造 Bearer 等负例。用真实浏览器打开 Payload 的受保护工作台；确认指标为合成活动且无重复前端 tracker。测量原生进程空闲/看板加载峰值、PG 连接数、主站接口响应和容器 OOM/限额情况。未实际运行的检查标为未验收。

## 两套事件语义与保留期

`community.analytics_events`
是未来推荐和产品分析的 canonical 数据源；Umami 是异步投递后的原生可视化投影。Owner 的精确社区账号 ID 与当前会话、开发/自动化/测试流量在持久化和投递前排除；不能凭 Payload 角色、handle 或共享 IP 认定真实社区 Owner。页面请求数、PV、访客、会话、曝光和收藏不是同一指标。

Canonical 以 `event_id` 去重。Umami v3.4.0 的 `/batch` 逐条处理，payload `id`
是访客 distinct ID，不是可幂等的 event
ID；网络超时或已接收但确认丢失后重试，可能使原生计数重复。原生看板采用至少一次投递口径，不能承诺 exactly-once 或强行与 canonical 条数相等；推荐导出与需要严格去重的产品统计以 canonical 为准。

Umami 的路径由 surface/目标 ID 生成，是逻辑分析路径；不保存原始导航查询串、媒体能力链接、referrer 或 UTM。当前未提供访问来源归因与实际排序版本采集，不把原生界面中的所有高级菜单等同于已接入数据。

Canonical 默认 180 天（Backend 允许配置 7–730 天）；单独
`analytics_ip_observations`
原始 IP/UA 固定 7 天。Backend 的删除任务不自动清理 Umami 独立数据库。Umami
`session` 保存近似地域和 distinct ID；没有原始 IP 列，但仍需要生命周期维护。

`prune-umami.mjs`
只对明确网站/域名、明确独立 DB 执行固定 180 天活动清理，不调用 reset
API、不删除 website/Board/report/user/team。默认输出离线 `PLAN_ONLY`；启用
`--execute`
才连接数据库。每表最多 20 批（可限定 1–50），每批 1000 行；事件批次的 1000 是父事件上限，关联 event_data/revenue 行数可能更多。全部语句单连接、statement
timeout 5 秒、lock timeout 250
ms、查询预算120秒；末条客户端 timeout 钳至剩余预算，失败/到期销毁连接以回滚未完成事务，返回前完成文件/连接收尾。跳过被锁行，后续周期补扫。

工具校验最新成功迁移为
`26_add_api_key`，并拒绝活动表上的未知数据库外键。固定上游使用
`relationMode=prisma`，活动表没有数据库级 FK
cascade，所以先删除过期衍生表，再连同过期 website_event 的 event_data/revenue 删除，最后仅删除没有保留活动引用的旧 session。不会假设 DELETE 自动级联。`session_data`/`session_link`
的原生索引没有 `(website_id,created_at)`
组合；在较大站点应关注超时/积压，另行审核索引迁移，不能静默取消超时。

维护配置独立 `0600`，由执行账号 `yoyi-backend`
所有：`ANALYTICS_TASK_ENV`、`UMAMI_MAINTENANCE_DATABASE_URL/NAME`、`UMAMI_WEBSITE_ID/DOMAIN`，可选 TLS
CA 文件与 `UMAMI_MAINTENANCE_MAX_BATCHES`。不隐式采用服务的 `DATABASE_URL`。

```sh
/opt/homebrew/bin/mise exec -- node scripts/analytics/prune-umami.mjs --config /absolute/private/umami-maintenance.env --environment synthetic
```

模板 `yoyi-umami-prune.service/.timer` 每天 UTC
04:20 后随机 20 分钟执行，资源初始限额 CPU 20%、192
MiB。只有批准后才安装/启用；模板存在不表示生产保留任务已运行。`BATCH_LIMIT_REACHED`
或 `skippedLocksPossible`
表示不能声称已清完全部过期数据；超时/未知 schema 失败须调查。Autovacuum 是否及时、数据库容量和备份生命周期需部署负责人核对，不在线执行全表 VACUUM
FULL。

## Canonical 私有流式导出

`export-canonical.mjs` 使用现有 `catalog-postgres`
构建产物，不增加依赖。配置显式
`ANALYTICS_TASK_ENV`、`ANALYTICS_EXPORT_DATABASE_URL`、`ANALYTICS_EXPORT_DATABASE_NAME`，可选 CA 文件。只读角色应仅获
`community.analytics_events` 允许列的 SELECT 权限，不获 raw
IP/UA、outbox 或账号表权限。

导出按 `received_at`
的半开 UTC 区间过滤，范围最多 31 天；固定 200 条 keyset 页、单连接/只读可重复读快照、单条 5 秒及总计 120 秒预算；默认最多十万条、显式上限最高一百万。游标保留 PostgreSQL 微秒，不转换为 JS 毫秒时间。现有 migration 的
`(received_at,event_id)` 索引支持此顺序。

输出仅含 event/visitor/session/user ID、事件、目标、surface、frozen
event_data、发生/接收时间；不含实现用 distinct_id、原始 IP/UA 或 outbox。文件必须为绝对
`.jsonl` 路径，排他创建且
`0600`，拒绝覆盖；失败删除本次不完整输出。stdout 仅数量/状态。用户 ID 与推荐行为数据仍是私有分析材料，不因排除 IP 就成为可公开数据。

```sh
/opt/homebrew/bin/mise exec -- node scripts/analytics/export-canonical.mjs --config /absolute/private/export.env --environment synthetic --start 2026-10-01T00:00:00Z --end 2026-10-02T00:00:00Z --output /absolute/private/canonical.jsonl
```

默认只审查计划。完成任务专用数据库读权限和输出位置审核后才加
`--execute`；不能隐式读取生产或把完整行输出到终端。

## 本项目的采集边界与流量排除

Web 仅在正式环境且前后端开关都启用时采集；localhost、自动化浏览器、开发测试、登录/编辑工具不采集。批量最多 20 个事件、UTF-8 编码后 32,768 字节，默认 30 秒发送一次，队列最多 100 条，失败有限重试；离开页面时允许一次有界 beacon。卡片曝光要求可见面积至少 50% 且连续 1 秒；停留只累计前台可见时间。不会逐秒上报或请求外部 IP 定位服务。

Owner 与测试身份由 Backend 根据已验证会话的稳定账号 ID 排除，不接受浏览器声明账号或 IP。本机已登记的 19 个自用/测试账号已另存私有配置（2 个本人账号、17 个测试账号），部署时应用，不能提交本仓库。Owner 打开后台会自动写设备退出标记，使该浏览器后续未登录访问也排除。未知的新设备尚未建立退出标记时，不能仅靠共享出口 IP 识别本人。

推荐原始数据记录曝光、打开、前台停留、搜索、搜索点击及成功交互的客户端事件，并保留目标 ID、surface、位置、序列/request
ID 和事件 ID。它们是客户端行为证据；点赞等事件来自成功响应回调，不能替代业务数据库的最终状态。`rankingVersion`
字段已预留，但当前 feed DTO 没有版本来源，不能宣称已经记录实际算法版本。

历史 41,324 次 HTTP 请求的旧日志缺少路径、IP 和 User-Agent，无法追溯为哪台设备或全部归于 Owner/AI。新增结构化 Nginx 日志只记录路由类别、客户端类别、状态、耗时、响应字节、退出标记和来源 IP，不记录查询串、完整 UA 或 Cookie；客户端类别是启发式线索。`summarize-traffic.mjs`
流式汇总这些类别，也能读取旧日志并明确标记无法归因。产品事件与请求数分别统计，不把接口轮询当访问量。日志轮转模板保留约 7 天，需在批准部署时启用。
