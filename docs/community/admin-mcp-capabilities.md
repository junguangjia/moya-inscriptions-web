# Admin MCP capabilities

Generated from `apps/admin/src/admin-mcp/registry.ts` and
`apps/admin/src/admin-mcp/surfaces.ts`. Do not edit by hand. To regenerate, run
`pnpm --filter @moya/tests exec vitest run unit/backend/admin-mcp-registry.test.ts -u`;
the same test fails while this file is stale.

Scope and rules: `docs/development/admin-mcp-completion-v1.md`. "Built" says
whether a slice has given the op its implementation yet; an op that is not built
reports `not_available`.

## Ops (133)

### community (44)

| Op                                        | Class                                                   | Tool                         | Completion | Recovery         | Credential | Switch | Built |
| ----------------------------------------- | ------------------------------------------------------- | ---------------------------- | ---------- | ---------------- | ---------- | ------ | ----- |
| `community.read-reports`                  | read                                                    | `admin_read`                 | sync       | state_idempotent | community  |        | yes   |
| `community.read-report`                   | read                                                    | `admin_read`                 | sync       | state_idempotent | community  |        | yes   |
| `community.decide-report`                 | reversible                                              | `admin_execute`              | async      | cas_read_back    | community  |        | no    |
| `community.review-report`                 | reversible                                              | `admin_execute`              | async      | cas_read_back    | community  |        | no    |
| `community.set-report-metadata`           | reversible; irreversible when legalHold is set to false | `admin_execute`              | sync       | cas_read_back    | community  |        | no    |
| `community.forward-report`                | irreversible                                            | `admin_execute_irreversible` | sync       | cas_read_back    | community  |        | no    |
| `community.read-feedback`                 | read                                                    | `admin_read`                 | sync       | state_idempotent | community  |        | yes   |
| `community.read-works`                    | read                                                    | `admin_read`                 | sync       | state_idempotent | community  |        | yes   |
| `community.read-users`                    | read                                                    | `admin_read`                 | sync       | state_idempotent | community  |        | yes   |
| `community.recommend-user`                | reversible                                              | `admin_execute`              | sync       | receipt          | community  |        | no    |
| `community.moderate-work`                 | reversible                                              | `admin_execute`              | async      | receipt          | community  |        | no    |
| `community.read-featured`                 | read                                                    | `admin_read`                 | sync       | state_idempotent | community  |        | yes   |
| `community.set-featured`                  | reversible                                              | `admin_execute`              | sync       | receipt          | community  |        | no    |
| `community.set-featured-quantity`         | reversible                                              | `admin_execute`              | sync       | receipt          | community  |        | no    |
| `community.delete-body`                   | irreversible                                            | `admin_execute_irreversible` | sync       | receipt          | community  |        | no    |
| `community.remove-thread`                 | irreversible                                            | `admin_execute_irreversible` | sync       | receipt          | community  |        | no    |
| `community.read-dm-conversation`          | read                                                    | `admin_sensitive_read`       | sync       | state_idempotent | community  | dm     | no    |
| `community.lookup-dm-conversation`        | read                                                    | `admin_sensitive_read`       | sync       | state_idempotent | community  | dm     | no    |
| `community.remove-dm-message`             | irreversible                                            | `admin_execute_irreversible` | sync       | receipt          | community  | dm     | no    |
| `community.read-threads`                  | read                                                    | `admin_read`                 | sync       | state_idempotent | community  |        | yes   |
| `community.create-thread`                 | reversible                                              | `admin_execute`              | sync       | receipt          | community  |        | no    |
| `community.update-thread`                 | reversible                                              | `admin_execute`              | sync       | receipt          | community  |        | no    |
| `community.read-feature-catalogs`         | read                                                    | `admin_read`                 | sync       | state_idempotent | none       |        | yes   |
| `community.read-policy`                   | read                                                    | `admin_read`                 | sync       | state_idempotent | community  |        | yes   |
| `community.set-policy`                    | reversible                                              | `admin_execute`              | sync       | cas_read_back    | community  |        | no    |
| `community.read-comments`                 | read                                                    | `admin_read`                 | sync       | state_idempotent | community  |        | yes   |
| `community.read-comment`                  | read                                                    | `admin_read`                 | sync       | state_idempotent | community  |        | yes   |
| `community.moderate-comment`              | reversible                                              | `admin_execute`              | sync       | receipt          | community  |        | no    |
| `community.moderate-user`                 | reversible                                              | `admin_execute`              | async      | cas_read_back    | community  |        | no    |
| `community.read-events`                   | read                                                    | `admin_read`                 | sync       | state_idempotent | community  |        | yes   |
| `community.read-summary`                  | read                                                    | `admin_read`                 | sync       | state_idempotent | community  |        | yes   |
| `community.read-work-publishing-settings` | read                                                    | `admin_read`                 | sync       | state_idempotent | community  |        | yes   |
| `community.set-work-publishing-settings`  | reversible                                              | `admin_execute`              | sync       | receipt          | community  |        | no    |
| `community.read-article-submissions`      | read                                                    | `admin_read`                 | sync       | state_idempotent | community  |        | yes   |
| `community.read-article-submission`       | read                                                    | `admin_read`                 | sync       | state_idempotent | community  |        | yes   |
| `community.moderate-article-submission`   | reversible                                              | `admin_execute`              | async      | receipt          | community  |        | no    |
| `community.read-work-submissions`         | read                                                    | `admin_read`                 | sync       | state_idempotent | community  |        | yes   |
| `community.read-work-submission`          | read                                                    | `admin_read`                 | sync       | state_idempotent | community  |        | yes   |
| `community.moderate-work-submission`      | reversible                                              | `admin_execute`              | async      | receipt          | community  |        | no    |
| `community.read-account-capacity`         | read                                                    | `admin_read`                 | sync       | state_idempotent | community  |        | yes   |
| `community.set-account-capacity`          | reversible                                              | `admin_execute`              | sync       | receipt          | community  |        | no    |
| `community.read-publishing-jobs`          | read                                                    | `admin_read`                 | sync       | state_idempotent | community  |        | yes   |
| `community.retry-publishing-job`          | reversible                                              | `admin_execute`              | async      | receipt          | community  |        | no    |
| `community.abandon-publishing-job`        | irreversible                                            | `admin_execute_irreversible` | sync       | receipt          | community  |        | no    |

