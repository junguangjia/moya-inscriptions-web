# Reusable Catalog publication workflow — implementation boundary

This extends the existing Editorial client. Codex, Claude Code and other callers
must use the same checked implementation and server authority. An AI-generated
`confirmed: true` value never grants Owner authorization.

## Implemented client

`identity.mjs` validates a private frozen manifest, binding authenticated
account, environment, origin, selected Catalog scope, content and ordered image
identity. Session renewal does not change identity. Reading order and
representative-image selection are separate. Credentials and arbitrary
instruction fields are rejected.

`checkpoint.mjs` strictly validates phase/action history on reload.
`checkpoint-store.mjs` reuses the existing private JSON reader and atomic writer
with copied serialized snapshots, an exclusive owned lock and directory fsync.
Replaced locks are preserved; stale locks are never automatically stolen. Phase
and transport journals share admission/ownership guards. Closing stops new work,
drains in-flight HTTP and saves final accounting before releasing the lock,
including when a caller did not await its request.

`workflow.mjs` composes draft operations and separately models a fake-only Owner
CAS. `local-native-adapter.mjs` is a thin bridge from the draft engine to the
actual existing `stageMediaUpload` client and Native request/response shapes.
Its executable boundary is an explicitly identified synthetic HTTP fixture on
127.0.0.1, a development manifest and synthetic-only authentication. Matching
fixture response headers are mandatory. No real credential is loaded. Fake and
local-http checkpoints/journals cannot adopt each other's results.

Unknown saves recover using the existing read-only Native editorial receipt
collection. A unique receipt must match actor, operation, deduplication key,
server request fingerprint, completed status, Catalog, revision and result
fingerprint, alongside fresh draft content. Identical content at revision plus
one cannot attribute a save. Missing/mismatching receipts stay unknown without a
second save POST. The receipt fingerprint uses the existing server's ordered
JSON algorithm, not the canonical manifest hash.

Actual Native records have no rightsHold/explicitlyHidden/withdrawn fields.
Protections come from trusted frozen input and checkpoints. A previously
observed published main record becoming draft latches withdrawal; initial draft
or the private editable version alone cannot establish a withdrawal.

Reuse-only B updates use a separate `saveRegisteredDraft` port. Fresh registered
Media proofs are required; this port never calls image staging or reads a local
image. It preserves the original action key and frozen CAS when resuming after
the phase action was persisted but before the save journal existed. Lost save
responses still require exact server-receipt attribution. Adapter-observed
protections are OR-latched into the engine before each phase save, including
withdrawal observed inside a failed save, so a cloned phase snapshot cannot
erase them.

`registered-media-proof.mjs` currently consumes normalized synthetic historical
evidence and a current metadata result/receipt supplied by the controlled
adapter. It binds environment/account, historical file hashes, Catalog/Source/
Media identities, Native ID, byte hash/size/dimensions and the current response
digest. Cross-environment evidence, protections or missing objectKey refuse the
import. This pure helper is not a standalone wire/journal verifier; the adapter
owns the actual fresh GET and durable receipt. Persisted proof retains a
provenance digest, not a complete replayable archive of its source documents.
The historical converter and its provenance audit are now connected to the
explicit Production entry described below. Historical Production evidence cannot
be relabeled as a fresh isolated-environment result.

## CLI boundary

The credential-free local inspection commands are freeze and inspect:

```sh
mise exec -- node scripts/editorial/catalog-workflow/cli.mjs freeze --manifest /absolute/private/manifest.json --state-dir /absolute/private/state
mise exec -- node scripts/editorial/catalog-workflow/cli.mjs inspect --manifest /absolute/private/manifest.json --state-dir /absolute/private/state
```

Input and state files must be private. These commands make zero network
requests. `run`, `upload`, `publish` and `withdraw` without an explicit
authority and credential-file argument reject before file/config reads with
`LIVE_ADAPTER_NOT_BOUND`. Fully bound calls use the separate Production HTTPS
entry below. The synthetic local HTTP adapter remains a test integration.

