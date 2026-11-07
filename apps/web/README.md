# 由艺（Yoyi）Public Web

Public Web 是 Next.js App Router 应用。当前 Formal `/` 由
`apps/web/app/page.tsx` request-render，并使用已合并的 React Product Shell。

## Formal Root composition

```text
app/page.tsx
  ├── readFormalRequestContext()
  └── loadProductionProductStates()
        ├── Home Discover
        ├── Timeline loading（feed 首次激活时由 client 读取）
        ├── truthful unavailable Topics
        ├── kind=inscription page 1
        └── kind=calligraphy page 1
      ↓
  T02pProductPreview
      ↓
  ProductShell
```

`loadProductionProductStates()` 只通过 `lib/public-api/` 的 server-side HTTP
boundary 获取 validated Public Catalog states。React Product
Shell 负责当前 Home、Browse、Settings、Detail、Carousel、Viewer、history、focus 与 scroll
restoration。

Formal root 不执行旧的静态 T02 document composition。E2E 明确要求 `/`
返回 request-rendered React Product Shell，并拒绝旧 `data-formal-root` /
`data-mobile-app` DOM。

## Browser-facing API boundaries

- `GET /api/catalog`：same-origin Catalog list boundary；
- `GET /api/catalog/[catalogId]`：same-origin Catalog detail boundary；
- `GET /catalog/[catalogId]`：保留 307 redirect 到 Formal root 的 canonical
  Detail query/history journey。

Web business reads 必须位于
`lib/public-api/`。Frontend 不得导入 backend、PostgreSQL、Importer、storage
internals 或 raw datasets。

## Content and media

Current Detail consumes the strict `CatalogDetail` Public Contract. Backend
controls canonical meaning and optionality. Frontend must omit absent Production
content rather than invent values.

Media only consumes Public API-resolved `PublicMedia.src`. Frontend does not
receive object keys and must not derive provider/CDN URLs.

Catalog Content V1 Contract, PostgreSQL/API read support, and
`catalog-import/v2` are implemented. Frontend presentation of contributors,
script style, transcription, historical context, scholarly research, and scoped
citations is implemented as the bounded `T09-F1` task (PR #89).

## Development, QA, and Prototype

- `/dev/t02p`：Development Product acceptance surface；
- `/dev/t02p/qa`：Development QA harness；
- `/docs/prototypes/mobile-preview/`：direct non-production static Prototype；
- Production：前两条返回 404，Formal `/` 只使用 truthful runtime states。

The static Prototype, its fixtures, P5 snapshot, demo media, and the legacy
`lib/t02-static-files.ts` composition test seam are not current Formal runtime
authority. They remain isolated reference and regression evidence.

## Local commands

From the repository root:

```bash
pnpm dev
pnpm dev:web
```

Both start only Public Web on port `3000`. Use `pnpm dev:all` for Web plus the
minimal Admin. Backend/API must be started explicitly on port `3001`.

## Required checks

Apply checks proportionate to the change:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```
