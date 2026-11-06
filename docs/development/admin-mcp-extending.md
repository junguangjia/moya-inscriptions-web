# Extending Admin MCP

What a new feature touches in the AI layer of the Admin, and what stops a touch
point from being forgotten. Scope and behaviour stay in
[`docs/development/admin-mcp-completion-v1.md`](admin-mcp-completion-v1.md);
this page only lists the places.
`tests/unit/architecture/admin-mcp-extending.test.ts` fails when a file named
here no longer exists, or its file no longer declares a table named here.

- **forced**: typecheck fails until it is done.
- **guarded**: the named test fails until it is done.
- **review**: nothing fails; a reviewer checks it. The slice named in brackets
  is the one planned to make it forced or guarded.

Rules for every feature:

1. A feature is a new op on a tool that exists, never a new top-level tool:
   there are at most 15, and `ADMIN_MCP_NATIVE_TOOLS` already names the twelve
   planned.
2. Shared types live only in `packages/contracts`.
3. No enum that grows with the registry goes on tools/list; the runtime check
   holds it. `tests/unit/backend/admin-mcp-registry.test.ts` refuses one taken
   from a registry list, and any past eight values.
4. New behaviour is a new Behavior Matrix row by amendment. A frozen row does
   not change.
5. A migration only adds, and its id sorts after main's.
6. An op with no body yet is filed in `NOT_BUILT` under the slice that builds
   it; a table keyed by route or record type says `notBuilt('<slice>')` or
   `none('<reason>')`, never nothing. A slice that lands deletes its key, its
   rows and its `AI_ROUTE_PENDING` entries, then regenerates
   `docs/community/admin-mcp-capabilities.md`.
7. An op is renamed by a row in `ADMIN_OP_ALIASES`, kept at least 30 days and
   one Production release, and the row stays once retired. A release that
   changes what a client sees raises `ADMIN_MCP_CONTRACT_VERSION` in
   `packages/contracts/src/internal/admin-mcp/envelope.ts`.
8. A field the Backend adds to an AI answer is dropped on the AI path until the
   contract names it, so either side may ship first. A new Backend route ships
   before the Admin op that calls it.

## A community content type

| Touch point                               | File                                                         | Table                                                                                               | Caught by                                                                         |
| ----------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| The Owner's routes                        | `apps/admin/src/community/endpoints.ts`                      | `communityOperationDefinitions`                                                                     | guarded: `tests/unit/backend/admin-mcp-registry.test.ts`                          |
| Op names                                  | `packages/contracts/src/internal/admin-mcp/op-names.ts`      | `ADMIN_OP_NAMES`                                                                                    | guarded: `tests/unit/backend/admin-mcp-registry.test.ts`                          |
| Op rows                                   | `apps/admin/src/admin-mcp/ops/community.ts`                  | `rows`                                                                                              | forced                                                                            |
| What a read runs                          | `apps/admin/src/admin-mcp/ops/community-reads.ts`            | `COMMUNITY_READ_FACTS`                                                                              | forced; class by `tests/unit/backend/admin-mcp-totality.test.ts`                  |
| What a write runs                         | `apps/admin/src/admin-mcp/ops/community-writes.ts`           | `COMMUNITY_WRITE_FACTS`                                                                             | forced; class by `tests/unit/backend/admin-mcp-totality.test.ts`                  |
| The queue                                 | `apps/admin/src/admin-mcp/ops/list.ts`                       | `listOps`                                                                                           | forced                                                                            |
| Ops with no body                          | `tests/unit/backend/admin-mcp-not-built.ts`                  | `NOT_BUILT`                                                                                         | guarded: `tests/unit/backend/admin-mcp-totality.test.ts`                          |
| AI route rows                             | `packages/contracts/src/internal/admin-mcp/ai-routes.ts`     | `AI_OPERATOR_ROUTES`                                                                                | guarded: `tests/unit/backend/admin-mcp-route-parity.test.ts`                      |
| The record type                           | `packages/contracts/src/internal/admin-mcp/locate.ts`        | `ADMIN_COMMUNITY_RECORD_TYPES`                                                                      | review (S10); `RECORDS`, `COMMUNITY_READS` and `COMMUNITY_WRITES` are then forced |
| admin_get on it                           | `apps/admin/src/admin-mcp/tools/get-community.ts`            | `RECORDS`                                                                                           | forced                                                                            |
| What reads and writes around it           | `apps/admin/src/admin-mcp/actions-for.ts`                    | `COMMUNITY_READS`, `COMMUNITY_WRITES`                                                               | forced                                                                            |
| Find, lookup, count, settlement           | `packages/contracts/src/internal/admin-mcp/ai-reads.ts`      | `AI_FIND_SOURCES`, `AI_LOOKUP_TYPES`, `AI_COUNT_GROUPS`, `AI_SETTLEMENT_TYPES`, `AiOperatorSubject` | review (S10)                                                                      |
| Locate's branch names                     | `apps/admin/src/admin-mcp/locate.ts`                         | `COMMUNITY_SOURCE`                                                                                  | review (S10)                                                                      |
| Id shapes in a link                       | `apps/admin/src/admin-mcp/locate-reference.ts`               | `COMMUNITY_SHAPES`                                                                                  | review (S10)                                                                      |
| Ids an execute answer echoes              | `apps/admin/src/admin-mcp/ops/target.ts`                     | `PLATFORM_ID`                                                                                       | review (S10)                                                                      |
| The SQL behind find                       | `services/community-postgres/src/ai-operator-queries.ts`     | `LOOKUP_SOURCE`                                                                                     | forced once `ai-reads.ts` grows                                                   |
| The SQL behind its queue and count        | `services/community-postgres/src/operator-filters.ts`        | `OPERATOR_SOURCES`                                                                                  | forced once `AI_COUNT_GROUPS` grows                                               |
| The Backend route                         | `services/backend-runtime/src/community/operator-handler.ts` | `handleOperatorRequest`                                                                             | review; the CMS suites and PostgreSQL lane                                        |
| A write's receipt, with no body requestId | `services/backend-runtime/src/community/ai-operator.ts`      | `aiCommentReceipt`                                                                                  | review: without one a retry applies twice                                         |
| Every page and endpoint                   | `apps/admin/src/admin-mcp/surfaces.ts`                       | `ADMIN_SURFACES`                                                                                    | guarded: `tests/unit/backend/admin-mcp-registry.test.ts`                          |

