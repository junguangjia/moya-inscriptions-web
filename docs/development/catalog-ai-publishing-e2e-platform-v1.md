# Catalog draft delivery

## Current implementation boundary

The source now implements durable private draft intents, a real authenticated
recipe-policy/readiness boundary, the complete CMS A/private-B processing union,
exact rendition/generation pins, Owner early-copy requests and Native CAS
release. These source paths are under isolated split-database validation. The
earlier CMS foundation check is not end-to-end acceptance, and no Production
DDL, grants, credentials or content changes are included.

The task's `9ab9dc3` base contains the main-branch native simple-upload path. It
does not contain the separately owned Production curation integration's
`internal/editorial/upload.ts`, `media/resumable-upload.ts` or resumable client,
and its storage adapter differs. These fixtures validate registered media in
this checkout; they do not establish compatibility with the actual Production
resumable/stream upload implementation or prove reuse of the existing batch.
That integration must come from the uploader owner's reviewed source change;
this slice does not copy another worktree's uncommitted implementation.

An intent created without a configured policy connection has a null recipe hash,
`NOT_CONFIGURED` readiness and no public-copy authorization. Such an intent does
not enter the private processing view. A later implementation must create a new
immutable, policy-pinned prepare; it must not fill in a made-up hash, mutate the
old snapshot or infer readiness from a generic operator URL. When the real
policy is connected, prepare stores the exact canonical manifest and its SHA-256
and reports `PENDING`, which is not readiness. An exact receipt replay performs
no repeated policy request. The policy includes all four candidate roles, actual
recipe parameters, conditional `plannedStillSize` geometry, its dependencies and
full's comparison-only bound. Full/motion output is excluded. The three
mandatory role digests alone are not this policy hash.

All routes below are normal authenticated Payload `POST /api/editorial/<name>`
endpoints. Payload's existing Owner and scoped automation identities determine
the actor. Strict internal schemas reject actor IDs, object keys, readiness
booleans and extra fields supplied by callers.

| Name                       | Current result                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `prepare-catalog-delivery` | Current draft revision/fingerprint CAS; persist B and A baseline; no object read or copy         |
| `read-catalog-delivery`    | Scoped phase/version/hash/count only, without private content or source keys                     |
| `request-catalog-release`  | Owner-only, exact manifest/version/current A/B checks, then truthful 503                         |
| `release-catalog-delivery` | Fresh whole-set rendition/generation proof; approval and A/B CAS; Native publication transaction |
| `cancel-catalog-delivery`  | Owner or the scoped preparer; version CAS and durable cancellation tombstone                     |

## Persistence and concurrency

Migration `20261020_160000_catalog_delivery_intents` creates private intent and
append-only receipt tables. Each full snapshot and manifest remains independent
of Payload's 100-version retention limit. Equal source hashes do not merge
logical media IDs. Manifest order, dimensions, alt text, representative choice,
rights, source hash and every logical media identity participate in the hash.

The document advisory lock is shared with Native edits, restoration, publication
and withdrawal. Endpoint mutations first lock their idempotency receipt, then
the document. They compare current Native draft B and primary A before any
future release. Old receipt replay reports the intent's current tombstone rather
than reviving an old preparation. A new draft or restore supersedes active
intents; withdrawal also tombstones an intent that was released. Editing a draft
does not invalidate the still-published A's released reference. Expiry is
persisted under the same lock when an intent is read or used. Lifecycle
entrypoints require their own transaction. An expired command commits only its
expiry tombstone before returning `CATALOG_DELIVERY_EXPIRED`; it writes no
command receipt. All other errors roll back normally. An already-open caller
transaction is refused so a later outer rollback cannot silently undo this
outcome.

New `editorial/` originals cannot be directly published through Owner
Admin/REST/MCP or approved automation. The common Native collection hook rejects
publication unless the server holds the exact delivery proof for the current
Native transaction. There is no Development bypass. Text-only and existing
qualified legacy behavior retain their native path.