### editorial (17)

| Op                                        | Class                                                                  | Tool            | Completion | Recovery         | Credential | Switch | Built |
| ----------------------------------------- | ---------------------------------------------------------------------- | --------------- | ---------- | ---------------- | ---------- | ------ | ----- |
| `editorial.owner-drafts`                  | read                                                                   | `admin_read`    | sync       | state_idempotent | none       |        | yes   |
| `editorial.owner-history`                 | read                                                                   | `admin_read`    | sync       | state_idempotent | none       |        | yes   |
| `editorial.read-draft`                    | read                                                                   | `admin_read`    | sync       | state_idempotent | none       |        | yes   |
| `editorial.save-draft`                    | reversible; irreversible when the save binds an identity not yet bound | `admin_execute` | sync       | receipt          | none       |        | yes   |
| `editorial.approve-batch`                 | reversible                                                             | `admin_execute` | sync       | receipt          | none       |        | yes   |
| `editorial.publish-approved`              | reversible                                                             | `admin_execute` | sync       | receipt          | none       |        | yes   |
| `editorial.restore-draft`                 | reversible                                                             | `admin_execute` | sync       | receipt          | none       |        | yes   |
| `editorial.prepare-catalog-delivery`      | reversible                                                             | `admin_execute` | async      | receipt          | none       |        | yes   |
| `editorial.read-catalog-delivery`         | read                                                                   | `admin_read`    | sync       | state_idempotent | none       |        | yes   |
| `editorial.request-catalog-release`       | reversible                                                             | `admin_execute` | async      | receipt          | none       |        | yes   |
| `editorial.release-catalog-delivery`      | reversible                                                             | `admin_execute` | sync       | receipt          | none       |        | yes   |
| `editorial.cancel-catalog-delivery`       | reversible                                                             | `admin_execute` | sync       | receipt          | none       |        | yes   |
| `editorial.catalog-delivery-capabilities` | read                                                                   | `admin_read`    | sync       | state_idempotent | none       |        | yes   |
| `editorial.catalog-render-backlog`        | read                                                                   | `admin_read`    | sync       | state_idempotent | none       |        | yes   |
| `editorial.save-article-draft`            | reversible; irreversible when the save binds an identity not yet bound | `admin_execute` | sync       | receipt          | none       |        | yes   |
| `editorial.approve-article-batch`         | reversible                                                             | `admin_execute` | sync       | receipt          | none       |        | yes   |
| `editorial.publish-approved-article`      | reversible                                                             | `admin_execute` | sync       | receipt          | none       |        | yes   |

### list (28)

