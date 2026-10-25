# Immutable runtime packaging and bounded retirement

These POSIX Python 3 tools use only the standard library. They select an
already-built role snapshot; they never install dependencies, compile the
product, change service bindings, read environment files, or operate cloud
storage. Source tags identify provenance; the content manifest identifies the
actual current bytes, including separately approved overlays. A successful pack
is not a successful cold start or production activation.

## Runtime artifact interface

```sh
python3 scripts/operations/runtime-artifact.py plan \
  --input /private/role-snapshot --role backend --source reviewed-current \
  > /private/runtime-manifest.json
python3 scripts/operations/runtime-artifact.py pack \
  --input /private/role-snapshot --manifest /private/runtime-manifest.json \
  --manifest-sha MANIFEST_FILE_SHA256 --output /private/runtime.tar.gz
python3 scripts/operations/runtime-artifact.py extract \
  --archive /private/runtime.tar.gz --destination /private/new-runtime \
  --manifest-sha MANIFEST_FILE_SHA256 --free-floor 536870912
```

`plan` is the default when its subcommand is omitted. Supported roles are
`backend`, `worker`, `issuer`, `admin`, and `web`. The first two preserve
`services/backend-production/dist/main.js` and `dist/worker-main.js`
respectively; the issuer preserves `services/agent-authorization/dist/main.js`.
Production workspace dependency graphs include required peers and installed
optional production dependencies, with their exact Node/pnpm resolution links.
Development dependency graphs, source trees and build caches are not selected.

Next roles preserve their existing nft traces, required files, server/browser
build output, public files and native dynamic includes. Missing traces or
required dependencies fail. No tracing path may escape the supplied snapshot.
Admin gets a small serialized-config bootstrap with its fixed loopback listener.
Web retains both current custom HTTP launcher files and calls their exported
`startProductionWeb`; its upload limits and shutdown are not replaced by a
standard Next server. Generated bootstrap text contains no serialized config; it
reads the manifest's already-built configuration at runtime. Private config,
environment files and known credential-file locations cannot be packaged.

Plans contain relative paths, hashes and sizes, not configuration/source bodies.
Previously generated bootstraps remain verifiable against their frozen archive
hashes when this tool changes; retirement does not require today's template.
Repacking a completed typed artifact uses its existing verified archive rather
than treating its generated launcher as a fresh product build input. A pack
rechecks the whole plan and each input; extraction checks the exact manifest
hash, every archive member and content hash, disallows hard links and symlink
traversal, and writes fresh inodes in a new staging directory. The completed
directory is published only if the destination is absent. Output is read-only
and includes a typed manifest plus installation inode receipt. CLI operations
have a real 120-second deadline, 150,000-file/8 GiB total bounds and a 256 MiB
single-file limit. Extraction also checks fresh free space against payload
bytes, per-entry filesystem overhead and the explicit free floor. The producer's
earlier peak gate must additionally include archive transfer, concurrent
candidates, recovery and any other temporary copies on that volume.

The extractor emits `EXTRACTION_PREPARED` after persisting a private intent and
before writing application payload. The private producer must durably record
that phase, its random staging name, manifest hash and directory identity in its
attempt registry. Normal failures clean their own staging directory. If the
process is killed, the producer's scheduled attempt cleanup must reclaim that
exact expired staging tree using the recorded intent, ownership, fresh consumers
and its reviewed inode kernel. Do not adopt unknown `.runtime-*` names by age.
This partial-install path is separate from the complete typed-artifact executor;
no completed installation receipt means that executor refuses it.

## Next cache mounts are a prerequisite to activation

The artifact declares exactly one empty `apps/<role>/.next/cache` mount stub for
each Next role. It copies no old cache content. Installation records the stub's
inode. `verified_snapshot` rejects extra cache contents, symlinks and
replacement inodes, so it must run before mounting and again after unmounting
for retirement. It cannot verify a live writable cache as an immutable artifact.

Prepare an external cache owned by the existing role UID on the same filesystem,
then bind it over the declared stub in the service namespace. The example
`infra/production/systemd/runtime-next-cache.conf.example` shows the shape.
Freeze actual paths and permissions privately. Preserve the role's other
existing write paths (including Admin media/session storage); replace obsolete
cache references in the full projected unit rather than blindly clearing all
state paths. Confirm every non-optional namespace path exists, daemon-reload,
and test a real cold start with the final mount and read-only runtime. Missing
cache paths or inherited old `ReadWritePaths` are activation blockers. Never
delete external cache contents as part of typed runtime retirement.

## Catalog, consumers and retirement

