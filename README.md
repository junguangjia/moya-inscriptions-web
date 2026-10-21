# ArtVenn

English · [简体中文](docs/README.zh-CN.md)

A mobile-first digital archive and community for Chinese inscriptions and
calligraphy.

ArtVenn (由于艺) brings cultural materials from different sources into one
searchable catalog. Explore records, read their texts and research, and examine
the images alongside their context and citations.

## Features

- **Browse and search** — discover inscriptions and calligraphy, search
  published records, and return to your place after opening a detail page.
- **Read in context** — view transcriptions, contributors, script styles,
  historical notes, scholarly research, and citations where available.
- **Examine images** — swipe through image sets and use the full-screen viewer
  to zoom, pan, and inspect details.
- **Edit and publish** — manage catalog records in Payload CMS with drafts,
  version history, and approval of exact revisions. Controlled CSV/XLSX imports
  support dry runs before changes are applied.

The catalog currently covers inscriptions and calligraphy. Community features
and deployment milestones are tracked in
[Project status](docs/project-status.md).

## Quick start

### Requirements

- Node.js **24** — see [.nvmrc](.nvmrc).
- pnpm **11.9.0** — pinned in [package.json](package.json).
- Docker with Compose support, running locally.

### Run locally

From the repository root, run the commands below. If `.env.local` already
exists, keep your configuration and skip the copy command.

```sh
pnpm install --frozen-lockfile
cp infra/env/local.env.example .env.local
pnpm dev:db:up
pnpm dev:migrate
pnpm dev:all
```

This setup uses a dedicated local PostgreSQL database, synthetic development
data, and local media storage. No cloud credentials are required.

| Application   | Local address                 |
| ------------- | ----------------------------- |
| Web           | <http://127.0.0.1:3000>       |
| Backend       | <http://127.0.0.1:3001>       |
| Payload Admin | <http://127.0.0.1:3002/admin> |

Use the same `127.0.0.1` hostname across the three applications. See the
[development guide](docs/development.md) for database setup, media storage,
development accounts, and device testing.

### Common commands

| Command             | Purpose                                   |
| ------------------- | ----------------------------------------- |
| `pnpm dev:all`      | Run Web, Backend, and Admin together      |
| `pnpm dev`          | Run Web only                              |
| `pnpm dev:db:down`  | Stop the local database, keeping its data |
| `pnpm format:check` | Check formatting                          |
| `pnpm lint`         | Run lint checks                           |
| `pnpm typecheck`    | Check TypeScript types                    |
| `pnpm test`         | Run the default automated test suites     |
| `pnpm build`        | Build the workspace                       |

Choose additional checks for the affected scope using the
[contributor guide](CONTRIBUTING.md). PostgreSQL integration tests and
[browser tests](tests/e2e/README.md) have separate setup requirements.

## Repository structure

This is a TypeScript monorepo managed with pnpm workspaces and Turborepo. The
Web application uses Next.js and React; Payload CMS handles editorial content,
and the Backend serves the HTTP API over PostgreSQL.

| Path                             | Contents                                                         |
| -------------------------------- | ---------------------------------------------------------------- |
| `apps/web/`                      | Public Web application and same-origin API routes                |
| `apps/admin/`                    | Payload CMS, editorial workflows, and CMS migrations             |
| `apps/apple/`, `apps/harmony/`   | Native client workspaces                                         |
| `services/`                      | Backend runtime, domain services, database adapters, and imports |
| `packages/`                      | Shared contracts, UI, design tokens, search, and media utilities |
| `database/migrations/`           | Legacy Catalog content-source migrations                         |
| `database/community-migrations/` | Community database migrations                                    |
| `infra/`, `scripts/`             | Environment setup, development, validation, and release tools    |
| `tests/`                         | Shared unit, integration, and browser tests                      |
| `docs/`                          | Architecture, guides, specifications, and project status         |

## Documentation

| Guide                                       | Start here for…                               |
| ------------------------------------------- | --------------------------------------------- |
| [Local development](docs/development.md)    | Running the stack and working with local data |
| [Architecture](docs/architecture.md)        | System boundaries and data flow               |
| [Public API](services/public-api/README.md) | OpenAPI contracts and generated artifacts     |
| [Project status](docs/project-status.md)    | Implementation progress and deployment notes  |
| [Documentation index](docs/README.md)       | Current specifications and historical records |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes. Start from the
latest `main`, keep changes scoped, and submit a pull request with the relevant
validation results.

For agent-assisted development, start with [AGENTS.md](AGENTS.md) and the
[shared task workflow](docs/development/task-workflow.md). Detailed review,
handoff, and release rules live there.

## License

- Code and ordinary technical documentation: [Apache License 2.0](LICENSE).
- Checked-in public fixture content: [CC BY 4.0](LICENSE-DATA), within the scope
  described in that file.
- Yoyi / 由艺 names, logos, wordmarks, and service identities remain reserved
  brand assets. Third-party material retains its separately identified terms.

Production data and private research evidence are not included in this
repository.