| Op                         | Class | Tool         | Completion | Recovery         | Credential | Switch | Built |
| -------------------------- | ----- | ------------ | ---------- | ---------------- | ---------- | ------ | ----- |
| `list.comments`            | read  | `admin_read` | sync       | state_idempotent | community  |        | yes   |
| `list.works`               | read  | `admin_read` | sync       | state_idempotent | community  |        | yes   |
| `list.users`               | read  | `admin_read` | sync       | state_idempotent | community  |        | yes   |
| `list.threads`             | read  | `admin_read` | sync       | state_idempotent | community  |        | yes   |
| `list.featured`            | read  | `admin_read` | sync       | state_idempotent | community  |        | yes   |
| `list.feature_catalogs`    | read  | `admin_read` | sync       | state_idempotent | none       |        | yes   |
| `list.reports`             | read  | `admin_read` | sync       | state_idempotent | community  |        | yes   |
| `list.appeals`             | read  | `admin_read` | sync       | state_idempotent | community  |        | yes   |
| `list.work_submissions`    | read  | `admin_read` | sync       | state_idempotent | community  |        | yes   |
| `list.article_submissions` | read  | `admin_read` | sync       | state_idempotent | community  |        | yes   |
| `list.jobs`                | read  | `admin_read` | sync       | state_idempotent | community  |        | yes   |
| `list.feedback`            | read  | `admin_read` | sync       | state_idempotent | community  |        | yes   |
| `list.events`              | read  | `admin_read` | sync       | state_idempotent | community  |        | yes   |
| `list.policy`              | read  | `admin_read` | sync       | state_idempotent | community  |        | yes   |
| `list.work_settings`       | read  | `admin_read` | sync       | state_idempotent | community  |        | yes   |
| `list.overview`            | read  | `admin_read` | sync       | state_idempotent | community  |        | yes   |
| `list.catalogs`            | read  | `admin_read` | sync       | state_idempotent | none       |        | yes   |
| `list.review_page`         | read  | `admin_read` | sync       | state_idempotent | none       |        | yes   |
| `list.approvals`           | read  | `admin_read` | sync       | state_idempotent | none       |        | yes   |
| `list.article_approvals`   | read  | `admin_read` | sync       | state_idempotent | none       |        | yes   |
| `list.receipts`            | read  | `admin_read` | sync       | state_idempotent | none       |        | yes   |
| `list.articles`            | read  | `admin_read` | sync       | state_idempotent | none       |        | yes   |
| `list.collections`         | read  | `admin_read` | sync       | state_idempotent | none       |        | yes   |
| `list.media`               | read  | `admin_read` | sync       | state_idempotent | none       |        | yes   |
| `list.render_backlog`      | read  | `admin_read` | sync       | state_idempotent | none       |        | yes   |
| `list.invitations`         | read  | `admin_read` | sync       | state_idempotent | community  |        | no    |
| `list.masters`             | read  | `admin_read` | sync       | state_idempotent | base       |        | no    |
| `list.runs`                | read  | `admin_read` | sync       | state_idempotent | none       |        | no    |

### catalog (5)

| Op                   | Class        | Tool                         | Completion | Recovery | Credential | Switch | Built |
| -------------------- | ------------ | ---------------------------- | ---------- | -------- | ---------- | ------ | ----- |
| `catalog.publish`    | reversible   | `admin_execute`              | sync       | receipt  | none       |        | yes   |
| `catalog.withdraw`   | reversible   | `admin_execute`              | async      | receipt  | none       |        | yes   |
| `catalog.restore`    | reversible   | `admin_execute`              | sync       | receipt  | none       |        | yes   |
| `catalog.patch_text` | reversible   | `admin_execute`              | sync       | receipt  | none       |        | yes   |
| `catalog.duplicate`  | irreversible | `admin_execute_irreversible` | sync       | receipt  | none       |        | no    |

### approval (1)

| Op                | Class      | Tool            | Completion | Recovery         | Credential | Switch | Built |
| ----------------- | ---------- | --------------- | ---------- | ---------------- | ---------- | ------ | ----- |
| `approval.revoke` | reversible | `admin_execute` | sync       | state_idempotent | none       |        | yes   |

### article (4)

| Op                  | Class        | Tool                         | Completion | Recovery | Credential | Switch | Built |
| ------------------- | ------------ | ---------------------------- | ---------- | -------- | ---------- | ------ | ----- |
| `article.publish`   | reversible   | `admin_execute`              | sync       | receipt  | none       |        | yes   |
| `article.withdraw`  | reversible   | `admin_execute`              | sync       | receipt  | none       |        | yes   |
| `article.restore`   | reversible   | `admin_execute`              | sync       | receipt  | none       |        | yes   |
| `article.duplicate` | irreversible | `admin_execute_irreversible` | sync       | receipt  | none       |        | no    |

### collection (5)

