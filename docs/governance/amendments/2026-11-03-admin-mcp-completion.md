# Owner Amendment — Admin MCP completion (AI operator identity)

- Status: Active
- Effective date: 2026-11-03, on Owner signature
- Authority: explicit Owner instructions of 2026-11-02 and 2026-11-03, quoted in
  section 1 and recorded as Issue #355 r2 (`admin-mcp-completion-v1`).
- Applies to: Admin and Backend, in Development and Production, for the
  `ai_operator` identity on `/api/mcp` and `/api/mcp-transfer/*`. This amendment
  authorizes code and migrations. Each Production deployment, credential and
  configuration change stays a separate Owner approval under the 2026-08-24
  amendment.
- Record: `docs/development/admin-mcp-completion-v1.md`.

## 1. Owner instruction

> AI应该可以通过MCP查看和操作所有我能做到的事情，并且能借用AI更高效高速的处理。基本上是全部权限

> 除此之外AI要能通过MCP快速定位帖子，catalog，用户等等，并对对应内容实施操作

> 全部都做，而且要保证原生，MCP需要比人工更快更准确。比如Umami的数据分析和各种数据的读取和反馈都要做的快，原生。可以参考我用的这些项目的成熟MCP的实现方式

The Owner's accompanying decisions:

1. Owner parity in Production: everything the Owner can do in the Admin,
   including approving, publishing, moderation and account suspension. AI
   executes on its own, with no per-item human approval, under a separate
   identity so the audit distinguishes AI from the Owner.
2. Locating posts, Catalog records, users and similar, then acting on what was
   found, is a first-class requirement.
3. Reserved to the Owner by hand and enforced server-side so no key can do them:
   creating or changing MCP keys and Admin accounts; the emergency pause switch;
   audit records.
4. Irreversible operations: AI previews, then executes by itself. A single
   execution above a threshold (default 20 targets, Owner-adjustable, not
   adjustable by AI) waits for one Owner confirmation. Reversible operations are
   not limited.
5. Direct messages, report evidence and raw IP data: tools are built but stay
   off behind a switch only the Owner can flip, after the privacy policy is
   changed and the Owner confirms compliance.
6. Scope is the Admin plus business operator scripts. Restart, deploy, config
   changes and direct SQL are not tools.
7. Outside parity because the Owner cannot do them either: plaintext phone and
   email; Catalog and media hard deletion.
8. Credential: a key on the public `/api/mcp` with 30-day expiry, last-used
   tracking, one-click pause, an audit page and a path rate limit. Clients to
   verify: Claude Code and Codex.
9. #343's prepare and release MCP tools move into #355. #343 keeps the Admin
   buttons and retiring `CMS_CATALOG_DIRECT_PUBLISH`.
10. #355 fixes only non-MCP findings that affect MCP. Login hardening goes to a
    separate Issue. Delivery is independent review then merge; Production
    deployment is a separate Owner approval; live acceptance is read-only.

Owner answers of 2026-11-02 to the seven questions in the Issue:

- Q1, byte channel: open, both directions: upload and ingest; download of
  originals, video derivatives, and PDF evidence with the evidence switch on.
- Q2, permanent identity: saves that bind a new permanent identity count as
  irreversible, classified by input. Preview lists the new identities. Above the
  threshold, one confirmation per batch.
- Q3, appeals: AI may review all appeals, including appeals against its own
  decisions.
- Q4, community tools: no code lock; a release check. AI and humans may both
  moderate. The public policy will say so, and that text must be live before
  community tools go live. Catalog work does not depend on it.
- Q5, self-only works: off behind an Owner-only switch, like direct messages,
  until the policy is changed. Then the Owner opens it. Reports on such works go
  to the Owner while it is off.
- Q6, evidence scope: literal. Only evidence files and file names sit behind the
  evidence switch, and raw IP records behind the IP switch. AI may read and
  handle rights-notice cases, forward notices and read visitor session details.
  A rights claimant's plaintext contact stays withheld from AI in every state.
- Q7: every item on the earlier not-wrapped list is in scope, natively.

Reading of 原生 recorded for this work: first-class tools designed for AI and
built into the server, returning direct structured results from the real source;
not wrappers over human screens, not scraping, not requiring a shell for normal
work. A measurable requirement follows: for each main task, MCP must be faster
and more accurate than a person using the Admin, and the record publishes the
result per task and client, failures included.