## Publication boundary

The Native-publish-before-preparation proposal is superseded. Public text reads
the Native main published view: publishing B immediately replaces A's text,
citations and ordering. Keeping only A's images does not retain complete A.

The required platform sequence is:

1. Save B privately through existing Editorial save-draft while public A
   remains.
2. Freeze B's revision/fingerprint and Media identity, hashes, order and cover.
   Reuse-only entries never invoke upload or verification-through-staging.
3. Prepare exact B through a platform-owned durable private intent, including
   its complete required rendition/public-copy group, while main A stays intact.
4. After exact readiness and authority, call the actual platform release
   contract with frozen intent/state/revision/fingerprint binding. Persist
   pending before dispatch and reconcile the original target on uncertainty.
   Never select a new revision or replay a non-idempotent PATCH. Direct Owner
   publish PATCH must not bypass the preparation guard. The guard admits a
   direct publish only when every `editorial/` image of B already has its
   complete, current-recipe and published rendition set, as the Backend reports
   from its own App facts over the existing operator boundary (for example a
   text-only edit of a live record). Any image without that set, or an
   unconnected Backend, still answers 409
   `CATALOG_DELIVERY_PREPARATION_REQUIRED`. Missing/unimplemented/503 release is
   HOLD.
5. Verify anonymous Catalog API and advertised image delivery independently.
   Partial images, signed-source fallback or queue succeeded does not suffice.
6. Hide/withdrawal fences A and B, stale processing and pending publication.
   Native, list/detail/search, origin denial and actual warmed-edge purge/denial
   are separate observations. Prior success cannot revive a protected entry.

The platform owner owns server prepare/status/release, readiness, exact CAS,
worker, public delivery and cloud changes. This client adds no server route,
database schema, public contract or cloud permission. Its fake Native action
helper accepts only labeled fake preparation evidence; all test results retain
`liveE2E: false`. Local transport success is not
Payload/PostgreSQL/worker/public acceptance and grants no publication authority.

## Transfer accounting

`transfer-budget.mjs` binds explicit request/upload/download limits to the
scope. `local-native-http.mjs` durably reserves every
handshake/authentication/metadata/
start/status/chunk/stream/complete/save/receipt/release request before dispatch,
including internal protocol retries. The synthetic fixture matches each request
hash to its exact PENDING ledger row and body-hash/byte envelope on disk.

Upload counters advance on successful Node write callbacks; response counters
retain measured partial and oversized bodies. Unknown costs retain at least
their full envelope, even after connection-close evidence frees a concurrency
slot. Unknown cannot become an unproved zero-byte failure. Overrun blocks the
next admission. Byte counters are measured HTTP bodies, not complete network
wire or billing attribution. Metadata stays fresh and consumes budget when an
existing successful binary proof is reused. The ledger cannot authorize replay.

The existing protocol owns fixed 128KiB chunks, maximum 40MiB/320 chunks and its
finite attempts/concurrency. Stream requires the actual version-1 response
header. The integration does not enlarge those ceilings. Original reuse binds
source/output hashes, Catalog/Source/Media identity, bytes, dimensions and
proof; matching counts alone is insufficient. Stored-object COS
checksum/same-region verification remains unbound. Unknown integrity capability
blocks unless a full read is explicitly budgeted. Visual sampling is separate
from integrity proof. These local tests do not establish Production cost
control.

## Ownership and validation

Root owns new `scripts/editorial/catalog-workflow/` and this document. A precise
assignment recorded before writing additionally permits the new files
`scripts/editorial/resumable-upload.mjs`,
`scripts/editorial/native-stream-fetch.mjs`,
`packages/contracts/src/internal/editorial/upload.ts` and append-only upload
exports in the existing editorial index. Resumable client/schema were copied
from individually hash-verified intake sources. Native stream transport adds one
observational request-close callback, which cannot authorize transmission, retry
or publication. Existing batch/curation adapters and server source remain
unchanged by this slice. Do not wholesale-copy another dirty worktree.