| Op                     | Class                                                                  | Tool                         | Completion | Recovery | Credential | Switch | Built |
| ---------------------- | ---------------------------------------------------------------------- | ---------------------------- | ---------- | -------- | ---------- | ------ | ----- |
| `collection.save`      | reversible; irreversible when the save binds an identity not yet bound | `admin_execute`              | sync       | receipt  | none       |        | yes   |
| `collection.publish`   | reversible                                                             | `admin_execute`              | sync       | receipt  | none       |        | yes   |
| `collection.withdraw`  | reversible                                                             | `admin_execute`              | sync       | receipt  | none       |        | yes   |
| `collection.restore`   | reversible                                                             | `admin_execute`              | sync       | receipt  | none       |        | yes   |
| `collection.duplicate` | irreversible                                                           | `admin_execute_irreversible` | sync       | receipt  | none       |        | no    |

### media (3)

| Op                        | Class                                                            | Tool                         | Completion | Recovery         | Credential | Switch | Built |
| ------------------------- | ---------------------------------------------------------------- | ---------------------------- | ---------- | ---------------- | ---------- | ------ | ----- |
| `media.register_existing` | reversible; irreversible when the media id is not yet registered | `admin_execute`              | sync       | state_idempotent | none       |        | yes   |
| `media.register_upload`   | irreversible                                                     | `admin_execute_irreversible` | async      | state_idempotent | none       |        | no    |
| `media.update_metadata`   | reversible                                                       | `admin_execute`              | sync       | cas_read_back    | none       |        | yes   |

### document (2)

| Op                       | Class      | Tool            | Completion | Recovery         | Credential | Switch | Built |
| ------------------------ | ---------- | --------------- | ---------- | ---------------- | ---------- | ------ | ----- |
| `document.lock_takeover` | reversible | `admin_execute` | sync       | cas_read_back    | none       |        | yes   |
| `document.lock_release`  | reversible | `admin_execute` | sync       | state_idempotent | none       |        | yes   |

### catalog_search (2)

| Op                       | Class      | Tool            | Completion | Recovery         | Credential | Switch | Built |
| ------------------------ | ---------- | --------------- | ---------- | ---------------- | ---------- | ------ | ----- |
| `catalog_search.status`  | read       | `admin_read`    | sync       | state_idempotent | none       |        | no    |
| `catalog_search.rebuild` | reversible | `admin_execute` | sync       | state_idempotent | none       |        | no    |

### ops (17)

| Op                           | Class        | Tool                         | Completion | Recovery         | Credential | Switch | Built |
| ---------------------------- | ------------ | ---------------------------- | ---------- | ---------------- | ---------- | ------ | ----- |
| `ops.invitation.status`      | read         | `admin_read`                 | sync       | state_idempotent | community  |        | no    |
| `ops.invitation.create`      | reversible   | `admin_execute`              | sync       | receipt          | community  |        | no    |
| `ops.invitation.revoke`      | irreversible | `admin_execute_irreversible` | sync       | state_idempotent | community  |        | no    |
| `ops.access.revoke`          | reversible   | `admin_execute`              | sync       | state_idempotent | community  |        | no    |
| `ops.access.restore`         | reversible   | `admin_execute`              | sync       | state_idempotent | community  |        | no    |
| `ops.account.provision`      | irreversible | `admin_execute_irreversible` | sync       | state_idempotent | community  |        | no    |
| `ops.master.candidates`      | read         | `admin_read`                 | sync       | state_idempotent | base       |        | no    |
| `ops.master.status`          | read         | `admin_read`                 | sync       | state_idempotent | base       |        | no    |
| `ops.master.guard`           | read         | `admin_read`                 | sync       | state_idempotent | base       |        | no    |
| `ops.master.attach`          | reversible   | `admin_execute`              | async      | state_idempotent | base       |        | no    |
| `ops.master.attach_existing` | reversible   | `admin_execute`              | async      | state_idempotent | base       |        | no    |
| `ops.master.requeue`         | reversible   | `admin_execute`              | async      | state_idempotent | base       |        | no    |
| `ops.master.set_limit`       | reversible   | `admin_execute`              | async      | state_idempotent | base       |        | no    |
| `ops.master.detach`          | reversible   | `admin_execute`              | sync       | state_idempotent | base       |        | no    |
| `ops.master.erase`           | irreversible | `admin_execute_irreversible` | sync       | state_idempotent | base       |        | no    |
| `ops.upload_gc.plan`         | read         | `admin_read`                 | sync       | state_idempotent | none       |        | no    |
| `ops.upload_gc.run`          | irreversible | `admin_execute_irreversible` | sync       | state_idempotent | none       |        | no    |

