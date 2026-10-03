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

## Baseline integration inventory (r1)

This table records the original dispatch baseline. The r3 continuation below
supersedes its separate-task exclusions and dependency status.

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

## Owner continuation r2: review repairs

The Owner renewed implementation on PR #195 on 2026-10-02. This revision first
addresses review comment 5954099894 in the same worktree and Draft PR. Previous
r1 failures remain evidence; they are not replaced with a passing claim.

- Construct the synthetic session identity with the existing PublicUserId
  schema.
- Reject GET sign-out with 405 before any upstream request or cookie change;
  preserve cross-site POST rejection and legitimate same-origin POST logout.
- Keep the general Nginx body bound at 1 MiB. The exact profile media route uses
  its existing 4 MiB limit; exact and descendant Article routes use 1 MiB plus
  the existing 16 KiB JSON envelope. Publishing upload limits await B's reviewed
  delivery rather than inheriting these unrelated limits.
- Consume database PR #196 from main `2ae25785bf8a7a06d240bd1b730e524c8b39621f`.
  C remains the sole writer of migrations, manifests and coordinated named
  grants.

Focused evidence and cumulative validation are recorded with the new candidate
in the private handoff and PR. Real proxy requests use a valid PNG and a valid
Article document near the document limit, with separate rejection checks for
oversized and ordinary-route bodies. Proxy ingress evidence alone does not
establish authenticated application or external-service acceptance.

## Authorized continuation after the review repairs

The Owner now authorizes implementation of the missing Production auth factory,
provider/configuration wiring and formal Article AI/MCP/OAuth integration in
this task. This supersedes the r1 exclusion of those implementations; the
existing auth, Session, provider ports, Article authorization and database
boundaries remain authoritative. No new framework, dependency upgrade or
parallel Session system is authorized. The next phase freezes its concrete paths
and behavior matrix before source edits and is delivered through the same Draft
PR.

Root owns shared composition, routers and deployment configuration. Production
Article environment constraints and any necessary named grant changes are sent
to C. B's COS factory, shared store, upload and worker are consumed only after
the repaired media PR is reviewed and merged into main.

The final common candidate requires a disposable database, Production build,
real HTTP and personally operated desktop/mobile browser acceptance for auth,
account isolation, media lifecycle and worker recovery, Article, comments,
notifications, messages, Admin and AI authorization/edit/publish/revoke.
Provider simulation is recorded separately from real external-service
verification. Real email/SMS activation and delivery, real credentials, live
privilege changes and deployment remain outside this authorization. Missing
implementation must remain explicitly pending rather than being called only
service activation.

## r3 frozen continuation and implemented boundaries

Scope is extended only to the existing auth application/config/ports, the
Backend auth factory and exports, shared registration schema/client/dialog,
existing Article issuer/provider/runtime and protected key/TLS validation,
non-DDL Session/Article authority reads, the existing composition/router and
Production deployment templates, and directly affected tests. Root remains the
sole shared source writer; media internals are consumed from B/main and all
SQL/manifests/grants remain C-owned. Necessary existing workspace dependency:
agent-authorization consumes catalog-postgres's verified TLS parser/pool; no
external version upgrade.

The agreed matrix preserves Development capture/QA and activates explicit
Production Tencent SES/optional Aliyun providers, versioned approved agreement
material, verified-login Production Sessions, and the existing Article
OAuth/PKCE/registry/MCP/human consent/exact candidate publication approvals.
Provider/signing/file/role configuration is validated before pools. Production
never uses Development capture/simulation or default signing keys. Five SQL
identities remain distinct and startup never changes schema/grants.

B's accepted main d434fac2060745d5ed29696197ca1cb857360c66 supplies the COS
factory/store/processor/runner. Shared composition supplies one transfer
registry, one store and the existing media/notification workers. The Nginx
upload bound is 8 GiB only for the exact raw component path; streaming preserves
cancellation, Range/status/private headers. Systemd Backend stop deadline is 90s
and only the private processing workspace is writable. Docker access/image/host
certification remains explicit setup acceptance, never silent privilege
expansion.

C's forward Article environment migration, PR197 at reviewed head
1b57fce3425756fbed244ed3cfde3edd9e34b781, was merged with explicit Owner
authorization into main 6e7b30fbae09715609d3faa521401f0484c09970 and consumed
unchanged. It permits Production without changing immutable
environment/owner/client or grants. All applicable PR CI passed; merged-main
CI37037145277 failed an existing filesystem test because a random first blob
occupied the directory reserved for its symlink case. The correction chooses a
disjoint synthetic key while retaining every refusal assertion; fresh candidate
CI remains required. Production auth factory/provider implementation and full
application acceptance are assessed separately from missing actual services,
approved legal material, external client registrations and deployment.

Current validation/history resides in the existing private task handoff. No
source patch, synthetic provider result, ingress check or dependency's passing
CI is a final common-candidate acceptance claim. Final exact-head results and
remaining gates are added after integration validation and personal browser QA.

## r4 necessary completion delta

The r3 candidate f42f204531f9567968e5e021c2505ce15fee3ade passed local full
validation. Hosted CI37039859022 completed PostgreSQL and Web assertions but
exhausted the unchanged 300-second cumulative test deadline during unit tests.
Prepared dependency hashes were rebuilt through a different default cache. The
r4 test command reads the same content-hashed library cache; every suite,
confidentiality check, filter and deadline remains intact. Tests execute on each
run, and only prepared library builds may be persisted. The interrupted run
remains INCOMPLETE evidence, not a failed-assertion or acceptance PASS.