A subsequent explicit r1 handoff additionally permits the exact single-file
`packages/contracts/src/internal/editorial/catalog-delivery.ts` copy and its
additive editorial-index exports. Its frozen SHA256 is
`bf22d3b4258f77ad62dd5d4a2bcb3d7a8de6606d6ec194e2d5bf84aa2850a4ea`. The handoff
is SOURCE_CONTRACT_FROZEN_HTTP_NOT_VERIFIED; origin/port were null. Copying and
compiling this contract does not establish a callable platform server or bind a
Production CLI. No platform implementation is copied here.

Run focused tests after building contracts:

```sh
mise exec -- pnpm --filter @moya/contracts build
mise exec -- node --test scripts/editorial/catalog-workflow/*.test.mjs
```

The real loopback fixture validates Native schemas, byte hashes and durable
per-request admission. It uses padded synthetic PNG bytes and does not run the
Payload image decoder. Parallel chunks recover a lost acknowledgment by status
without repeating the accepted chunk; negotiated stream writes are exercised.
Three independent Node processes demonstrate abort/clean-shutdown continuation,
then a zero-binary rerun. This does not claim SIGKILL recovery, stale-lock
reclamation, server-restart recovery or real CMS/App database acceptance. The
release fixture deliberately returns 503 and never publishes Native content.

Existing 452 images are not retransmitted or fully read back. Existing IDs,
accepted framing, right-to-left order, image relationships, cover intent and
held/withdrawn states remain protected. Manual source-reader setup does not
authorize an agent to read/inject new credentials or restart services.

## Historical conversion and the isolated Payload window

`historical-proof-converter.mjs` reads eight explicitly pinned small JSON files,
not the images they reference. It checks raw bytes/SHA, joins every original
record/asset/Native media ID, preserves gallery order and cover, and retains the
old target algorithm separately from the current role-and-Catalog scope hash.
The final metadata run is labeled as such, never invented as an upload run.
DESK-003 is 好太王碑/id1/14 images: uploaded draft4, publication intent5 and
confirmed withdrawal7 remain separate. RUB-004 is 好太王碑拓片影像/id60/16
images and retains its public-use rights hold. All converted rows require fresh
Native metadata; 438 unknown object keys remain null/HOLD. The 14 observed keys
remain historical observations. No relationship-sidecar or training-label
registration is inferred from the conversion.

Imported proofs now retain the converter identity, raw source references, exact
entry and target provenance, safe Native projection and response receipt. Reload
re-reads and regenerates the original small JSON bundle once per locked run,
then checks each entry and its unique owned transport/budget row. New direct
upload proofs also require their completed upload receipt. Audit stripping or
changing the kind cannot fall back to a bare digest. Legacy v1 four-field upload
proofs only validate their original construction, without claiming a new wire
audit. Current metadata is still fetched before reuse.

`payload-isolated-session.mjs` and `payload-isolated-cli.mjs` prepare the
separate r2 bridge boundary. They require one actual platform-owned development
fixture, its expiring ready binding, existing application JWT provider and exact
Native B input. The client verifies `/api/users/me`, reads Native draft/main and
every selected media metadata record, and uses the same durable
96-request/4MiB-request/ 2MiB-response transport budget for all calls. There is
no fake handshake, editorial-receipts query, original-image GET, binary upload
or Production CLI binding. The provider reads only the specifically bound
private fixture session during the jointly opened window and never writes it
into journals/reports.

The five r1 actions have separate deterministic keys, original schema-ordered
body text/hashes, durable pending attempts and bounded same-key recovery. Known
intents are read before uncertain mutation replay; read alone does not attribute
a command. A replay returns the intent's current state, including terminal
states. Expiry/503/unknown results stay HOLD/UNKNOWN, with no direct Native
publish fallback. Cancel only applies to pending delivery, not published
withdrawal. Release responses retain B's frozen revision; fresh Native B+1
publication and anonymous delivery remain separate observations. Prior Native
acceptance is invalidated before a fresh check.