Two readings recorded and signed by the Owner. Q5 covers `visibility='self'`
works that are not deleted, because permanent deletion also sets that value; and
it extends to comments and replies under such a work, and to reports on them,
because they are withheld context of that work. Q6 places visitor session
details outside the Q4 release check, because they are analytics and not
community tools.

Owner answers of 2026-11-03, given with the signature:

- Policy text: the text drafted for the Owner is confirmed, without the optional
  sentence letting a user ask for review by an administrator. Appeals may
  therefore end in an AI decision with no route to a person; the Owner carries
  that choice, and whether it meets the law is the Owner's question.
- Policy timing: the text goes live with the first batch of this work, before
  any AI credential is placed in Production, so visitor session details are
  never sent ahead of it. The registration agreement version rises and existing
  users are notified.
- Dependency: `apps/admin` may directly reference `@modelcontextprotocol/sdk`
  1.30.0, already in the lockfile. This is a new direct reference, not an
  upgrade and not a new package.
- Separate user consent and contracts with model providers are the Owner's legal
  question. They do not block this work.

## 2. Rule classification (Constitution section 20)

Every entry below is scoped to the `ai_operator` identity on the MCP path.
Nothing is widened for `automation`, public users or any other caller.

| Rule                                                                                                                                                                                                   | Citation                                                                                                                                                                     | Class                                                                        | Effect                                                                                                                                                                                                                                                                                                                                                                                                | What stays                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Owner is the only V1 moderator; `automation` never moderates                                                                                                                                       | 2026-09-11 Community V1, line 303                                                                                                                                            | MODERNIZE                                                                    | `ai_operator` may moderate in Development and Production                                                                                                                                                                                                                                                                                                                                              | `automation` never moderates; each action records who and when                                                                                                                                                                                                       |
| No AI moderation; no moderator hierarchies                                                                                                                                                             | 2026-09-11, lines 328 and 458; 2026-09-22, line 23                                                                                                                           | MODERNIZE                                                                    | An operator AI executing through `ai_operator` is authorized, including reviewing all appeals, among them appeals against its own decisions                                                                                                                                                                                                                                                           | Trust scores, reputation, strikes, keyword engines and any further moderator hierarchy stay deferred; no system-embedded moderation provider                                                                                                                         |
| Bulk moderation is selected items on the current page only, at most 50; never every matching record; never bulk suspension or deletion. Section 13 permits exactly its listed changes                  | 2026-09-11 section 13 item 4, lines 592-597; lines 570-571                                                                                                                   | MODERNIZE, scoped to `ai_operator`                                           | On the MCP path, selectors over every matching record, unlimited reversible runs and bulk suspension are authorized, each target through the same single authorized operation with per-target outcomes. Bulk body deletion and thread removal run as previewed irreversible runs under the threshold                                                                                                  | The human Admin keeps the 50-item limit and its rules unchanged. Transition checks and per-item reporting stay. The publication setting still changes no existing comment. Hard deletion stays outside parity                                                        |
| Analysis recommends, humans decide; the audit table records human operator actions only; machine findings stay apart from the authoritative human audit trail; no external transmission                | 2026-09-11 section 13 item 5, lines 598-605; `docs/community-analysis-boundary.md`:30-31, :35-37                                                                             | MODERNIZE, rules 1 and 3 and the transmission clause, for `ai_operator` only | An operator AI decides and acts. Its actions are authoritative operator events in the same audit table, always labelled `ai-admin`, never `owner`. Community content it reads through MCP reaches the model provider of the AI client, as section 2's row on external AI subscriptions states                                                                                                         | `CommentAnalysisPort` stays disabled, advisory and without a write path; no analysis table; no system-embedded provider. Rules 2 and 4 stay. `docs/community-analysis-boundary.md`:62-63 is the PRESERVE basis for separate credentials and a label on every event   |
| The Owner receives and reviews complaints and appeals and reviews the necessity of every disclosure; human moderation carries a reason; rights-holder disputes require human judgment                  | `docs/community/community-reporting-appeals-v1.md`:18, :33-35, :40-42                                                                                                        | MODERNIZE                                                                    | `ai_operator` may receive and review complaints and appeals, including rights-holder disputes and appeals against its own decisions, may judge the necessity of a forward, and may decide restoration                                                                                                                                                                                                 | A reason, a staff-origin decision, an affected-user notification and an appeal path stay on every action. Urgent on-call handling, durable SES notification and legally required reports to the competent authority stay with the Owner, and no tool exists for them |
| Platform responses to rights claimants are labelled as Owner-authored handling results                                                                                                                 | `docs/community/community-reporting-appeals-v1.md`:67-68                                                                                                                     | MODERNIZE                                                                    | A response sent through `ai_operator` is a platform handling result, with `ai-admin` in its history; never Owner-authored, consistent with the separate-identity decision                                                                                                                                                                                                                             | Never a fabricated statement from an unrelated public account. Responses the Owner sends keep today's label                                                                                                                                                          |
| Comment `pending` to `visible` by Owner approval; only Owner approval makes comments visible; Owner-controlled global setting; Admin as the Owner interface                                            | 2026-09-11, lines 297, 300, 312-315, 316-321, 475-478, 487-490, 544. Section 11 says these are not reopened by any mission; this is an Owner amendment                       | MODERNIZE                                                                    | An action executed through `ai_operator` counts as that approval or control. MCP is a second client of the same authenticated Backend operator boundary                                                                                                                                                                                                                                               | Backend owns, persists and enforces the setting; Admin stays the Owner's interface; both modes keep their semantics                                                                                                                                                  |
| Payload users are exactly `owner`, `automation`                                                                                                                                                        | 2026-09-11, lines 83-84, 114 and row 6 at line 449; `docs/architecture.md`:286                                                                                               | MODERNIZE                                                                    | A third role value `ai_operator`, valid only with an MCP key. Section 9 row 6 changes to three values in the same PR as the role                                                                                                                                                                                                                                                                      | Payload users never become public users; public users never obtain Admin, REST, MCP or Local API access (lines 115-116)                                                                                                                                              |
| `packages/contracts/src/internal` holds an exact list                                                                                                                                                  | 2026-09-11, section 9 row 1, line 444; contracts export list pinned at lines 436-437                                                                                         | MODERNIZE                                                                    | Adds `admin-mcp`. The row and `tests/unit/architecture/community-v1-freeze.test.ts` and `contracts-surface.test.ts` change in the same PR, per lines 438-440. Row 6's regex is corrected so it cannot silently skip the new value                                                                                                                                                                     | Operator shapes stay server-only, never a root export                                                                                                                                                                                                                |
| No Payload collection references a `PublicUser`; Payload holds no comment or public-user collection; Payload gains no community collection                                                             | 2026-09-11, lines 117 and 311; 2026-09-16, lines 51-53                                                                                                                       | MODERNIZE, narrow                                                            | `mcp-audit-events` and `mcp_run_targets` hold opaque community ids, versions and, for a run in progress, command input, because a run must resume and undo. No foreign key, no community table, no community grant. `frozenInput` is cleared at a terminal state                                                                                                                                      | The CMS runtime role has no community grant; community content is not stored as content; Backend stays sole writer                                                                                                                                                   |
| No public CMS management API                                                                                                                                                                           | 2026-09-07 P2-04, line 40; 2026-09-11, line 84                                                                                                                               | MODERNIZE                                                                    | Ruling: a bearer-key `/api/mcp` with expiry, pause, audit and a path rate limit, and `/api/mcp-transfer/*` behind the same door, are authorized. They carry no anonymous access and no generic CRUD                                                                                                                                                                                                   | Native REST surfaces are unchanged; collections and globals stay empty on the plugin                                                                                                                                                                                 |
| Publication by automation requires a trusted Owner grant bound to exact unchanged revisions and media; Owner approvals bind exact revisions; regular automation cannot create its own approval         | 2026-09-07, lines 36-37; `docs/adr/0010-payload-editorial-source.md`:16-18; `docs/cms/p2-04-implementation.md`:16-18,43                                                      | MODERNIZE                                                                    | `ai_operator` publishes as the Owner's button does, with no grant, and may create approvals for automation accounts                                                                                                                                                                                                                                                                                   | Binding for `automation`, which still cannot approve itself; shared validation and atomic stale-revision checks on every mutation path (lines 37-38)                                                                                                                 |
| No external AI subscription                                                                                                                                                                            | 2026-09-07, line 41                                                                                                                                                          | MODERNIZE, ruling                                                            | The repository adds no provider, subscription or server-side model call. AI clients run under the Owner's own client accounts. Production content they read through MCP reaches their model providers; this use is authorized and is a real change in practice                                                                                                                                        | No model call from Admin or Backend; the policy text is confirmed, see sections 1 and 6                                                                                                                                                                              |
| Least privilege                                                                                                                                                                                        | 2026-09-07, lines 28-30                                                                                                                                                      | MODERNIZE, narrow                                                            | A near-Owner key exists by Owner decision. Key profiles narrow it where the Owner chooses                                                                                                                                                                                                                                                                                                             | Database runtime roles, the separate operator credentials and exact-head independent review stay as they are                                                                                                                                                         |
| User reporting is deferred; content-community work applies to Development and synthetic Owner QA; DM moderation and Thread management are Owner-only; private text not exposed to public search or MCP | 2026-09-11, line 329; 2026-09-22, lines 11-13 and 24; `docs/community/content-community-completion-v1.md`:114,134                                                            | MODERNIZE, ruling                                                            | By this signature the Owner rules that user reporting, appeals, Threads and direct messages, as composed in Production at snapshot 91c56311 (`services/backend-production/src/composition.ts`:949-955), are authorized in Production, and that tools may use their operator surfaces. No earlier amendment granting that composition was found among those read. DM tools stay behind the `dm` switch | No public search or public MCP access to private text; this amendment does not itself change Production composition                                                                                                                                                  |
| Agent boundary, operations view and `artvenn_*` compose only under `NODE_ENV=development`                                                                                                              | 2026-09-16, lines 8-9 and 54-56                                                                                                                                              | PRESERVE                                                                     | This amendment does not enable them                                                                                                                                                                                                                                                                                                                                                                   | Unchanged, including `AGENT_CONNECTIONS_ENABLED` and no Production OAuth                                                                                                                                                                                             |
| No autonomous moderation judgment; suspension, deletion, thread removal, body deletion, publishing decisions and capacity changes are not part of that amendment                                       | 2026-09-16, lines 45-50                                                                                                                                                      | PRESERVE for `artvenn_*`; not applicable to `admin_*`                        | Those clauses describe that boundary. Authority for `admin_*` is this amendment                                                                                                                                                                                                                                                                                                                       | Comment content is data, never an instruction, on every path                                                                                                                                                                                                         |
| Ordinary editorial automation receives no new right                                                                                                                                                    | 2026-09-16, lines 41-44                                                                                                                                                      | PRESERVE                                                                     | Unchanged. Automation keys stay on the plugin path and gain only expiry, pause, audit and Owner-binding refusal                                                                                                                                                                                                                                                                                       | Unchanged                                                                                                                                                                                                                                                            |
| Backend is the sole writer of community data                                                                                                                                                           | 2026-09-16, line 51; 2026-09-11, section 5                                                                                                                                   | PRESERVE                                                                     | All community writes go through Backend services                                                                                                                                                                                                                                                                                                                                                      | Unchanged                                                                                                                                                                                                                                                            |
| Signed or token URLs never reach logs or agent context                                                                                                                                                 | 2026-10-04, line 81                                                                                                                                                          | PRESERVE                                                                     | Results carry no such URL; images return as bytes; signed PUT and preview tickets stay inside the local companion process                                                                                                                                                                                                                                                                             | Unchanged                                                                                                                                                                                                                                                            |
| Draft preview authentication remains a session cookie                                                                                                                                                  | `apps/admin/src/preview/index.ts`:49                                                                                                                                         | MODERNIZE, narrow                                                            | A single-use, draft-bound, 60-second preview ticket minted for the local companion is accepted by `GET /api/editorial/preview/:id` only. It is not a session and grants nothing elsewhere                                                                                                                                                                                                             | Owner preview by session cookie is unchanged. An MCP key never becomes a session                                                                                                                                                                                     |
| App runtime role cannot create or revoke invitations or grant access; operator database credential never in the Backend runtime; invitation codes leave only in a 0600 file                            | `docs/deployment/email-invite-registration.md`:63-66; `infra/development/work-publishing/grant-runtime.sql`:356-357; `scripts/manage-registration-invitations.mjs`:66,88-120 | MODERNIZE                                                                    | Fixed SECURITY DEFINER functions let the App role create and revoke invitations and set beta access, each writing an audit row. The plain code returns once in the tool result, the one stated exception to no credentials in results, because AI hands it over. Wider exposure, stated: anyone who compromises the Backend can now mint invitations, and the code reaches the model provider         | The App role still has no direct write on those tables; the operator database credential stays out of the Backend; the code is never in an audit row or log                                                                                                          |
| Password account provisioning is an offline operator authority, never runtime provisionable, never imported by a running application                                                                   | `infra/development/work-publishing/grant-runtime.sql`:366; `scripts/provision-password-account.mjs`:73                                                                       | MODERNIZE                                                                    | A fixed SECURITY DEFINER function lets the App role provision one account per call, with replay checks and an audit row. Wider exposure, stated: anyone who compromises the Backend can create password accounts                                                                                                                                                                                      | The App role keeps no direct write on `operator_password_accounts`; passwords never pass through a model, a tool result or an audit row; the CLI stays                                                                                                               |
| Each Production `catalog-master` run is an Owner run                                                                                                                                                   | `services/backend-production/src/catalog-master-cli.ts`:24-31 (code comment, not an amendment)                                                                               | MODERNIZE                                                                    | All master ops may run as tools, including new-byte attach, attach-batch and the manifest step                                                                                                                                                                                                                                                                                                        | Server checks, size and pixel limits, and sha256 binding stay in their current order                                                                                                                                                                                 |
| Upload GC execution held by an Owner KEEP pending a later explicit scope change                                                                                                                        | `docs/deployment/upload-session-retention.md`:120-124                                                                                                                        | MODERNIZE                                                                    | Decision 6 supplies the scope change for the tool                                                                                                                                                                                                                                                                                                                                                     | Execution stays off until the Owner sets `ADMIN_MCP_UPLOAD_GC_RUN`                                                                                                                                                                                                   |
| Analytics credentials: the Admin process holds a viewer only; bootstrap credentials are not for Web or Admin; maintenance and export use separate configured credentials                               | `docs/analytics/umami-integration.md`:85,107,355-400; `apps/admin/src/analytics/upstream.ts`                                                                                 | MODERNIZE, narrow                                                            | Admin may hold a separate team-member Umami identity for definition routes only, behind an allowlist excluding reset and website delete. Backend may read the existing maintenance config to run the fixed prune. Canonical export runs on the App role's existing read                                                                                                                               | Bootstrap credentials stay out of long-running processes; prune keeps its fixed 180 days with no argument; export never joins raw IP or UA; Umami's own MCP route stays off                                                                                          |
| Constitution sections 1, 3, 7, 19; 2026-08-24; 2026-09-07 confidentiality                                                                                                                              |                                                                                                                                                                              | PRESERVE                                                                     | Frozen scope, Behavior Matrix, no credentials, no direct UI database access, shared types only in `packages/contracts`, no dependency upgrades, apart from the direct reference approved in section 1                                                                                                                                                                                                 | Unchanged                                                                                                                                                                                                                                                            |