The existing Article PRE_MODERATION Backend workflow lacked its human Admin
bridge. This delta adds the existing Owner queue, exact-candidate preview and
approve/reject actions to the current community view/nav/config/import map, with
necessary components, shared internal operator schemas, API/runtime preview
service/route/composition and directly affected tests. Managed preview media is
read through the existing derivative store, using only the pending candidate's
server-derived owner and used body/cover references. Every read pins version and
fingerprint and rechecks after opening the stream. No original object, arbitrary
URL, author Session substitute, SQL or grant change is added. Canonical
formatting and crop semantics remain the public reader's semantics.

Final acceptance uses a fresh empty disposable database and restricted roles.
The previous actual setup passed 10 Payload and 44 Community migrations, but its
startup failed because a private browser fixture password exceeded the existing
6–20 character contract. The fixture is corrected and schema-checked; failed
evidence and the populated database are retained. No database reset, policy
change, deleted test or browser credential injection substitutes for the new
common-candidate HTTP and personal desktop/mobile acceptance.

The Owner's subsequent review of r3 adds three correctness repairs to this same
round: authenticated source identity across Nginx/Web/Backend for OTP and
password limits; a Web Production streaming entry with ordinary total-body
bounds and upload-specific progress/size/concurrency protection; and exact
factor-completion receipt recovery after a lost response, with original/current
logout and cross-account replay protection. Scope includes the existing auth
service/port, non-DDL PostgreSQL adapter and memory test adapter, Web auth relay
and startup, Backend source admission/composition/router, existing deployment
templates and directly necessary tests. No client-supplied forwarded header is
trusted, no Admin operator credential reaches Web, and no migration/grant or
deadline increase is introduced. All changes after validation require a new
final run.

The streaming audit also found a wall-clock ceiling inside B's accepted COS
transport. That owned media repair is a separate dependency; A does not rewrite
the transport internals. Its exact reviewed result must be integrated and the
combined candidate revalidated before media streaming is marked complete.
Completed factor recovery uses existing receipt rows and hash-only lineage, with
User-first locks across completion, unlink replay and logout; it introduces no
Session framework, DDL or grants. OTP proof attempts retain their existing
five-attempt bound even when a caller changes network source.

R4 validation failures are retained: the existing exact Web environment
inventory was updated only for the two protected source-proof variables; the old
PostgreSQL concurrent-proof rendezvous now waits before User locking instead of
waiting behind its own lock. The five-second test deadline, one-winner and exact
factor-state assertions remain. The losing unlink response specifically reflects
the freshly revoked Session; the opposite loser still rejects its spent proof.
Final cumulative and hosted results are recorded for the exact delivery head.

## r5 common candidate after the media dependency

The Owner explicitly authorized exact-head PR198 integration. Reviewed head
32ac6a17aab2c373469ed2ea42e08ca4a9f75052 passed independent review and regular
CI37051226231 under the unchanged 300-second test ceiling. It was squash-merged
into main cb082829a22ecfd8abcd41eb2441c7584f9212a4 and consumed here. Only
publishing COS multipart transmission receives the existing bounded idle mode;
credential acquisition, connection/TLS, response headers, cancellation, size,
single attempt and other COS operations remain bounded. The filesystem fixture
merge retains this task's already reviewed disjoint initial shard and all
symlink refusal assertions. No composition interface, grant or dependency is
replaced.

The subsequent integration review found that a reused verified TLS socket emits
no second secureConnect, and that the response body still needs a finite
completion boundary. B repaired both in PR199 head
61ae1e67d0fd3df3f75853e36383b57bdb17f0aa. Independent review and complete
CI37056308076 attempt2 passed (250557ms within300000ms); the first unchanged
catalog workbook timeout and its diagnosis are retained. The Owner authorized
integration after main37fbb10cb6a23bce26a8dbc1786c05d1adc9ae2e was merged;
merged-main CI37058882555 also passed. The accepted four-path change is consumed
without replacing the Root fixture or shared interfaces. Verified reused TLS
clears only the completed setup phase; a one-shot response completion timer
retains a finite body boundary. These dependency passes do not establish a
combined PR195 acceptance. Cloud AI review remains unavailable due quota402.

The r4 Draft checkpoint is 65b6bdea430ff740f8d1ff6751a66af82e8ffa19. Its last
cumulative local validation remains FAIL: Web2440, unit2176, PostgreSQL599 and
CMS57 passed, but native Admin browser bootstrap refused the previously consumed
Owner fixture. All original failures and conditional skips remain recorded. The
two environment templates subsequently adopted the repository's recognized
explicit placeholder convention; the focused inventory passed11 checks, which
does not establish a new cumulative PASS.

The integrated r5 source is frozen before fresh complete validation, exact-head
CI, current-template Nginx ingress, restricted-role HTTP and personal
desktop/mobile acceptance. A fresh task-owned disposable database replaces the
consumed test input; the old database is retained without reset or adoption.
Formal Article SDK authorization, human consent and exact approval, editing,
Owner moderation/public reading and revocation use the same candidate and
existing identity/database boundaries. Simulated provider/COS transport results
remain separate from real external services. Registration agreement text/version
approval, real service credentials and delivery, live host configuration,
permission changes and deployment remain pending Owner gates. PR195 stays Draft.
