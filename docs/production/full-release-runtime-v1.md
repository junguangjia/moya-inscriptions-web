# full-release-runtime-v1

Task:
[Issue #191](https://github.com/junguangjia/moya-inscriptions-web/issues/191).
Baseline: `38fe82c20b66bc48a645a2e60853b741cb67608c`.

## Specification revision

r1. The Owner explicitly requested execution and authorized promoting the
existing complete business product to Production-capable code, preserving
Development fixtures and all unrelated rules. This narrowly supersedes previous
Development-only availability restrictions for these implemented business
surfaces. It grants no deployment or live-resource authority.

## Workstream

Shared: Web, Backend runtime/composition, Production configuration and directly
affected tests/documentation.

## Goal

Make the implemented Web and Backend business functionality work together in
Production mode as one full release.

## Non-goals

No UI redesign, new business feature, feature-flag platform, provider/session
replacement, dependency upgrade, migration/grant implementation, media
adapter/processor/worker internals, external Article MCP/OAuth implementation,
live resources, deployment, traffic, Ready transition or merge.

## Approved module scope

- apps/web/app/**: real product pages and API route handlers; preserve all
  Development-only QA/test routes.
- apps/web/features/product-application/**; apps/web/features/authors/** and
  apps/web/features/auth/** only necessary session/auth presentation wiring;
  apps/web/lib/public-api/** only necessary relay/client integration.
- services/backend-production/src/composition.ts and directly necessary
  exports/configuration (not publishing/storage/worker internals owned by media
  sibling).
- services/backend-runtime/src/application.ts, src/http/** and src/index.ts and
  existing service mounting/export integration only; no second auth/provider
  implementation.
- infra/production/** existing env/Nginx/systemd/templates/documentation, only
  verified integration requirements.
- apps/admin/src/community/{View.tsx,NavGroup.tsx,DashboardCard.tsx,endpoints.ts}
  and apps/admin/payload.config.ts (plus package exports for focused component
  tests): existing human business administration availability only; keep agent
  operations and external MCP/OAuth gated.
- Existing affected tests in apps/web and tests/unit/{architecture,backend}/**,
  focused Production integration tests and tests/e2e/** where needed.
- docs/production/full-release-runtime-v1.md and docs/project-status.md;
  directly affected existing endpoint/deployment documents. No database SQL,
  migration manifests, grant scripts, sibling mutable worktrees, protected local
  instructions or governance rewrites.

## Behavior that must remain unchanged

Existing UI, navigation, gestures, drafts, content identities, business limits,
moderation and publication states; Backend-owned sessions and public/Admin
identity separation; truthful Production data and preserved Development
fixtures; cancellation and graceful shutdown; startup is read-only and never
migrates or grants.

## Behavior Matrix

| Scenario                                                                    | Development                                     | Production                                                                            | Must Preserve                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Profiles/settings/follows/blocks/favorites/likes/comments/replies/discovery | Existing real business services and separate QA | Existing real business services via Web relays and Backend authorization              | Same contracts, UI, IDs, access and moderation                                |
| Works/drafts/publishing/Threads/DM/notifications                            | Existing real services                          | Existing real services; media-dependent journeys pending until sibling delivery       | Drafts, limits, cancellation, publication rules, worker shutdown              |
| Human Article authoring and existing human Admin operations                 | Existing implementations                        | Existing real services with private Admin boundary                                    | Public/Admin separation, revision authority, no external MCP/OAuth substitute |
| Real auth: login/register/recovery/binding/logout                           | Existing delivered auth implementation          | Consume delivered Production auth through same API; dependency pending if unavailable | One Backend session system; no simulated provider fallback                    |
| Test sign-in/verification/QA/diagnostics/mock data                          | Existing Development behavior retained          | Absent                                                                                | No QA identity/media promotion                                                |
| Database startup                                                            | Existing preparation and read-only checks       | Verified migration/grant dependency consumed; no startup DDL/grants                   | Least privilege, retained data untouched                                      |

## Observable acceptance criteria

1. Production pages, relays and Backend mount real implemented business surfaces
   with valid dependencies; dev entries remain absent.
2. Applicable contract/HTTP/Web/build/integration checks selected by verify-task
   execute against task-owned synthetic resources, with exact-head evidence.
3. Actual local Production build provides a usable acceptance preview;
   unsupported dependency journeys named precisely.
4. Reviewed Draft PR and existing private handoff; stop for Owner visual
   acceptance.

## Data and environment restrictions

Use isolated task worktree and synthetic task-owned database, ports and output.
No live resources, credentials publication, sibling changes or retained-data
changes. Test injection never becomes runtime fallback.

## Writer and review responsibility

Codex root is sole writer. Parallel audit and independent review agents are
read-only. Private evidence and checkpoint are task-owned. Normal task-git
helper and core-credential delivery batch required.

## Delivery stop, dependencies and required Owner decisions

Draft PR plus local Production-build preview; Owner visual acceptance required.
Do not mark Ready, merge, release, deploy, or alter public traffic. Consume
completed full-release-media-v1 and full-release-database-v1 dependencies from
main; separate real authentication and external Article MCP/OAuth remain
dependencies. Unavailable journeys stay pending; independent work continues.

## Integration inventory and pending dependencies

Business availability is changed at each existing boundary, not by globally
replacing `NODE_ENV`: Web root/providers and business relays; Backend
application, router and PostgreSQL composition; human Admin views and
authenticated endpoints. Notification services and their worker share the
existing signal bus; resource closure stops background work before closing
pools. Publishing keeps one transfer registry shared with its worker for
cancellation and expiry fencing.

| Dependency                     | Current baseline evidence                                                                                                              | Pending integration / acceptance                                                                                                                                                                                                                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real Production authentication | Only `createDevelopmentAuthService` is delivered in runtime exports; `assertProductionAuthConfiguration` refuses Production providers. | Consume the separate task's real factory/configuration and approved registration agreement presentation. Exercise login, registration, recovery, binding and logout. Local mail capture and simulated SMS are never fallback providers.                                                                        |
| `full-release-media-v1`        | Current `parsePublishingMediaConfig` / `openPublishingMedia` are Development filesystem processing configuration.                      | Consume the completed Production configuration through existing store/processor/runner ports, then start PublishingWorker. Apply exact Nginx upload/streaming limits, writable directories, systemd access and graceful-stop requirements from that delivery. Media uploads/processing/publishing are pending. |
| `full-release-database-v1`     | Startup calls read-only readiness and Community migration-ledger verification.                                                         | Consume verified migration manifests and runtime grants from main. Synthetic tests using current migrations are not Production database acceptance.                                                                                                                                                            |
| External Article MCP/OAuth     | Existing delegation configuration is explicitly Development-only.                                                                      | Consume its separate delivery; external authorization/consent/MCP journeys stay excluded and pending. Human Article authoring uses its existing service independently.                                                                                                                                         |

No sibling delivery was present in main at the baseline. Existing exported ports
are retained; no sibling internals, migrations or grants are duplicated. These
pending journeys do not constitute a staged or read-only release decision.