This amendment does not decide open item A5, the Production App-role contract
(`docs/community/data-admin-hardening-v1.md`:58,163-164;
`infra/production/README.md`:416-420). The release record checks the grants this
work needs.

## 3. What this authorizes

- Payload role `ai_operator`, granting Owner-level authority only when
  `_strategy` is `mcp-api-key`.
- The `admin_*` MCP tools listed in the record on a native server path at
  `/api/mcp`, reusing existing Admin and Backend services and receipts.
  Automation keys and Development connection tokens stay on the plugin path.
- Two Backend operator credentials whose audit label is `ai-admin`, used on JSON
  and binary routes: `OPERATOR_AI_BASE_TOKEN` for Catalog thumbnails, Catalog
  masters and analytics, placed at deployment once the policy text is live; and
  `COMMUNITY_OPERATOR_AI_TOKEN` for community routes, placed after the policy
  text is live.
- Additive operator query filters, AI output schemas, a find route, a settlement
  route, analytics insight routes, narrow routes for business scripts, and the
  control and audit surfaces.
- The transfer door `/api/mcp-transfer/*` and the local companion
  `artvenn-files`, in both directions, including local rendering of a draft
  preview and local runs of the P5 and pilot CLIs against disposable or pilot
  databases.
- One oneshot systemd timer that writes hourly aggregate traffic snapshots,
  installed only under an approved deployment. No always-on process.
