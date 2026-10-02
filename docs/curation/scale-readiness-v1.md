# ArtVenn Curation scale-readiness v1

This local implementation adds stable photo identity, optional capture events,
reviewed photo additions, Original-based publication derivatives and explicit
Algorithm Dataset snapshots. It retains the existing App, Label Studio, SQLite,
Qwen pipeline and existing Editorial adapter. The schemas live only in
`scripts/curation/schemas`; no shared Web/CMS contract was added.

## From selected photos to editable Admin Draft

The daily flow is **Select photos → AI grouping proposals → human corrections
and representative-image selection → AI-assisted card preparation → editable
ArtVenn Admin Draft**. Reviewed proposals supply the card information. Missing
historical information may remain unknown through an explicit deferred
disposition; a title, supported formal kind and representative image are still
required. Reviewed person and object-description text is carried literally into
the editable Owner note without inferred roles or historical facts.

The App invokes the existing Editorial adapter itself. Users do not export or
import JSON, enter IDs, fill spreadsheets or repeat annotations in Admin.
**创建可编辑 Admin Draft** saves the Draft, uploads selected Publication
derivatives, reads the server state back and returns editable Admin links.
Partial receipts and revision checks remain in place; another environment's
cached Draft mapping is refused. Draft creation never publishes or grants Owner
approval.

Real transfer remains refused by default. Before the first real operation, the
Owner chooses the exact isolated Development environment and a small selection
of at most three cards and twelve photos. The operator prepares private
owner-only target configuration and a short-lived authorization after that
explicit choice. The authorization binds the exact target, prepared content
hash, object/catalog identities and Original/derivative hashes. It expires
within 24 hours. The existing `syntheticOnly: true` target guard stays enabled;
only the exact authorized selection can pass the real-material boundary. No
grant is created automatically by selecting a folder or preparing a card.

Dataset export, automatic cross-batch matching, model training and comprehensive
metadata completion are not prerequisites for this Draft workflow.

## Identity and capture events

Identical bytes resolve to one logical Asset. Each selected source location is
retained as an AssetOccurrence with its batch, source session and content hash.
Changed bytes create another logical Asset. Existing asset IDs, object IDs and
AV codes remain valid historical references. Matching bytes never establish
physical-object equivalence.

A whole-object alias requires both a complete collected human reassignment to
one target and a separate explicit confirmation in the empty source card.
Partial moves, AI relationship suggestions and content hashes do not create an
alias. Conflicting facts or server bindings block consolidation. Alias events
retain their review decision, revision and previous identities.

Open **拍摄事件资料（可选）** on an object card to record an event and select
its source occurrences. Date/timezone, location, photographer, device and notes
are optional; leave unknown values blank. Saves append revisions with explicit
manual provenance. Existing occurrence associations stay visible and cannot be
unchecked; additional associations may span ingestion batches. An ingestion
batch and a capture event have different meanings. Saving metadata does not
create a ReviewDecision or infer a missing capture date from file timestamps.

## Add photos to an existing reviewed object

Choose **为这个对象增补照片**, then select a small source folder containing at
most 50 supported photos. The target is fixed. The form displays only incoming
logical assets; already present identical photos add source occurrences without
renewing target membership. Review destinations and photo roles, save/reopen if
needed, then explicitly confirm. Submission goes through native Label Studio
annotation creation, readback and collection. The target's old members, facts,
names and decisions remain intact.

Each review version has a separate donor identity. Reconsidering a previously
omitted photo cannot invalidate another version's accepted photo. Intake checks
the frozen selected source paths/hashes and target baseline before submission
and collection. Another target change makes the draft stale; selecting again
creates a new review while retaining the previous one. A lost POST response is
reconciled by reading the native annotation, without another blind submission.
Retry reconciliation ignores only membership changes made by its own tasks.

## Publication derivatives

Offline package preparation resolves a registered Original occurrence and
verifies its content hash. If the first source is unavailable, another
registered copy of the same bytes can be used. It never falls back to the
1536-pixel review preview. The renderer checks the Original before and after
decoding and records the chosen occurrence, source/output hashes, input/output
dimensions, orientation, ICC treatment, parameters and decoder versions.

The bounded generated-image experiment froze `source-srgb-jpeg-4096-q92-444-v1`:
maximum edge 4096 pixels, no upscaling, LANCZOS resizing, JPEG quality 92, 4:4:4
sampling and embedded normalized sRGB. Embedded profiles convert to sRGB;
untagged RGB records an explicit assumption; untagged CMYK is refused. EXIF is
stripped, alpha composites onto white, and orientation is applied once. RAW uses
full-resolution LibRaw decoding with camera white balance and recorded
parameters. The recipe identity includes actual Pillow, JPEG, LCMS and LibRaw
versions plus the output ICC hash.

Outputs are written atomically and verified before reuse; changed or tampered
bytes are refused. Original files and old packages are preserved. Generated
fixtures establish workflow and lineage behavior. The Owner's
no-obvious-problems feedback covers the presented Synthetic comparison. Actual
outputs from the first explicitly selected real card must be checked within that
card workflow; untested RAW quality is not established, and there is no separate
visual acceptance phase. Preparing a package alone does not upload or publish
it.

## Optional Algorithm Dataset v1

Select objects in the directory and choose **导出选中对象的 Algorithm Dataset**.
Export is an explicit local operation; analysis and collection do not trigger
it. One read-only SQLite transaction produces canonical JSONL, a versioned
schema, manifest and checksums. Current collected projections are separate from
proposals, evidence references, immutable decisions and history. Current
relationships use the latest proposal version; a newer pending, rejected or
deferred proposal cannot resurrect an older accepted relationship.

The provenance closure retains referenced donor objects, logical assets,
occurrences, capture revisions, alias decisions and relevant bindings. Media
bindings are restricted to exported Object/Asset references. Conflicts stay
explicit rather than becoming inferred consolidated facts.

The snapshot contains metadata, references and recorded content hashes. It
contains no photo bytes, source paths, native annotation payloads or runtime
configuration. Recorded Original hashes are not reverified during metadata
export. The manifest states that policy and includes schema/exporter hashes;
creation time is outside content identity. Repeating unchanged input verifies
and reuses identical content. Another relevant decision or exporter/schema
version changes the dataset ID. Outputs are private and read-only; corruption or
an active interrupted export lock is refused, never silently overwritten. Export
alone does not authorize training, transmission or publication.

## Migration and verification boundary

New isolated runtimes receive additive migrations 003 and 004. An existing
database without the scale runtime marker raises
`EXPLICIT_SCALE_MIGRATION_REQUIRED` before SQLite opens. Only a deliberately
selected runtime passed to `Registry(root, upgrade_scale=True)` can opt in. The
retained r4 runtime was not migrated in this task. Do not run old and new
writers concurrently against a migrated runtime; never restore a stale backup
over newer collected decisions.

Python discovery must explicitly include `scripts/curation/test_*.py`; nested
Node adapter, lifecycle and companion tests must also be run explicitly. The
repository task router alone does not establish these results. Validation keeps
mocked transport regressions, actual synthetic LS/UI integration, real-data
Owner acceptance and Production publication as separate evidence. See the task's
private validation record for the candidate's check results and limits.