`runtime-retention.py` exposes small Python functions and CLI commands:
`transition`, `retirement_plan`, `typed_plan`, `allocated_reclaim`, `update`,
and `apply_typed`. CLI commands are `plan`, `typed-plan`, `update`, and `apply`.
Catalog JSON schema 1 has `generation`, `artifacts`, `roles`, `transition`, and
`static`. Each artifact has an explicit id/path/kind/state, manifest digest,
creation/expiry time; typed runtime artifacts also record role and extractor
`ownerUid`. Supported kinds are runtime, recovery, build, migration and scratch;
this is an explicit catalog across task namespaces, not a list of historic
names. Paths cannot overlap. Business data, backups, logs and COS objects are
excluded.

Each role names its current artifact and at most one rollback. Rollback proof
must explicitly assert verified data compatibility and bind both manifest
digests; a filesystem/COS transition cannot be declared compatible merely
because its code starts. An incomplete transition protects both old and new
candidates. Candidates have a finite retention time, but expiry never overrides
consumers. The `stage` event requires a fresh, passing peak-space projection
before any copy.

The private collector supplies `complete`, `observedAt`, `staticComplete` and
`bindings` with verified process/startup/maintenance/hold consumers. The
projection must be at most 60 seconds old. Unknown consumers retain everything.
Static compatibility rows bind paths/hashes to consuming artifact ids and a
finite `retainUntil`; a retained file protects its whole owning artifact unless
the producer first creates an independently verified compatibility copy. The
typed executor never edits a static file inside a live immutable artifact.

A producer must execute this sequence on **both successful and failed runs**:

1. Serialize service/pin changes, catalog transitions and retirement using the
   namespace's `.runtime-lifecycle.lock` and the existing deployment operation
   lock; no concurrent legacy producer may bypass it. When the producer holds
   the lifecycle lock across a child `apply`, inherit that same open descriptor
   and pass `--lifecycle-lock-fd`; the tool verifies its inode against the lock
   path. Otherwise `apply` acquires the lock itself. Collect actual processes,
   startup units, maintenance timers, namespace paths and compatible recovery
   consumers under that authority.
2. Compute the full peak projection, stage the candidate catalog row, extract
   and persist its typed receipt. Before switching services, persist `begin`.
   After verified health, persist `activate` with a bound compatibility proof;
   after a failed attempt, persist `fail` only once the previous service is
   confirmed.
3. Refresh consumers. Run `typed-plan` with root/catalog/consumers, current
   time, free bytes, incoming bytes and the free floor. Freeze the JSON file
   hash. Run `apply` with those same inputs, `--plan-sha`, `--now`, and
   `--execute`. This performs actual eligible directory retirement and catalog
   updates.
4. Run that same collector/plan/apply after failures and on the producer's
   periodic maintenance pass, even when no release succeeds. Separately
   reconcile expired partial-install intents from the attempt registry as
   described above.

The complete-artifact executor accepts only new manifest/installation receipts,
rechecks ownership/inodes/content and catalog/consumer hashes, and takes the
lifecycle lock. It moves each eligible tree into a private same-filesystem
retirement directory, persists an intent, deletes only that verified remainder,
then commits that artifact's catalog removal. Each object commits independently.
Interrupted moves, file deletions and catalog commits resume from the intent;
crash-released file locks prevent stale O_EXCL lockfiles. Unknown/legacy trees
remain for the separate private reviewed controller. No wildcard Docker/cache,
credential, business-file or database deletion is implemented.

`allocated_reclaim` counts allocated blocks only when every link to an inode is
selected. It is an estimate, not logical directory bytes or a promise of a `df`
change; open descriptors and fresh consumer checks remain the operator's
concern. Five-cycle filesystem tests, failed preparation, interrupted
retirement, static windows, consumer drift and hard-link accounting are
exercised by the existing script-tests entry through
`scripts/runtime-artifact.test.mjs`.

## Current task delivery restriction

The current Owner KEEP overrides the general tool capabilities above. Deliver
source plus offline runtime preparation/cold validation. Do not install a role,
change existing service pins or ordered environment bindings, restart the
protected authorization issuer, or mutate protected state. Explicit Owner holds
must be represented as protected consumers even after TTL expiry. Existing role
roots and their hard-link sources remain unchanged.

A later coordinated product release is separate; Web, Backend and Admin must use
the same approved commit where their strict contracts require it. A current
snapshot or a newly merged maintenance tool is not approval to deploy product
changes. Keep the exact private protection list out of source and public task
records. The private final handoff must report actual role roots, pin
paths/content hashes, ordered environment-file references and completed
deletions using fresh read-only evidence, without configuration values.

Execution freshness uses the real wall clock plus monotonic elapsed time,
regardless of a caller's planning `--now` value. Each new claim rechecks the
plan and consumer observation age. Isolated library fixtures may explicitly
inject a test clock; the CLI exposes no test-clock override. Initial full
artifact verification also requires the extracted root to retain mode 0555.
Recovery of an already claimed artifact uses its durable intent rather than
adopting a writable new artifact.
