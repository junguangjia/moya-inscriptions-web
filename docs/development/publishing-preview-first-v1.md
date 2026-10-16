# Preview-first publishing

Task: [#280](https://github.com/junguangjia/moya-inscriptions-web/issues/280).

Static work photos use the existing authenticated upload, verified private
source, sandbox renderer, PostgreSQL queue and rendition model in two phases:

1. `process_item` produces and verifies `thumb`, `cover` and `display`. Its
   transaction records usable previews and enqueues the base high-resolution
   continuation atomically.
2. A background `derive_edit` produces `full` and, when its existing geometry
   requires it, `viewer`. The same recipes, quality, privacy and integrity rules
   apply. Committed previews remain usable during this work or its failure.

Available preview jobs have priority over full-only background jobs. An HD job
may also wait for uploading or processing siblings in the same holder, for at
most 30 seconds from its enqueue time. Running jobs are not preempted. Existing
Live Photo and Catalog rendering behavior is unchanged.

Static submission readiness requires verified previews for the chosen edit and
cover crop. Full and viewer renditions remain wanted and retained; they are
added to delivery only after verified storage and a committed rendition record.
Publication, moderation and private-media access rules are unchanged.

The remaining initial HD allowance stays reserved after preview commit. Full
commit or terminal failure, expiry or abandonment releases it. An explicit retry
reuses stopped jobs and reacquires the residual allowance under the existing
capacity check. Edited-image accounting keeps its existing semantics.

## Author progress and retry

Existing item, upload, session, draft and receipt response shapes are unchanged.
New clients use a separate authenticated response:

- `GET /v1/community/publishing/items/:itemId/progress`
- `POST /v1/community/publishing/items/:itemId/processing/retry`

The existing same-origin Community relay carries both operations. The retry uses
the existing request identity, receipt, ownership and audit boundary. It never
resets or retransmits source components, registers another media item or
publishes content. Operator-abandoned work stays stopped.

The progress envelope contains the unchanged item plus preview status,
high-resolution status and the actual count of committed rendition records. That
count can include retained edited frames; it is not a fixed set of five sizes or
an estimate of elapsed work. Source byte progress and server processing are
displayed separately. Previews can unblock editing while high resolution
continues; an unavailable progress response never implies HD completion.

Unedited legacy PNGs remain a no-op. Their supported edited frames expose and
retry separate HD work without changing the retained PNG source.

## Verification boundaries

Automated coverage includes legacy contract compatibility, authenticated
progress, preview readiness before HD, durable continuation, priority, retry,
lease expiry, cancellation, retained HD, quota accounting and existing UI
surfaces. Production verification must preserve existing item/source/rendition,
reference, session and publication identities.

A matched-source worker replay can compare source reads, sandbox processing,
output checks and private storage writes without creating business records.
Report preview-ready and HD-complete times separately. Already-complete records
must not be reset to manufacture a new upload measurement. Browser transfer,
acknowledgement and real queue/transaction latency remain separate evidence.
