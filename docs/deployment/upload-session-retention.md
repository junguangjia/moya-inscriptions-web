# Editorial upload buffer retention

The resumable relay stores private, temporary chunks beside `CMS_MEDIA_DIR` in
`editorial-upload-sessions`. Canonical media remains in its configured media
store. This maintenance command never deletes media, COS objects or database
rows. The existing limits remain: sessions expire after 24 hours; a successful
completion retains its replay bytes until the earlier of session expiry and 15
minutes after the immutable completion checkpoint. Quotas are unchanged.

Request-driven cleanup still runs on upload start. The separate five-minute
timer ensures cleanup also runs when no new upload starts. A run considers at
most 520 source entries, reclaims at most eight sessions and 256 MiB, stops work
after 45 seconds, and has a 50-second process deadline plus a 60-second systemd
limit. Delayed or interrupted runs leave their remainder for the next run.

## Independent maintenance package

Compile the three `apps/admin/src/operations/upload-session-gc*.ts` files to
JavaScript off host with the repository's locked TypeScript compiler, ES
modules, rewritten relative `.ts` imports, and no source/declaration maps. Trace
only the existing locked production dependency closure of
`@moya/contracts/internal/editorial` and `@moya/catalog-postgres` (including pg,
zod and the latter's compiled workspace imports). The production service runs
these compiled JavaScript files with Node 24. Do not ship a TypeScript compiler,
Payload, Next, the Admin application, dev dependencies, installation caches or
credentials. There is no production compilation or installation step. Native
Node 24 type stripping remains a local source-test convenience only.

```sh
node apps/admin/src/operations/upload-session-gc-cli.js
node apps/admin/src/operations/upload-session-gc-cli.js --execute
```

The first command plans only. It does not create a quarantine or modify buffers.
Both commands take database advisory locks to observe a stable allocation view.
Only `--execute` permits expiry-authorized buffer deletion. Output contains
counts and fixed categories, never session identifiers, manifests, raw errors or
configuration. An error does not imply earlier eligible sessions were retained;
repeat safely after resolving the category.

Install the reviewed package independently of the current Admin release. Select
its verified source milestone through the normal main/tag gate. The service and
timer templates are installation examples, not evidence of activation. Freeze
the actual package path, UID, writable paths and environment binding in the
private installation plan. A source update to Admin's opportunistic cleanup is
for its next authorized release; the standalone timer is compatible with the
older allocator and does not require an Admin/API feature upgrade or overlay.

## Database, identity and filesystem boundaries

Use a dedicated root-owned 0600 `upload-session-gc.env`, based on the checked-in
example, with only `CMS_DATABASE_URL`, optional `CMS_DATABASE_SSL_CA_FILE`, and
`CMS_MEDIA_DIR`. It must address the **same PostgreSQL database** as Admin so
advisory locks coordinate. A maintenance role needs CONNECT and the existing
advisory-lock functions; it needs no business-table access or write grants.
Verified TLS parsing is reused from the current PostgreSQL adapter. There is no
ambient APP/DATABASE_URL or cloud-credential fallback.

Run as the same UID that owns the sessions (`yoyi-admin` in the templates).
Session and quarantine directories must be canonical, owned by this UID and
0700; files must be regular, single-link, same-owner 0600 files with bounded
sizes. Unknown names, malformed metadata, symlinks, foreign owners and changed
file identities refuse deletion. Keep the parent protected from other writers.
The source and sibling quarantine must share a filesystem. A controlled
installer may extract only the approved CMS database URL, optional CA path and
media directory from the existing protected Admin configuration into this
dedicated 0600 profile; never print or publish those values.

All collectors acquire the existing transaction advisory locks in order:
`moya-editorial:media-upload-allocation`, then
`moya-editorial:media-upload-media:<mediaId>`, then
`moya-editorial:media-upload-session:<uploadId>`. Retention and files are
checked again under these locks. Upload/chunk/completion code retains its
current locks.

## Interruption recovery

An eligible directory is atomically renamed from the allocator root into its
private sibling `editorial-upload-sessions-gc`. No new filename is introduced
inside the old allocator's root. After the durable rename, a private bounded
intent records its manifest, retention decision and directory identity before
payload deletion. The reaper validates the complete remainder, removes
recognized chunks and metadata, and removes the intent last. A killed deletion
can resume from that intent even after `manifest.json` was deleted. An empty
quarantined directory is removable without inventing a new session. A failure
before intent publication keeps the original manifest/checkpoint for the next
fresh check.

Never manually empty a nonempty directory with missing/malformed authorization
metadata. In particular, an already-damaged legacy source directory without a
valid manifest has no trusted recovery intent and remains refused for explicit
operator investigation. Do not delete active sessions by age-only filesystem
commands, and do not archive temporary upload chunks as business data.

Focused acceptance is `tests/cms/resumable-upload-gc.test.ts`, including actual
filesystem interruption recovery, native Node startup and real PostgreSQL lock
contention. Existing resumable-upload integration coverage preserves upload and
completion replay. Applicable cumulative repository validation and independent
review remain required before delivery.

## Remaining risk while an older Admin is running

The independent timer does **not** replace the older Admin's request-driven
`removeExpired` implementation. That older path deletes files in place and can
be killed after deleting `manifest.json` but before removing all chunks or the
session directory. Such a legacy source directory has no durable GC intent. The
new CLI refuses it; it cannot infer expiry or safely restore its manifest from
filenames and chunk ages. Preserve the remainder for a separately reviewed,
metadata-backed repair rather than deleting or inventing authorization.

To remove this remaining failure path, use a separately reviewed repackaging of
the exact currently deployed Admin version with only the shared GC integration,
or an equally strict approved replacement. A new Main Admin application is not a
substitute for that current-version plan. Until then, the timer solves idle
expiry accumulation but does not establish that every legacy cleanup failure
mode is fixed.

## Current task activation hold

This task currently has an explicit Owner KEEP covering the parent application
state tree. Upload-GC execution would rename or unlink buffers in that protected
tree, so do not enable its execute command or timer under the present scope.
Source, offline tests and read-only plans remain deliverable. Independent
maintenance activation is allowed only when it changes no protected object; this
GC requires a later explicit scope change before execution. Do not use the
maintenance package to bypass a protected-state hold or upgrade the Admin.