The runtime grant script permits insert/select on the two sidecar tables and
updates only lifecycle columns. Snapshot, full manifest, baseline and recipe
columns cannot be rewritten by the runtime. No delete or ledger-update grant is
added. `catalog_delivery_prepare_media` is separate from public `catalog_media`;
the optional Development reader grant names only that private view, creates no
role and grants no future objects. It requires an explicit approved private
reader plus the public and Backend reader deny-role identities. Equal targets or
either direction of effective inheritance/SET reachability are refused; ordinary
access to public views is not used to guess a role's purpose. No Production
grant is part of this source change.

## Processing, copying and current public reads

Private prepare permits private rendering only. A separate explicit Owner
request-release must authorize the exact public-copy set. Known URLs can be
readable after that authorization and before the DTO switches to B. Complete
real public-copy readiness is required before Native CAS B; counts or job
success alone are insufficient. Processing refs, copy permission and current
published DTO refs remain separate.

CMS document leases serialize requested B copying and its App commit with Native
cancellation, edits, withdrawal and publication. The existing App queue, desired
sequence and asset leases still apply. The exact captured B intent, version,
manifest, policy and rendition IDs are rechecked; no `full` or unrelated ready
recipe becomes copy-eligible. Existing published A without an intent keeps
live-public pre-copy/commit checks and withdrawal/drain semantics; it does not
claim the stronger document-lease boundary when no document ID exists.

A private reader that is absent is not a complete empty private snapshot. The
CMS roles share one MVCC snapshot; the App applies A plus active B once under a
durable observation watermark. An older empty round cannot tombstone a newer
intent. Public references and private processing references are separate, and
status reads never fetch original bytes. A fully current ready render completes
before calling the source reader again. Immutable pins retain committed blobs
through recipe replacement; current published A retains its approved prior pins
until B actually becomes Native public content. Public URL selection always
checks live CMS publication and App publication facts rather than assuming CMS
views exist in the App database.

The Backend and worker currently each need an explicitly configured, separately
approved private metadata read identity for readiness/publication fencing. This
is not the earlier worker-only configuration proposal: Production identities,
grants and injection into either process remain NOT_APPROVED. The COS source
identity remains worker-only and cannot fall back to either metadata role or the
public signer. The optional namespace is `CATALOG_PREPARE_DATABASE_URL` plus
`CATALOG_PREPARE_DATABASE_SSL_CA_FILE`; each process uses one bounded pool.

Cancellation commits a monotonic tombstone after the Native document fence. It
prevents new activation; previously authorized known URLs require the existing
origin withdrawal and edge-purge lane to drain. The response does not promise
instantaneous erasure or cross-database/COS/edge atomicity.

## Validation

The new CMS test file has independently runnable schema/registration/guard tests
and task-owned synthetic PostgreSQL scenarios for real authenticated endpoints,
durability after version pruning, cancellation/edit serialization, expiry,
withdrawal and Native publication guards. PostgreSQL scenarios require the
existing CMS verification harness and are not acceptance when skipped. The local
file-read regression uses an explicitly seeded historical publication after
verifying that new publication is refused; it is not a production bypass.

Source preparation, hashing and these status operations perform no COS/EdgeOne
request, original-byte download or hidden media readback. The existing dedicated
source configuration uses only `CATALOG_SOURCE_COS_*`; public signer and worker
publication identities remain separate. Explicit Development local media reads
are retained; Production does not silently select that local source.

The PostgreSQL 16.15 task-local CMS foundation run exercised 37 cases with zero
skips, including actual authenticated endpoints, non-null real recipe policy,
two independent Native media IDs with equal source SHA, immutable replay, Native
publication guards and named reader ACLs. This is not the complete
split-database/render/copy/release test. The non-empty minimum-reader and full
split-database scenarios remain separate necessary acceptance.