### analytics (4)

| Op                            | Class        | Tool                         | Completion | Recovery         | Credential | Switch | Built |
| ----------------------------- | ------------ | ---------------------------- | ---------- | ---------------- | ---------- | ------ | ----- |
| `analytics.ips`               | read         | `admin_sensitive_read`       | sync       | state_idempotent | base       | rawIp  | no    |
| `analytics.definition.save`   | reversible   | `admin_execute`              | sync       | state_idempotent | none       |        | no    |
| `analytics.definition.delete` | irreversible | `admin_execute_irreversible` | sync       | state_idempotent | none       |        | no    |
| `analytics.prune.run`         | irreversible | `admin_execute_irreversible` | async      | state_idempotent | base       |        | no    |

### run (1)

| Op           | Class      | Tool            | Completion | Recovery         | Credential | Switch | Built |
| ------------ | ---------- | --------------- | ---------- | ---------------- | ---------- | ------ | ----- |
| `run.cancel` | reversible | `admin_execute` | sync       | state_idempotent | none       |        | no    |

## Reports on `admin_analytics` (13)

Every report reads on the `base` credential and takes the same range, time zone
and filter arguments. One that is not built reports `NOT_AVAILABLE`.

| Report      | Source                                      | Built |
| ----------- | ------------------------------------------- | ----- |
| `status`    | canonical, config                           | yes   |
| `overview`  | canonical, native block from Umami          | yes   |
| `trend`     | canonical, annotations from Umami           | yes   |
| `breakdown` | canonical; Umami for province, city, device | yes   |
| `compare`   | canonical                                   | yes   |
| `funnel`    | canonical; Umami for a saved funnel         | yes   |
| `realtime`  | canonical, geography from Umami on request  | yes   |
| `sessions`  | canonical; Umami on request or by place     | yes   |
| `session`   | canonical, and Umami from its session id    | yes   |
| `product`   | canonical, business tables                  | yes   |
| `native`    | Umami                                       | yes   |
| `reconcile` | canonical against Umami                     | yes   |
| `traffic`   | hourly snapshot                             | no    |

## Surfaces

Every route of `community/endpoints.ts` and `editorial/endpoints.ts` not listed
here maps to the op of its own name.

