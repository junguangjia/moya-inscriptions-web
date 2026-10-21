# ArtVenn

[English](../README.md) · 简体中文

面向中国碑刻与书帖的移动优先数字档案与社区。

ArtVenn（由于艺）将不同来源的文化艺术资料汇入统一、可检索的目录。你可以浏览资料，阅读释文与研究内容，并结合背景说明和引用查看图像。

## 核心功能

- **浏览与搜索**：发现碑刻和书帖，检索已发布资料；查看详情后返回原来的浏览位置。
- **阅读资料**：查看已有的释文、参与者、书体、历史背景、学术研究与引用。
- **查看图像**：滑动切换图片，在全屏查看器中缩放、平移并观察细节。
- **编辑与发布**：通过 Payload
  CMS 管理资料，保留草稿与版本历史，按精确版本批准发布。受控 CSV/XLSX 导入支持先预检、后应用变更。

当前目录覆盖碑刻与书帖。社区功能及部署进展见[项目状态](../docs/project-status.md)。

## 快速开始

### 环境要求

- Node.js **24**，见 [.nvmrc](../.nvmrc)。
- pnpm **11.9.0**，由 [package.json](../package.json) 固定。
- 已在本地启动、支持 Compose 的 Docker。

### 本地运行

在仓库根目录执行以下命令。如果已有 `.env.local`，请保留现有配置并跳过复制命令。

```sh
pnpm install --frozen-lockfile
cp infra/env/local.env.example .env.local
pnpm dev:db:up
pnpm dev:migrate
pnpm dev:all
```

这套环境使用独立的本地 PostgreSQL 数据库、合成开发数据和本地媒体存储，无需云服务凭据。

| 应用          | 本地地址                      |
| ------------- | ----------------------------- |
| Web           | <http://127.0.0.1:3000>       |
| Backend       | <http://127.0.0.1:3001>       |
| Payload Admin | <http://127.0.0.1:3002/admin> |

三个应用统一使用 `127.0.0.1`
主机名。数据库设置、媒体存储、开发账号和设备测试说明见
[本地开发指南](../docs/development.md)。

### 常用命令

| 命令                | 用途                           |
| ------------------- | ------------------------------ |
| `pnpm dev:all`      | 同时运行 Web、Backend 和 Admin |
| `pnpm dev`          | 仅运行 Web                     |
| `pnpm dev:db:down`  | 停止本地数据库，保留数据       |
| `pnpm format:check` | 检查格式                       |
| `pnpm lint`         | 运行 lint 检查                 |
| `pnpm typecheck`    | 检查 TypeScript 类型           |
| `pnpm test`         | 运行默认自动化测试集           |
| `pnpm build`        | 构建工作区                     |

按[贡献指南](../CONTRIBUTING.md)为改动范围选择其他检查。PostgreSQL 集成测试和
[浏览器测试](../tests/e2e/README.md)需要各自的运行环境。

## 仓库结构

仓库使用 pnpm workspaces 与 Turborepo 管理 TypeScript
monorepo。Web 基于 Next.js 和 React；Payload
CMS 管理编辑内容；Backend 通过 PostgreSQL 提供 HTTP API。

| 路径                             | 内容                                       |
| -------------------------------- | ------------------------------------------ |
| `apps/web/`                      | 公开 Web 应用与同源 API 路由               |
| `apps/admin/`                    | Payload CMS、编辑工作流与 CMS 数据库迁移   |
| `apps/apple/`、`apps/harmony/`   | 原生客户端工作区                           |
| `services/`                      | 后端运行时、领域服务、数据库适配与导入工具 |
| `packages/`                      | 共享契约、UI、设计 token、搜索与媒体工具   |
| `database/migrations/`           | 旧 Catalog 内容源迁移                      |
| `database/community-migrations/` | 社区数据库迁移                             |
| `infra/`、`scripts/`             | 环境设置、开发、验证与发布工具             |
| `tests/`                         | 共享单元、集成与浏览器测试                 |
| `docs/`                          | 架构、指南、规格与项目状态                 |

## 文档导航

| 文档                                         | 用途                   |
| -------------------------------------------- | ---------------------- |
| [本地开发](../docs/development.md)           | 启动应用与使用本地数据 |
| [系统架构](../docs/architecture.md)          | 系统边界与数据流       |
| [公共 API](../services/public-api/README.md) | OpenAPI 契约与生成产物 |
| [项目状态](../docs/project-status.md)        | 实现进度与部署记录     |
| [文档索引](../docs/README.md)                | 当前规格与历史记录     |

## 参与贡献

修改前先阅读 [CONTRIBUTING.md](../CONTRIBUTING.md)。从最新 `main`
开始开发，保持改动范围清晰，并在 Pull Request 中提供相关验证结果。

使用代理辅助开发时，从 [AGENTS.md](../AGENTS.md) 和
[共享任务工作流](../docs/development/task-workflow.md)开始。详细的审查、交接与发布规则由这些文档维护。

## 许可

- 代码与普通技术文档采用 [Apache License 2.0](../LICENSE)。
- 仓库内已签入的公开 fixture 内容采用
  [CC BY 4.0](../LICENSE-DATA)，适用范围以该文件为准。
- Yoyi
  / 由艺名称、徽标、字标与服务标识仍为保留品牌资产；单独标注的第三方材料遵循各自条款。

仓库不包含生产数据或私有研究证据。