- Moving #343's seven delivery tools into this task.

## 4. Reserved to the Owner

The following require an Owner browser session: JWT strategy, session cookie, no
`Authorization` header. No key of any kind passes, including an Owner REST key,
and neither does an Owner JWT sent in a header. Covered: creating or changing
MCP keys and Admin accounts; the pause switch; audit records; the threshold;
sensitive switches; confirming a run above the threshold. Any other Owner
credential may still read its own account row, because existing tools depend on
`/api/users/me`.

Known limit: a process holding a live Owner JWT can replay it as a cookie, and
the server cannot tell. The token lasts 2 hours. Keeping such a token away from
AI clients is the Owner's control.

Audit records are append-only by database grant, with a trigger as a second net.
No account can update or delete them through the application. AI cannot read the
audit table; it reads its own run state.

## 5. Irreversible operations

The pinned set is in the record: delete comment body, remove thread, remove
direct message, abandon publishing job, forward report text, release legal hold,
erase master, revoke invitation, execute upload cleanup, provision a password
account, run the Umami prune, delete an analytics definition, register an
uploaded file under a new media id. Any save that binds an identity not yet
bound is added, on any record type, classed by input: creating a Catalog,
Article or Collection, registering media, duplicating a record, or adding a
`sourceId` not yet bound.

