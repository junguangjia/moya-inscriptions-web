# ArtVenn local publication package and Development adapter

This adapter prepares native Payload CMS drafts only. It uses the existing
`scripts/editorial/batch.mjs`, internal Editorial contracts, native Media
collection, committed migrations and synthetic target guards. It does not call
Owner approval, publication, restore, delete, community agent administration,
Production endpoints or cloud storage.

The entry points are exported functions for the local workstation UI. The CLI is
an implementation/debugging entry, not the daily Owner workflow.

## Publication package v1

The task-private package file must be owned by the current user, a regular file
without a symlink, mode 0600, at most 32 MiB. Top-level shape:

```json
{
  "version": 1,
  "instance": "development",
  "synthetic": true,
  "selectionConfirmed": true,
  "objects": [],
  "localAnnotations": {}
}
```

`objects` has 1–100 selected reviewed objects. Each object has:

- `objectId`: stable local token; letters/digits/underscore/hyphen, max 128.
- `catalogId`, `sourceId`: independently allocated, stable distinct business
  identities. Existing mappings must be reused; these are not Payload numeric
  document IDs. Local allocation must be persisted before package creation.
- `kind`: `inscription` or `calligraphy`; selected after review.
- `title`: reviewed Catalog title.
- `fields`: only existing `EditorialDraft` fields other than the five reserved
  keys `catalogId`, `sourceId`, `kind`, `title`, `media`. Stateful facts use the
  existing `{state: "VALUE", value: ...}` or allowed absence-state contracts.
  Unsupported facts must stay omitted/UNSUPPLIED; never infer facts to fill the
  CMS. `summary`, `periodLabel`, `aliases`, `provenance`, `contributors`,
  `sourceCitations`, `ownerNote`, `filterMetadata` follow current contracts.
- `media`: 0–100 task-private reviewed derivatives to attach.
- `localAnnotations`: optional workstation-only metadata. This is never copied
  to a Catalog field. Duplicate/grouping/OCR hypotheses, confidence, model and
  prompt provenance, original paths, review decisions and rejection details
  remain local unless an explicit existing field is reviewed for transfer.
- `cmsDraft`: optional automatic persisted update mapping
  `{id, expectedRevision, instance: "development", baseURL}`. The workstation
  obtains it from a successful integration receipt and injects it when preparing
  a revised package. Exact CMS origin, current revision and stored business
  identities must all match. The user does not fill this mapping manually.

Each media item has:

- `assetId`: stable local token unique in the object.
- `mediaId`: stable CMS MediaId unique throughout the package.
- `derivativePath`: local JPEG/PNG/WebP path, absolute or relative to the
  package file. URLs and symlinks are refused. No URL is fetched.
- `sourceSha256`: lowercase SHA256 of the retained original, for local
  provenance. The adapter does not independently reopen the original;
  original-byte verification belongs to the workstation ingest stage.
- `uploadedSha256`: lowercase SHA256 of the exact derivative to transfer;
  validated before upload and against authenticated server byte readback.
- `alt`: reviewed nonempty alt text, max 2000 characters.
- `position`: distinct nonnegative integer.
- `isRepresentative`: boolean; nonempty media sets must have exactly one true.
- `rights`: optional unchanged reviewed original rights string, max 2000.
- `orderConfidence`: optional `HIGH` or `LOW`; retained unchanged.

Media is capped at 40 MiB, 80 million pixels and one frame, matching native CMS.
Format and decoded pixels are checked by the existing Sharp dependency. Original
bytes and local provenance are not replaced by the uploaded derivative.

## API and target

`validatePublicationPackage(input, {repoRoot, packageDirectory})` is offline. It
returns prepared objects plus a stable package hash; private paths/content must
not be rendered as routine console output.

`draftRoundtrip({repoRoot, packageFile, configFile, stateDirectory, budgetMs, signal})`
reads an Owner-protected local config produced by the setup harness. Config
requires `instance: development`, `syntheticOnly: true`, `targetVerified: true`,
an explicit HTTP loopback host and port, private `apiKey`, and exact
`catalogIds` scope. It refuses other endpoints, redirects and non-Draft
operations. This task additionally requires top-level `synthetic: true` for all
transfers. Real chosen material stays offline under the current Owner
authorization, even when the destination is loopback.

The setup harness creates a new task-owned Docker PostgreSQL container and
retained named volume using an already-local inspected image (`--pull=never`).
Its only published port binds 127.0.0.1. It creates a new database whose name
has a whole `synthetic` segment, and the repository's disposable database
marker. It refuses existing configuration, never attaches to `yoyi_dev`, and
executes only existing CMS migrations after marker verification. It creates a
synthetic bootstrap Owner solely to create the exact scoped automation user.
Owner password is generated in memory and discarded; no Owner approval is
created. Only the automation key is saved privately.

All shared Admin dependencies must already be built in the parent task worktree.
Before native startup, the parent must ensure the task checkout has no ambient
`.env` file that loads another task's runtime configuration. The harness strips
ambient service/PG/CMS credentials from child environments.

`setupDevelopment({repoRoot, packageFile, stateDirectory, dockerImage: "postgres:18.4", dockerBin, budgetMs})`
returns only safe startup metadata and private file paths.
`stopDevelopment(stateDirectory)` verifies exact process birth and command
identity before stopping the owned native CMS process group. Container stop
verifies exact container ID plus task/environment labels; both the container and
volume are retained. Neither deletes files. The services persist after
successful setup.

## Genuine flow and receipts

For each object: create an empty-media Draft; upload original approved
derivative bytes using native Media; read authoritative object key/dimensions;
attach the media snapshot to that Draft using current `expectedRevision`; read
back exact content and authenticated bytes; verify anonymous Draft/media denial;
replay the same command against the actual server without revision advance; send
a different stale-revision command and verify conflict with no data change.

The adapter checks the resulting record is not published. It cannot establish
cloud COS behavior or Production publication, both of which remain not run.

Receipts and state are mode 0600. Completed objects are retained if another
object fails. Rerunning the same unchanged package reconciles the same server
identity/idempotency receipt. A changed package needs a distinct state scope; do
not overwrite existing package state. Revised packages reuse the previously
persisted `cmsDraft` mapping and require its current revision and exact origin;
they never create a replacement identity to bypass an existing binding.

The adapter retains individual fixed error categories and totals. Full content,
raw endpoint errors, credentials, object keys and original paths remain private.
The root task must perform the genuine native roundtrip; syntax checks or unit
tests with injected transport are not integration evidence.