## A field and a filter

| Touch point                                  | File                                                            | Table                           | Caught by                                                                                                                                                                                                                                                         |
| -------------------------------------------- | --------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The community filter                         | `packages/contracts/src/internal/community-operator/schemas.ts` | `operatorCommentQuerySchema`    | guarded: `tests/unit/admin/admin-mcp-query-reach.test.ts` wants a sample of each key a queue takes, and follows it to the SQL                                                                                                                                     |
| The Admin's query string                     | `apps/admin/src/community/endpoints.ts`                         | `communityOperationDefinitions` | guarded: `tests/unit/admin/admin-mcp-query-reach.test.ts`; a queue sends its whole query and names no field                                                                                                                                                       |
| The Backend's query                          | `services/backend-runtime/src/community/operator-handler.ts`    | `handleOperatorRequest`         | guarded: `tests/unit/admin/admin-mcp-query-reach.test.ts`, through the real handler and service to the port                                                                                                                                                       |
| The filter's SQL, for the list and the count | `services/community-postgres/src/operator-filters.ts`           | `OPERATOR_SOURCES`              | guarded: `tests/unit/backend/community-source-spec.test.ts` (each placeholder has a value, and the Owner's statements are the recorded ones) and `tests/integration/postgres/ai-operator-reads.test.ts` (each key narrows, and the count equals the list's total) |
| A CMS filter key                             | `packages/contracts/src/internal/admin-mcp/locate.ts`           | `adminCatalogListInputSchema`   | forced: its source's filter table must then hold a row for it                                                                                                                                                                                                     |
| Its Payload where and its SQL                | `apps/admin/src/admin-mcp/ops/list-sources.ts`                  | `LIST_SOURCES`                  | forced, side by side in the source's `filters`; that the two agree is guarded: `tests/cms/admin-mcp-locate.test.ts` tries every key of every source                                                                                                               |
| A missing-field filter                       | `packages/contracts/src/internal/admin-mcp/locate.ts`           | `ADMIN_CATALOG_MISSING_FIELDS`  | forced for a stateful text, which it takes from the editorial contract and a row must place in `STATEFUL_PROJECTIONS`; review for a plain field                                                                                                                   |

## An Owner page

| Touch point                     | File                                                    | Table            | Caught by                                                                                         |
| ------------------------------- | ------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| The page                        | `apps/admin/src/workspace/routes.ts`                    | `workspaces`     | guarded: `tests/unit/backend/admin-mcp-registry.test.ts`                                          |
| Its op, a tool, or an exclusion | `apps/admin/src/admin-mcp/surfaces.ts`                  | `ADMIN_SURFACES` | guarded: `tests/unit/backend/admin-mcp-registry.test.ts`; whether an exclusion is right is review |
| Op names                        | `packages/contracts/src/internal/admin-mcp/op-names.ts` | `ADMIN_OP_NAMES` | guarded: `tests/unit/backend/admin-mcp-registry.test.ts`                                          |
| Op rows, for an editorial page  | `apps/admin/src/admin-mcp/ops/editorial.ts`             | `editorialOps`   | forced                                                                                            |
| An op mapped to but not built   | `tests/unit/backend/admin-mcp-not-built.ts`             | `NOT_BUILT`      | guarded: `tests/unit/backend/admin-mcp-totality.test.ts`                                          |
| Offered on a found CMS record   | `apps/admin/src/admin-mcp/actions-for.ts`               | `SKELETONS`      | review                                                                                            |

## An irreversible op

| Touch point                          | File                                                         | Table                | Caught by                                                    |
| ------------------------------------ | ------------------------------------------------------------ | -------------------- | ------------------------------------------------------------ |
| Its row, by class                    | `apps/admin/src/admin-mcp/ops/define.ts`                     | `irreversibleOp`     | forced, through its family table                             |
| The irreversible set, pinned by hand | `tests/unit/backend/admin-mcp-registry.test.ts`              | —                    | guarded, on purpose                                          |
| Its AI route row, class irreversible | `packages/contracts/src/internal/admin-mcp/ai-routes.ts`     | `AI_OPERATOR_ROUTES` | guarded: `tests/unit/backend/admin-mcp-route-parity.test.ts` |
| Until that row exists                | `tests/unit/backend/admin-mcp-not-built.ts`                  | `AI_ROUTE_PENDING`   | guarded: `tests/unit/backend/admin-mcp-route-parity.test.ts` |
| The Backend's run mark               | `services/backend-runtime/src/community/operator-handler.ts` | `aiOperatorRefusal`  | guarded: `tests/cms/admin-mcp-community-writes.test.ts`      |
| Preview and impact                   | `packages/contracts/src/internal/admin-mcp/op-meta.ts`       | `previewHooks`       | review (S8)                                                  |
| Selection by a list                  | `packages/contracts/src/internal/admin-mcp/op-meta.ts`       | `selectorSources`    | guarded: `tests/unit/backend/admin-mcp-registry.test.ts`     |