A target is one row in the frozen selection, per Decision 4. Removing a thread
is one target; the preview shows its affected replies. A prune run is one
target. A new media id is one target. A batch of identity-binding saves or new
media ids counts its targets, and above the threshold needs one confirmation per
batch. The upload complete step in the transfer door refuses an unregistered
media id without a matching run.

The limit is per single execution, as decided, so splitting into smaller runs is
visible on the control page and is not blocked. Reversible operations have no
quantity limit; work is chunked per call, the AI client continues without a
human step, and nothing is truncated. Taking over a document lock is reversible,
because the Owner can take it back.

## 6. Sensitive data and policy order

Public policy text currently promises more than the sentence on evidence.
`apps/web/app/policies/content.ts` lines 19, 35, 36, 40, 53, 57, 90, 94 and 98
state human or Owner review, advisory-only automated suggestions, no automated
moderation provider, and no evidence sent to external AI. Those statements stop
being accurate as soon as AI moderates, whether or not the sensitive switches
are on.

1. Sensitive switches: direct messages, evidence files and file names, raw IP
   records, self-only works. Each is one Owner-only switch on the control page,
   opened by the Owner's typed compliance confirmation, with no release,
   environment change or restart. The Backend's category list is provisioned at
   deployment and serves as a host-side hard off. A constant in
   `packages/contracts` is tied by a test to the policy text and shows on the
   control page whether the text covers the category; it refuses nothing.
   Opening after the policy change is the Owner's ordering.
