# Versioned curation metadata roundtrip

This companion preserves archival metadata independently of Catalog display
selection. It writes no image bytes, invokes no image URL, changes no Catalog
revision, and does not publish a draft. It uses the existing private editorial
receipt ledger and existing Owner/automation access. No role or grant is added.

## Stages and honest completion

1. Freeze a metadata snapshot from explicit local registry, publication packet,
   reviewed selection, model receipts and a saved native media inventory.
2. Offline validate the entire versioned snapshot. Missing optional professional
   values and `unknown` remain legal. Native IDs, media IDs, SHA values,
   sequence, source references and annotation/decision chains must be
   consistent.
3. After the server migration/release is approved and available, submit through
   `save-curation-metadata`. One database transaction appends the whole artifact
   or none of it. A transient failure is safe to retry; a conflicting baseline
   requires a fresh read and comparison, never a blind overwrite.
4. Read the exact stored JSON through `read-curation-metadata`, recompute its
   UTF-8 SHA, verify all counts and confirm it was current at readback. Only
   then report `PERSISTED_AND_READBACK_VERIFIED`.

`OFFLINE_VALIDATED` means no server request. `PENDING` means interrupted or
uncertain. `FAILED` does not prove the server did not commit: replay the exact
snapshot and receipt to reconcile a lost reply. A stored historical snapshot
must not be described as the current snapshot. Each repeat rechecks metadata; an
old local success receipt alone is insufficient.

Image upload ACKs, image metadata SHA, and this metadata roundtrip do not prove
independently re-read COS image bytes. This workflow never performs that check.

## Explicit inputs and reuse

The Python snapshot module accepts only explicit input paths. It uses a
read-only SQLite snapshot, selected photo IDs from the frozen publication
packet, portable review history, and model output projections restricted to that
selected scope. It neither opens originals nor discovers credentials. The
original model input hash and original record hash are retained, while filtered
output is explicitly identified. Unknown failed-segment input membership remains
unknown.

The Node `metadataRoundtrip` function is the shared helper entry for the
existing workstation flow. Its CLI is an operator/debugging interface, not a
second daily user interface. It reuses the existing bounded editorial batch
transport, private journal, receipt lock, timeout, cancellation and replay
rules.

Offline validation:

```sh
node scripts/curation/metadata-roundtrip.mjs --metadata <private-snapshot> --state <private-receipt-directory>
```

After explicit target authorization and server rollout:

```sh
node scripts/curation/metadata-roundtrip.mjs --metadata <private-snapshot> --state <private-receipt-directory> --config <existing-protected-config> --execute
```

An initial metadata import uses `expectedPreviousSha256: null`. A revision adds
`--previous-sha <current-metadata-sha>` obtained from the controlled metadata
read API. Snapshots and manifests are private, owned, regular files; target
config is not placed in arguments or logged. Keep the same snapshot, prior hash
and state directory for retry. Changed content needs a new frozen snapshot.

## Data boundaries

The archive contains N photos and a separate display subset. It does not copy N
photos into Catalog.media. The retained Draft baseline detects conflicting edits
before a new import; a duplicate can replay its prior immutable artifact.
Human-confirmed membership and legacy photo roles are not independent semantic
approval of every professional label. Retain the actual review scope and never
upgrade it during export/import.

Legacy publication package v1, save-draft, publish-approved, and upload-media
operations retain their semantics. Curation metadata has its own v1 contract;
unknown versions fail before mutation rather than being silently normalized.

## Rollout and recovery

The new migration adds nullable metadata columns and one enum operation to the
existing ledger. Existing rows are unchanged; no tables, sequences or grants are
created. Apply and test the migration in a task-owned isolated target first.
Production application, real backfill and real API readback are separate gates.

Rollback returns to the previous application and stops new metadata imports.
Keep all metadata columns and rows. Do not automatically run a destructive down
migration or delete artifacts. Old publication/draft operations remain distinct
from metadata operations and must never replay a metadata receipt as a draft
mutation. Unknown optional facts and unpublished state remain unchanged.

## Frozen files and interrupted processes

Snapshot generation writes a private same-directory temporary file, flushes and
fsyncs the complete content, then exclusively links it to the content-addressed
final name and fsyncs the directory. Existing final files are never overwritten.
A fully written final may retain a second hard link after an interrupted
publish; replay verifies its ownership, private permissions, stable identity and
exact bytes. Orphan temporary files are not scanned or deleted. An invalid
existing final requires explicit local maintenance and must never be silently
replaced. Manual-only batches can omit model inputs and retain an empty
`modelRuns` list.

The receipt lock fails closed after a hard process crash. Verify the exact
owning process and its start identity and confirm that no writer remains before
an operator performs controlled local lock recovery. PID-only guessing and
automatic stale-lock deletion are unsupported. Preserve the pending journal and
the frozen snapshot; retry then reconciles any committed artifact and performs
fresh readback.

## Existing workstation integration

The currently installed workstation contains unmerged R18 annotation and R27
resumable-upload changes. The review packet records their exact source versions
and file hashes separately from this change. Use only the hash-bound minimal
metadata overlay on that baseline after approval; replacing the installation
with the clean main checkout would omit those upload and annotation
dependencies. Preparation, interruption and pending-server states appear within
the existing upload area. Metadata completion remains separate from image upload
confirmation, Catalog display selection, and independent object-byte
verification.
