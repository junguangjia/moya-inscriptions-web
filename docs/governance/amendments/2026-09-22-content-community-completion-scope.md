# Owner Amendment — Content, Threads and direct messages (coordinated scope, track C)

- Status: Active
- Effective date: 2026-09-22
- Authority: the Owner's coordinated assignment of 2026-09-22 for three parallel
  Community tracks — A `email-auth-v1` (authentication), N
  `messaging-notification-foundation-v1` (notifications), C
  `content-community-completion-v1` (content and direct messages) — recorded as
  the C task Issue and in
  [`docs/community/content-community-completion-v1.md`](../../community/content-community-completion-v1.md).
- Applies to: Development and task-owned synthetic Owner QA only. Production
  composition is unchanged; no new surface is exposed outside the authorized
  Development runtime.

## Rule classification

- MODERNIZE — Community V1 amendment §10 ("does not authorize: posts; … direct
  messaging; notifications; user-uploaded media") for exactly the named
  capabilities of the three tracks: Thread posts as existing UserWorks
  associated to an operator-created Thread (C); one-to-one plain-text direct
  messages (C); the notification foundation (N); public login identities (A).
  Everything else in that list stays deferred (groups, DM attachments, comment
  images, marketplace, recommendations, Redis, another database, AI moderation,
  user reporting).
- MODERNIZE — Community V1 amendment §3 ("a comment references a `CatalogId`")
  and the Phase 4 extension to Works: the discussion target gains exactly one
  further kind, a published editorial Article, through the existing root/reply
  tables and their forward `CHECK`. No content-kind registry; a user, setting or
  DM is never a discussion target.
- MODERNIZE — Constitution §6 deferral of editorial domains: Payload gains the
  named editorial collections `articles` and `article-collections` under the
  P2-04 amendment's rules (drafts/versions, exact-revision Owner approval,
  published-only reads, scoped automation). No further collection kinds.
- PRESERVE — Constitution §1, §3, §4, §5, §7, §17, §19; the React current
  authority; single-main; validation profiles; credential check; P2-04 media
  boundary (no object key in frontend code); Community V1 §1–§2 (one
  `PublicUserId`, Backend-owned Sessions, no Payload/public-user sharing);
  data-admin-hardening role convergence; Agent Administration and Agent
  Connection permissions (none gained by adding collections).
- PRESERVE — physical names `catalog_comments`, `catalog_comment_replies`,
  `catalog_id`; the three receipt tables and their scopes; existing
  `page/pageSize/total` contracts (new mutable histories use bounded cursors).
- RETIRE — the earlier backend-completion-phase-handoff M0–M8 scheme (universal
  registry, physical comment-table rename, generic receipt consolidation,
  duplicate activity inbox, machine-only automatic merges). It was never adopted
  into governance; this records that it is not authorized.

## Coordination rules recorded

- One task record, worktree and feature Draft PR per track; no feature branch is
  based on an unmerged sibling; a temporary QA-integration worktree
  (`parallel-community-integration-qa`) owned by C's writer is the only
  authorized combination of unmerged siblings, for combined-head CI and joint
  acceptance only, never a merge source.
- Community migration allocation: A `2026092201xxxx`, N `2026092202xxxx`, C
  `2026092203xxxx`; integration range, if any, allocated by C after all three.
- Shared files (contracts exports/generated API, community migration manifest,
  `grant-runtime.sql`, Backend router/composition, Web session context/shell,
  comment and Work publication transactions, architecture allowlists) are
  integration hotspots: each track adds its own named block; integration
  preserves sibling blocks and regenerates generated output from combined
  sources.
- Delivery stops at reviewed Draft PRs. Neither implementer nor reviewer marks
  Ready, enables auto-merge, merges, closes the task, deploys, releases, mutates
  retained data or claims Production readiness. Owner visual/device acceptance
  is a separate fact.

This amendment records authorization and boundaries, not completion or
Production approval.