2. Community tools and the policy text: no code lock. The release check is that
   `COMMUNITY_OPERATOR_AI_TOKEN` is not placed in Production until the Owner has
   confirmed the new text is live. Without it every community tool answers
   `AI_CREDENTIAL_NOT_CONFIGURED`. Catalog work, including thumbnails and every
   master operation, and all of analytics run on `OPERATOR_AI_BASE_TOKEN` and do
   not depend on it. By the Owner's answer of 2026-11-03 the policy text ships
   with the first batch, so `OPERATOR_AI_BASE_TOKEN` is also placed only after
   that text is live.
3. Scope of "report evidence": literal. Only evidence files and file names sit
   behind the evidence switch. AI may read and handle rights-notice cases,
   including claimant name, rights basis, description, materials, statements,
   forwarded messages, audit reasons and appeal text, may forward notices, and
   may read visitor session details. Raw IP records sit behind the raw IP
   switch.
4. Self-only works: works with `visibility='self'` that are not deleted,
   withheld from AI on every read path, each named and tested, until the policy
   changes and the Owner opens the switch. Comments and replies under such a
   work are withheld with it. While off, reports on such works and on those
   comments go to the Owner: AI sees that the case exists and that it belongs to
   the Owner, and every write on such a case, work or comment is refused.
   Reports and appeals on works the author permanently deleted are not covered
   and stay with AI.