| Surface                                                                                          | Covered by, or why not                                              | Note                                              |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------- |
| `endpoint POST /community-moderation/agent-principals-read`                                      | dev-only                                                            | the agent boundary                                |
| `endpoint POST /community-moderation/agent-principal-write`                                      | dev-only                                                            | the agent boundary                                |
| `endpoint POST /community-moderation/agent-principal-revoke`                                     | dev-only                                                            | the agent boundary                                |
| `endpoint POST /community-moderation/agent-delegations-read`                                     | dev-only                                                            | the agent boundary                                |
| `endpoint POST /community-moderation/agent-delegation-create`                                    | dev-only                                                            | the agent boundary                                |
| `endpoint POST /community-moderation/agent-delegation-revoke`                                    | dev-only                                                            | the agent boundary                                |
| `endpoint POST /community-moderation/agent-operations-read`                                      | dev-only                                                            | the agent boundary                                |
| `endpoint POST /community-moderation/agent-operation-read`                                       | dev-only                                                            | the agent boundary                                |
| `endpoint POST /community-moderation/agent-operation-targets`                                    | dev-only                                                            | the agent boundary                                |
| `endpoint POST /community-moderation/agent-operation-approve`                                    | dev-only                                                            | the agent boundary                                |
| `endpoint POST /community-moderation/agent-operation-cancel`                                     | dev-only                                                            | the agent boundary                                |
| `endpoint POST /community-moderation/agent-operation-execute`                                    | dev-only                                                            | the agent boundary                                |
| `endpoint POST /community-moderation/moderate-comments`                                          | `community.moderate-comment`                                        | per-target outcomes need single calls             |
| `endpoint GET /community-moderation/work-submission-media/:revisionId/:itemId/:variant/:editKey` | `admin_view_media`                                                  | video derivatives through files_download          |
| `endpoint GET /community-moderation/article-submission-media/:id`                                | `admin_view_media`                                                  |                                                   |
| `endpoint GET /community-moderation/report-evidence/:id/:evidenceId`                             | `files_download`                                                    | behind the evidence switch                        |
| `endpoint GET /community-moderation/feedback-media/:feedbackId/:itemId/:variant`                 | `admin_view_media`                                                  |                                                   |
| `endpoint GET /community-moderation/comment-media/:commentId/:itemId/:variant`                   | `admin_view_media`                                                  |                                                   |
| `endpoint GET /analytics/status`                                                                 | `admin_analytics`                                                   |                                                   |
| `endpoint GET /analytics/ips`                                                                    | `analytics.ips`                                                     |                                                   |
| `endpoint POST /analytics/exclude-device`                                                        | human-ui                                                            | marks one browser, not an account                 |
| `endpoint POST /editorial/media-upload/start`                                                    | `files_upload`                                                      |                                                   |
| `endpoint POST /editorial/media-upload/status`                                                   | `files_upload`                                                      |                                                   |
| `endpoint POST /editorial/media-upload/chunk/:uploadId/:index`                                   | `files_upload`                                                      |                                                   |
| `endpoint POST /editorial/media-upload/stream/:uploadId/:offset`                                 | `files_upload`                                                      |                                                   |
| `endpoint POST /editorial/media-upload/complete`                                                 | `files_upload`                                                      |                                                   |
| `endpoint POST /editorial/media-ingest/start`                                                    | `files_upload`                                                      |                                                   |
| `endpoint POST /editorial/media-ingest/complete`                                                 | `files_upload`                                                      |                                                   |
| `endpoint POST /editorial/media-ingest/abandon`                                                  | `files_upload`                                                      |                                                   |
| `endpoint POST /editorial/media-ingest/verify`                                                   | `files_upload`                                                      |                                                   |
| `endpoint PUT /editorial/media-ingest/dev-put/:ingestId`                                         | dev-only                                                            | the Development store's stand-in for a signed PUT |
| `endpoint GET /catalog-media-thumbnail`                                                          | `admin_view_media`                                                  |                                                   |
| `endpoint GET /access`                                                                           | human-ui                                                            | what the Admin screen may show this session       |
| `endpoint GET /editorial/preview/:id`                                                            | `admin_get`                                                         | the rendered page through files_render_preview    |
| `endpoint POST /mcp`                                                                             | config                                                              | the transport these tools arrive on               |
| `endpoint GET /mcp`                                                                              | config                                                              | the transport these tools arrive on               |
| `endpoint POST /mcp-control/keys/:id/renew`                                                      | reserved                                                            | key renewal                                       |
| `endpoint POST /agent-connections/consent`                                                       | dev-only                                                            | AI connections                                    |
| `endpoint GET /agent-connections`                                                                | dev-only                                                            | AI connections                                    |
| `endpoint POST /agent-connections/start`                                                         | dev-only                                                            | AI connections                                    |
| `endpoint POST /agent-connections/disconnect`                                                    | dev-only                                                            | AI connections                                    |
| `collection users`                                                                               | reserved                                                            | Admin accounts                                    |
| `collection catalogs`                                                                            | `list.catalogs`, `editorial.save-draft`, `catalog.publish`          |                                                   |
| `collection media`                                                                               | `list.media`, `media.update_metadata`                               |                                                   |
| `collection editorial-identities`                                                                | `editorial.save-draft`                                              |                                                   |
| `collection editorial-approvals`                                                                 | `list.approvals`, `approval.revoke`                                 |                                                   |
| `collection editorial-receipts`                                                                  | `list.receipts`                                                     |                                                   |
| `collection articles`                                                                            | `list.articles`, `editorial.save-article-draft`                     |                                                   |
| `collection article-collections`                                                                 | `list.collections`, `collection.save`                               |                                                   |
| `collection editorial-article-approvals`                                                         | `list.article_approvals`, `approval.revoke`                         |                                                   |
| `collection mcp-audit-events`                                                                    | reserved                                                            | audit records                                     |
| `collection payload-mcp-api-keys`                                                                | reserved                                                            | MCP keys                                          |
| `collection payload-kv`                                                                          | config                                                              | Payload's internal store                          |
| `collection payload-locked-documents`                                                            | `document.lock_takeover`, `document.lock_release`                   |                                                   |
| `collection payload-preferences`                                                                 | human-ui                                                            | Admin screen preferences                          |
| `collection payload-migrations`                                                                  | config                                                              | schema history                                    |
| `global mcp-control`                                                                             | reserved                                                            | pause, threshold and sensitive switches           |
| `view dashboard`                                                                                 | `list.overview`                                                     |                                                   |
| `view analytics`                                                                                 | `admin_analytics`                                                   |                                                   |
| `view analyticsIps`                                                                              | `analytics.ips`                                                     |                                                   |
| `view analyticsBoard`                                                                            | `admin_analytics`                                                   |                                                   |
| `view analyticsStatus`                                                                           | `admin_analytics`                                                   |                                                   |
| `view mcpControl`                                                                                | reserved                                                            | the Owner's control page                          |
| `view editorialWorkflow`                                                                         | `list.review_page`, `editorial.approve-batch`                       |                                                   |
| `view communityModeration`                                                                       | `list.comments`, `community.moderate-comment`                       |                                                   |
| `view communityReports`                                                                          | `list.reports`, `community.decide-report`                           |                                                   |
| `view communityAppeals`                                                                          | `list.appeals`, `community.review-report`                           |                                                   |
| `view communityThreads`                                                                          | `list.threads`, `community.update-thread`                           |                                                   |
| `view communityDirectMessages`                                                                   | `community.read-dm-conversation`                                    |                                                   |
| `view communitySettings`                                                                         | `list.policy`, `community.set-policy`                               |                                                   |
| `view communityContent`                                                                          | `list.works`, `community.moderate-work`                             |                                                   |
| `view communityFeedback`                                                                         | `list.feedback`                                                     |                                                   |
| `view communityHistory`                                                                          | `list.events`                                                       |                                                   |
| `view communityArticleSubmissions`                                                               | `list.article_submissions`, `community.moderate-article-submission` |                                                   |
| `view communityWorkSubmissions`                                                                  | `list.work_submissions`, `community.moderate-work-submission`       |                                                   |
| `view agentConnections`                                                                          | dev-only                                                            | AI connections                                    |
| `view agentConnectionsConsent`                                                                   | dev-only                                                            | AI connections                                    |
| `view communityAccountCapacity`                                                                  | `community.read-account-capacity`, `community.set-account-capacity` |                                                   |
| `view communityPublishingJobs`                                                                   | `list.jobs`, `community.retry-publishing-job`                       |                                                   |
| `view communityAgentOperations`                                                                  | dev-only                                                            | AI operations                                     |
| `page /admin`                                                                                    | `list.overview`                                                     |                                                   |
| `page /admin/collections/catalogs`                                                               | `list.catalogs`                                                     |                                                   |
| `page /admin/collections/media`                                                                  | `list.media`                                                        |                                                   |
| `page /admin/collections/articles`                                                               | `list.articles`                                                     |                                                   |
| `page /admin/collections/article-collections`                                                    | `list.collections`                                                  |                                                   |
| `page /admin/community-moderation/content`                                                       | `list.works`                                                        |                                                   |
| `page /admin/community-moderation/content?tab=featured`                                          | `list.featured`                                                     |                                                   |
| `page /admin/community-moderation/threads`                                                       | `list.threads`                                                      |                                                   |
| `page /admin/community-moderation`                                                               | `list.comments`                                                     |                                                   |
| `page /admin/community-moderation/work-submissions`                                              | `list.work_submissions`                                             |                                                   |
| `page /admin/community-moderation/article-submissions`                                           | `list.article_submissions`                                          |                                                   |
| `page /admin/community-moderation/reports`                                                       | `list.reports`                                                      |                                                   |
| `page /admin/community-moderation/appeals`                                                       | `list.appeals`                                                      |                                                   |
| `page /admin/community-moderation/direct-messages`                                               | `community.read-dm-conversation`                                    |                                                   |
| `page /admin/community-moderation/feedback`                                                      | `list.feedback`                                                     |                                                   |
| `page /admin/community-moderation/content?tab=users`                                             | `list.users`                                                        |                                                   |
| `page /admin/community-moderation/account-capacity`                                              | `community.read-account-capacity`                                   |                                                   |
| `page /admin/analytics`                                                                          | `admin_analytics`                                                   |                                                   |
| `page /admin/analytics/board`                                                                    | `admin_analytics`                                                   |                                                   |
| `page /admin/analytics/ips`                                                                      | `analytics.ips`                                                     |                                                   |
| `page /admin/analytics/status`                                                                   | `admin_analytics`                                                   |                                                   |
| `page /admin/editorial-workflow`                                                                 | `list.review_page`                                                  |                                                   |
| `page /admin/collections/editorial-approvals`                                                    | `list.approvals`                                                    |                                                   |
| `page /admin/collections/editorial-article-approvals`                                            | `list.article_approvals`                                            |                                                   |
| `page /admin/community-moderation/publishing-jobs`                                               | `list.jobs`                                                         |                                                   |
| `page /admin/community-moderation/agent-operations`                                              | dev-only                                                            | AI operations                                     |
| `page /admin/agent-connections`                                                                  | dev-only                                                            | AI connections                                    |
| `page /admin/community-moderation/history`                                                       | `list.events`                                                       |                                                   |
| `page /admin/collections/editorial-receipts`                                                     | `list.receipts`                                                     |                                                   |
| `page /admin/collections/mcp-audit-events`                                                       | reserved                                                            | audit records                                     |
| `page /admin/community-moderation/settings`                                                      | `list.policy`, `list.work_settings`                                 |                                                   |
| `page /admin/collections/users`                                                                  | reserved                                                            | Admin accounts                                    |
| `page /admin/collections/payload-mcp-api-keys`                                                   | reserved                                                            | MCP keys                                          |
| `page /admin/mcp-control`                                                                        | reserved                                                            | the Owner's control page                          |
| `command catalog-master candidates`                                                              | `ops.master.candidates`                                             |                                                   |
| `command catalog-master manifest`                                                                | `files_master_plan`                                                 |                                                   |
| `command catalog-master attach`                                                                  | `ops.master.attach`, `ops.master.attach_existing`                   | new bytes through files_master_attach             |
| `command catalog-master attach-batch`                                                            | `files_master_attach`                                               |                                                   |
| `command catalog-master status`                                                                  | `ops.master.status`                                                 |                                                   |
| `command catalog-master requeue`                                                                 | `ops.master.requeue`                                                |                                                   |
| `command catalog-master set-limit`                                                               | `ops.master.set_limit`                                              |                                                   |
| `command catalog-master detach`                                                                  | `ops.master.detach`                                                 |                                                   |
| `command catalog-master erase`                                                                   | `ops.master.erase`                                                  |                                                   |
| `command catalog-master guard`                                                                   | `ops.master.guard`                                                  |                                                   |
| `command invitations create`                                                                     | `ops.invitation.create`                                             |                                                   |
| `command invitations status`                                                                     | `ops.invitation.status`                                             |                                                   |
| `command invitations revoke`                                                                     | `ops.invitation.revoke`                                             |                                                   |
| `command invitations revoke-access`                                                              | `ops.access.revoke`                                                 |                                                   |
| `command invitations restore-access`                                                             | `ops.access.restore`                                                |                                                   |
| `script scripts/provision-password-account.mjs`                                                  | `ops.account.provision`                                             | through files_account_provision                   |
| `script scripts/analytics/bootstrap-umami.mjs`                                                   | config                                                              | deployment                                        |
| `script scripts/analytics/build-umami-image.mjs`                                                 | config                                                              | deployment                                        |
| `script scripts/analytics/common.mjs`                                                            | config                                                              | a library of these scripts                        |
| `script scripts/analytics/export-canonical.mjs`                                                  | `files_download`                                                    |                                                   |
| `script scripts/analytics/export-umami-runtime.mjs`                                              | config                                                              | deployment                                        |
| `script scripts/analytics/generate-admin-shell-assets.mjs`                                       | config                                                              | build                                             |
| `script scripts/analytics/prune-umami.mjs`                                                       | `analytics.prune.run`                                               |                                                   |
| `script scripts/analytics/render-client-ip-trust.mjs`                                            | config                                                              | deployment                                        |
| `script scripts/analytics/rotate-umami-password.mjs`                                             | config                                                              | credentials                                       |
| `script scripts/analytics/runtime-policy.mjs`                                                    | config                                                              | a library of these scripts                        |
| `script scripts/analytics/seed-synthetic-umami.mjs`                                              | dev-only                                                            | synthetic data                                    |
| `script scripts/analytics/summarize-traffic.mjs`                                                 | `admin_analytics`                                                   |                                                   |
| `cli catalog-importer catalog-import:validate-xlsx`                                              | `files_import`                                                      |                                                   |
| `cli catalog-importer p5:api-audit`                                                              | `files_import`                                                      |                                                   |
| `cli catalog-importer p5:apply-validation`                                                       | `files_import`                                                      |                                                   |
| `cli catalog-importer p5:validate`                                                               | `files_import`                                                      |                                                   |
| `cli pilot prepare`                                                                              | `files_import`                                                      |                                                   |
| `cli pilot apply`                                                                                | `files_import`                                                      |                                                   |
| `cli pilot media`                                                                                | `files_import`                                                      |                                                   |
| `cli admin cms:migrate`                                                                          | config                                                              | migrations                                        |
| `cli admin cms:migrate:create`                                                                   | config                                                              | migrations                                        |
| `cli admin cms:types`                                                                            | config                                                              | build                                             |
| `cli admin cms:importmap`                                                                        | config                                                              | build                                             |
| `cli admin cms:legacy`                                                                           | `files_import`                                                      |                                                   |
| `cli admin cms:upload-gc`                                                                        | `ops.upload_gc.plan`, `ops.upload_gc.run`                           |                                                   |