Prepare the executable command before the platform opens its short window:

```sh
/opt/homebrew/bin/mise exec -- node scripts/editorial/catalog-workflow/payload-isolated-cli.mjs \
  --ready /absolute/platform-window/ready.json \
  --input /absolute/platform-window/client-input.json \
  --checkpoint /absolute/client-private-checkpoint \
  --action prepare \
  --report /absolute/new-prepare-report.json
```

Repeat with `read`, `request`, `release` or `cancel` using the same
binding/input/ checkpoint and a new report path. The platform alone drives its
worker and owns server/PG lifecycle. `--help` reads no fixture files. A Node
HTTP protocol test is not Payload/PG acceptance; a ready file or zero-request
bridge alone is not an actual HTTP integration result.

## Explicit Production CMS entry

The Production implementation is separate from the synthetic/loopback entry. The
historical isolated phase 14 source is retained privately as 26 exact files; its
successful execution is not Production deployment evidence. The Production
command accepts one selected existing Catalog at a time, allowing an approved
batch to invoke independently scoped checkpoints without duplicating its Native
IDs. It does not create Catalogs, accounts, credentials, database grants or COS
policies. The current 62-record intake already has Native Catalog IDs.

```sh
/opt/homebrew/bin/mise exec -- node scripts/editorial/catalog-workflow/cli.mjs run \
  --manifest /absolute/private/selected-manifest.json \
  --input /absolute/private/selected-input.json \
  --authority /absolute/private/confirmed-execution-authority.json \
  --credential-file /absolute/protected/existing-cms-credential.json \
  --state-dir /absolute/private/selected-checkpoint
```

This is the invocation shape, not permission to execute against Production. The
checked private authority must bind `kind: production-native`, the canonical
HTTPS origin, actor/role, selected manifest SHA, complete input SHA (including
expected Native revision/fingerprint and conversion references), Catalog
identity and positive existing Native ID, allowed commands, expiry, byte/request
caps, the exact delivery contract SHA, a deployed server reference and an Owner
authorization reference hash. `run` additionally requires explicit `publish`
capability when its selected disposition is publish, and explicit `upload`
capability when it could stage binary media. It grants neither capability
implicitly. Draft disposition stops after draft verification. `credentialSaved`,
`permissionsConfirmed` and `serverDeploymentConfirmed` must each have actual
supporting confirmation. An absent/false confirmation rejects before the
credential provider is read. Do not manufacture these confirmations from an
isolated test or an old scope. No actual confirmed Production authority or
credential is supplied by the code.

The separately protected credential file has `version`, `origin`, `actorId`,
`scheme` (`JWT` or `users API-Key`) and `credential`. Only the controlled
program reads that exact saved file. Credentials never enter manifests,
journals, reports or errors. Actual `GET /api/users/me` must verify the account
and role. Owner's effective Catalog scope follows the server's Owner role;
automation requires explicit Native Catalog scope. A changed credential must be
verified again before business requests. Token replacement cannot change the
bound target, actor, role, selected records or authority. The client needs no
DB/COS credentials. Deployment of the matching server endpoints is a separate
fact.

The selected input has `version: 1`, `expectedNative` (id/revision/fingerprint/
contentSha256), `controlled` (the existing validated content/media mapping) and
`conversions` (mediaId/reference pairs from the historical converter). All
documents must be private owned files; the checkpoint directory is private,
owned, locked and atomically persisted. Native HTTPS journals use their own
execution kind and cannot resume a local/synthetic journal.