5. Appeals: AI may review all appeals, including appeals against its own
   decisions. The record shows `ai-admin` as operator.

Policy wording was confirmed by the Owner. Any legal assessment belongs to the
Owner; this amendment does not supply one.

## 7. Outside parity

Plaintext phone and email; Catalog and media hard deletion. No tool exists, and
none may be added under this amendment.

Factual correction: the Owner can read a rights claimant's plaintext `contact`
on a report. AI cannot, in any state of any switch. Text a claimant typed
elsewhere may still contain contact details, and on rights-notice cases that
text is readable by AI.

## 8. Not tools

- Server restart, deploy, configuration change and direct SQL.
- Reserved surfaces in section 4.

Every item on the earlier not-wrapped list is delivered: password account
provisioning, without the password passing through a model; new-byte deep zoom
attach, attach-batch and manifest; Catalog import and validation; the P5 and
pilot CLIs; search rebuild without a database credential; `cms:legacy`;
canonical export; analytics definition edits; manual prune; traffic summary;
report CSV; rendered draft preview; document lock takeover; Catalog duplicate
with a new identity.

Two limits are part of that delivery. `p5:apply-validation` and the pilot
commands never run on Production: they run as local companion modes against
disposable or pilot databases, with their own guards intact, and no URL,
credential or SQL in any tool argument. A rendered draft is produced on the
client machine by the companion, so the server gains no browser.

## 9. Bulk ledger

`mcp_runs` and `mcp_run_targets` hold references, versions, frozen input and
outcomes. Every effect goes through the existing service or Payload hook. They
coordinate; they are not a second business system, and the repository rule
against parallel systems is preserved.

`agent_operations` and `artvenn_*` stay Development-only and dormant in
Production. Any later retirement or promotion of that path is a separate Owner
decision.

## 10. Migrations approved (Constitution section 17, item 3)

CMS: `enum_users_role` value `ai_operator`; `payload_mcp_api_keys` fields
`expires_at`, `last_used_at`, `tool_profile`, with backfill; `mcp_control`
global tables; `mcp_audit_events` with trigger; `editorial_receipts` `article`
and `articleCollection` relationships and operation values; `mcp_runs`;
`mcp_run_targets`.

Community: indexes on `report_cases` (target and affected user) and `feedback`
(user); fixed functions for invitation create and revoke, beta access and
password account provisioning, with grants.

No other migration is approved. A trigram index, an analytics index or a Umami
database index needs measured evidence and its own record.

## 11. Delivery

Each slice is delivered by independent review of the exact HEAD, then
expected-head squash merge and merged-head verification. Test environments use
PostgreSQL 16. Code complete, deployment and live acceptance are recorded
separately. Live acceptance is read-only, so Production write paths stay marked
as unproven until first real use.

No dependency is upgraded by this work. The only dependency change is the direct
`apps/admin` reference to `@modelcontextprotocol/sdk` 1.30.0 approved in
section 1.

## 12. Documents to correct with this work

`infra/production/nginx/yoyi.conf.template` comment at lines 108-109;
`infra/production/README.md`:551-553; `docs/architecture.md`:286;
`docs/cms/operations.md`:48-66; `docs/cms/p2-04-implementation.md`:16-18,43;
`docs/community-analysis-boundary.md`:30-37,55-63;
`docs/community/agent-admin-v1.md`;
`docs/community/community-reporting-appeals-v1.md`:18,33-35,40-42,67-68;
`docs/community/content-community-completion-v1.md`:114,134;
`docs/deployment/email-invite-registration.md`:63-66;
`docs/deployment/upload-session-retention.md`:120-124;
`docs/analytics/umami-integration.md`;
`docs/governance/amendments/2026-09-11-community-v1-scope.md` section 9 rows 1
and 6; the comment on operator scope in `apps/admin/src/community/endpoints.ts`;
`apps/admin/src/community/dm-moderation-client.tsx`:21-27 comment;
`apps/admin/src/preview/index.ts`:49 comment;
`infra/development/work-publishing/grant-runtime.sql`:366 comment;
`scripts/provision-password-account.mjs`:73 comment;
`services/backend-production/src/catalog-master-cli.ts`:24-31 comment; root
`AGENTS.md` active amendment list.