| Command    | Real CMS behavior                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upload`   | Reuse-only imports recomputed historical proof plus fresh Native metadata without opening the image or staging. New selected images use the existing resumable start/status/chunk/complete protocol and measured Native body writer.                                                                                                                                                                                                  |
| `run`      | Verifies media, adopts the existing ID, saves with exact expected revision/content/idempotency binding, then performs bounded delivery progression. A frozen delivery checkpoint resumes that delivery directly.                                                                                                                                                                                                                      |
| `publish`  | Checks current media proofs and frozen content, performs prepare/read/request/read/release, and verifies fresh Native B+1. Whole-set READY is required; pending work returns `WAITING_FOR_READY` without an unbounded poll or direct publish fallback. An intent that ended stops with `DELIVERY_INTENT_EXPIRED`, `_SUPERSEDED`, `_CANCELLED` or `_WITHDRAWN`; it never becomes ready, so a new delivery needs a new state directory. |
| `withdraw` | Owner-only fresh Native preflight, one revision-CAS PATCH to draft, then separate fresh revision+1/status/content/fingerprint persistence. Reentry never repeats a PATCH that may have been applied. A lost reply can establish observed draft state while retaining unknown attribution of the original mutation.                                                                                                                    |

Before its first write (an upload, a draft save or a delivery intent), `upload`,
`run` and `publish` ask the authenticated, read-only
`POST /api/editorial/catalog-delivery-capabilities`. An Admin without the
delivery and upload endpoints stops with `ADMIN_CAPABILITY_MISSING`. A
publication also needs a Backend that can pin a recipe and prove readiness;
otherwise it stops with `BACKEND_DELIVERY_NOT_CONFIGURED` or
`BACKEND_DELIVERY_UNAVAILABLE`. Nothing has been written at that point. A
reuse-only draft `run` needs neither and asks nothing. Admin's operator client
turns every Backend 503 into one code, so a readiness route that answers 503
reads as `BACKEND_DELIVERY_NOT_CONFIGURED`. That is usually a Backend without
its prepare reader (`CATALOG_PREPARE_DATABASE_URL`), but a passing store outage
(`STORE_UNAVAILABLE`) answers the same. Run once more before changing
configuration.

A draft save or withdrawal that Native refused (a complete 4xx answer), or that
an admission, authority or credential check refused before dispatch, changed
nothing. While the record is still at its pre-action state, the next run from
the same state directory sends it again. Those checks run before the attempt is
recorded, so such a refusal records no attempt. Once the attempt is recorded it
counts as possibly sent, even if the run deadline passes or the process stops
before dispatch. A transport-uncertain or 5xx attempt may also have been
applied. Both only reconcile, so a withdrawal left that way needs the Admin
withdraw control.

Historical provenance remains Production. The converter's pinned raw files are
recomputed once per source bundle per locked session and each entry and original
Native Catalog ID is matched exactly. Small raw-source file hashes are checked
again before mutation and after a credential-provider await; a new process
reopens the sources. Unknown historical object keys remain null in the
converter. A later exact Native response may create an independent current
proof: the media receipt binds Media/Catalog identity, SHA, bytes, dimensions
and a legal nonempty key; the selected Catalog draft receipt binds its Native ID
and Source identity. Production audit v2 retains both owned receipts, safe
projections and measured `observedAt`, and revalidates them on reload. It does
not rewrite the old unknown fact or infer keys from filenames. Missing or
conflicting current metadata stays HOLD, without opening originals or falling
back to staging. Withdrawn DESK-003 and rights-held RUB-004 remain protected
regardless of metadata.

Every request, including principal/metadata/draft reads and reconciliation,
reserves and persists its budget before dispatch. Confirmed actions and media
proofs reload against their exact owned transport rows. UNKNOWN preserves its
cost and original key/body. Saved draft outcomes reconcile with the real
actor/operation/key/request-fingerprint receipt; equal content alone is not
mutation proof. Existing withdrawal/held protection latches are monotone.
Confirmed saved results are structurally bound to their original ID, revision+1,
content and fingerprint on reload. First publication adoption rechecks the real
read-only save receipt before using that result; an existing frozen publication
checkpoint keeps historical saved B while verifying B+1.

Production seam tests substitute Node HTTPS request objects in process; they
start no server and prove wiring and gates only. They do not establish TLS to a
real host, deployed capability, Production publication, anonymous delivery, CDN
cache eviction or actual archive-image handling. Anonymous publication and
withdrawal acceptance remain independent platform checks.
