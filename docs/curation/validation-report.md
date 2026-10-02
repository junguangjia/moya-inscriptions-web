# AI curation v1 validation

## Scoped correction and manual completion (r4, current)

The existing worktree, native App, model, three LS projects and Synthetic
Development evidence are retained. New behavior is confined to selecting a small
review scope, correcting photo assignments/roles, supplying necessary manual
fields and making local save states explicit. No model/dependency change, real
upload, CMS write, Owner publication approval, Publish or Git delivery was
performed in this revision.

Actual generated-photo acceptance used two separately labelled Synthetic test
groups containing three certified drawings of the same object: overview, detail
and label. The UI saved and reopened the form, reassigned the two source photos,
recorded their independent roles and supplied a manual title/type. Four real
native LS annotations were read back and collected into four immutable
test-reviewer decisions. Repeat collection produced zero new decisions and zero
failures. Explicit selection of overview and detail, excluding the label,
produced a one-object/two-photo package through the real offline adapter. Media
hashes, role provenance, incoming source decision and all four scoped native
annotation snapshots were verified locally. These new test inputs are manual
Synthetic correction fixtures, not additional AI inference evidence.

Consistent pre-change SQLite backups and a controlled comparison confirmed all
existing registry rows, native projects/tasks/predictions/submitted annotations,
the original selected-folder file and all prior source hashes remained intact.
The existing six Synthetic decisions and 45-photo model proposals were retained.
No prior Synthetic Development write was repeated.

The Owner explicitly selected two real groups containing eight photos of one
inscription. A private review form is restricted to those exact eight photos;
the same-object destination and inscription description follow that instruction.
The Owner completed this real form and explicitly prepared the offline package.
Independent controlled local readback verified all eight photos assigned to the
chosen target, four actual native annotations and four collected decisions,
matching per-photo roles and manual fields, and zero new decisions on replay.
The one-object/eight-photo package matches the Owner's explicit title/type,
photo order and single representative. All derivative hashes, source hashes,
removed EXIF, incoming source-group decision and four scoped annotation
snapshots passed. The emptied source group retains its history. The other 37
photos' objects, proposals, tasks, memberships, facts and decisions are
unchanged; original source hashes and folder selection are unchanged. Private
receipts retain native record IDs and package hash without exposing real content
in this report. This is a completed real Review-to-offline-package slice, not a
real Development upload or publication acceptance.

Validation: 144 Python tests and 23 Node adapter/lifecycle/companion tests
passed; project lint/typecheck/build passed using existing caches. Independent
source review found and verified repairs for annotation changes between readback
and collection, stale completed sessions preparing mixed-version packages and
late working-name validation. The normal task verification entry passed. Actual
browser testing found a blocking modal-confirm interaction in the embedded
browser; confirmation now uses the visible acknowledgement and action in the
page. Further actual Synthetic UI verification confirmed that failed photo order
validation preserves selections, and corrected preparation/reopening preserves
chosen photos and representative. Independent UX review verified pending input
locking, failed-input retention and the next-round link for deferred fields. A
read-only native schema probe initially used an incorrect prediction table name;
the corrected comparison used the installed table and passed. Unit transport
simulations remain labelled separately from native acceptance.

Local setup and AI inference retain their previously verified status. ArtVenn
integration retains actual Synthetic Development PASS; real integration remains
offline-only. Production publication remains unauthorized and unexecuted.
Identity stability across incremental use, large-scale organization,
high-quality output and Algorithm Dataset export are explicitly deferred, not
marked passed.

The following sections preserve earlier validation history.

Local-only, uncommitted delivery based on `origin/main` /
`c0742e905ef5a12c303e32e13f6ad36105b87ddd`, branch `codex/ai-curation-v1`. The
existing main checkout and its unrelated README edit were preserved. No commit,
push, merge, issue, approval or public deployment was performed.

| Gate                   | Actual result                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local setup            | PASS: two locked environments, one verified model; setup rerun reused both environments (158/55 exact packages) and the model without installation/download. Native LS login, three projects, eight Synthetic tasks, six Synthetic review decisions and source registry survived stop/start; 20 real-sample review tasks were subsequently verified.                                                              |
| AI inference           | PASS on four Synthetic images: actual pinned local VLM, multi-image structured grouping/role/field/relationship proposals. Initial run 27.371 seconds; measured repeat 23.651 seconds (load 1.143, generation 22.508), peak MLX allocation 4.705 GiB and process RSS 1.937 GiB. The selected 45-photo RAW sample also completed actual local inference and reached Review; no cultural/historical accuracy claim. |
| ArtVenn integration    | Offline validation and actual isolated Development Draft/media/readback/replay/stale-revision/private-access checks PASS. Revised packages reuse the same Catalog and current revision. Real-material transfer is disabled.                                                                                                                                                                                       |
| Production publication | NOT AUTHORIZED / NOT RUN. No Owner approval or Publish calls.                                                                                                                                                                                                                                                                                                                                                     |

Browser review of generated images showed multi-page native predictions,
readable Synthetic source/Evidence and editable fields. Test reviewer removed
one detail photo from the proposed stone group, corrected its title,
preserved 传张旭 and 年代未详, and deferred its relation to the distinct pottery
object. Collect produced six immutable test-reviewer decisions, two accepted
image links, confirmed fields, and no authoritative deferred relation. Repeating
Collect produced zero decisions and zero failures. All four original source
hashes remained unchanged. Original files and excluded Evidence remain
preserved.

Real preview endpoints were checked: helper preview without session 403, LS
preview without login 401, traversal and absolute-root requests 403. Model
inference had 60 socket samples with zero non-loopback connections observed; a
point-in-time LS/helper sample also observed zero. Neither is claimed as
exhaustive network prevention. Invalid JSON/Evidence, missing segments, timeout
checkpoints/resume, unsupported/corrupt photos, disconnected/changed source,
stale review/version, reassign provenance, instance isolation and
rejected/deferred facts have Synthetic boundary regressions.

Actual mapped-update test preserved an existing date VALUE and contributor array
when omitted by the next package, retained the same Catalog, and reached
revision7. This uses labeled Synthetic transport fixtures, not model output or
Owner decisions.

Actual native partial-upload test deliberately discarded the committed new
upload reply and the retry lookup reply. The first round reported
`MEDIA_BATCH_INCOMPLETE`; resume verified the same Catalog. Media count stayed 3
before/after resume, proving this retry created no duplicate. Test derivatives
and all database/storage artifacts were retained. Mock HTTP/lifecycle tests are
separately labeled and do not constitute native acceptance.

Original failures were retained: dependency solver rejected Pillow 12.2 against
SDK requirements (fixed pin12.3); the first guarded LS startup lacked the
upstream import path (fixed and restarted); stop initially raced port release,
then macOS Python exec altered argv (fixed exit wait and timestamp+task-path
identity); daily Stop killed its own shutdown loop before LS exited (fixed a
detached controller, independently reviewed and actual GUI Stop verified both
ports free with all data retained); volatile LS `created_ago` broke repeat
collection (fixed semantic replay with raw snapshots retained); a daily adapter
action used an unsupported CLI verb (fixed); native CMS materialized absent
groups as UNSUPPLIED (fixed canonical absence comparison, UNKNOWN remains
distinct; mapped update preserves omitted facts and relation arrays).
Independent-review defects in stale projection/replay, target binding,
reassigned source provenance, split identity and exported membership were fixed
with regressions. The first normal verify-task run selected Web/CMS because
native Next had generated a transient next-env import, and failed formatting
before either CMS approval/publication suite ran. Its private evidence is
preserved; final validation uses the final unchanged diff.

Required lint/typecheck/build passed using the existing project Node/pnpm and
lock. Full Python suite:83 PASS. Adapter/lifecycle suite:19 PASS (11+8; mocked
transport marked); scoped script regression:228 PASS. The final normal
verify-task selected only script-tests (Web/CMS false) and passed under its
existing 120-second profile. Formatting evidence and the final source
fingerprint are in the private validation directory at handoff. Independent
review reported no remaining blockers in the final
registry/worker/menu/lifecycle/model/preview slices; the final adapter
canonical-readback, setup and detached Stop controller changes received another
review.

Changed scope is `scripts/curation/**`, `docs/curation/**`,
`scripts/curation.test.mjs`, and the explicit local-tool routing clause in
`scripts/ci-task-scope.mjs`. No public schema/dependency upgrade, global
runtime, another task's source or Production configuration changed. Full
modified-file inventory and exact byte fingerprints are in the private handoff
manifest. Private state/photos/model/config/logs/annotations never enter the Git
diff.

Real folder selection and local inference are complete. Human review of the real
sample is the remaining user step. The worker locally analyzed only the folder
chosen in the native picker; real visuals, OCR and private annotation content
must remain outside remote coding-agent context. Remote Draft upload and
Production publication require their own future explicit target/data
authorization.

## Selected real RAW sample

The user completed the native folder picker. The first directory exceeded the
50-file bound and was refused before decoding. The next selected batch had45
Sony ARW files; the original Pillow-only path reported45 unsupported assets and
no inference. One pinned rawpy0.27.1 CPython3.12-arm64 wheel was then added to
this task's environment, without changing the existing NumPy2.2.6 or global
runtimes. Full dependency inventory remains locked (158/55 packages). Native
LibRaw0.22.1 decoded all45 images locally. The previous failed asset identities
and receipts were retained; source hashes and content stay private. Model/review
results are reported through aggregate receipts, with no real photo, preview,
OCR text or private annotation returned to the coding-agent context.

The actual sample completed six valid model windows covering all45 assets: v1
retained2 windows (4 strict-shape failures), v2 retained1 (3 empty-fact
failures), and v3 completed the remaining3 without failures. The prompt was
clarified to use the exact ID keys and omit unavailable/empty facts; the strict
parser was not relaxed and no response was hand-filled. Original failed
outputs/checkpoints remain private. Measured run times were349.907,243.947 and
99.579 seconds. Validated local proposals comprise8 groups,45 roles,10 fields, 2
relationships and3 issues. All20 actual native LS review tasks (8group,
10field,2relationship) were read back successfully. This verifies usable
proposals and provenance, not their semantic accuracy or human acceptance. There
are zero real-human annotations. All45 source hashes remain unchanged.

Repeating Analyze through the daily menu returned `review_ready`, zero new
Review tasks and the same three model-run receipts; no model process remained.
Real photos/decisions were not uploaded to the Development adapter. The actual
Synthetic review/writeback and Development package evidence above remains
separate from this pending real-human review.

Synthetic regressions cover RAW deadline, native corrupt input, single
orientation application, pixel bounds, source mutation, failed-asset recovery
and mixed-batch recovered-photo coverage. Ready/reviewed preview bytes are
unchanged. Public JPEG processing remains the same1536-pixel preview-derived
recipe; preview/decoder lineage is retained in localAnnotations. New additive
RAW configuration and its recovery fix received independent review.

## Object identity usability correction

The existing three Review projects are reused. A private additive SQLite
migration binds persistent AV codes and editable working names to canonical
local object IDs. Directory and native companion galleries show filenames and
current collected membership. AI names are marked pending; private renaming does
not approve or change a public title. Current names remain visible when the
companion is folded or its target gallery is scrolled.

Synthetic browser acceptance exercised saving a name, reloading the directory,
opening the existing native group task from its card, and expanding a frozen
reassignment choice into the target name/code/photo gallery. Native group, field
and relationship context checks additionally confirmed exact task/project
binding and Synthetic evidence provenance. Field/relationship companion metadata
was checked locally; those two native screens did not receive a new visual
acceptance in this correction.

Consistent SQLite backup API snapshots were taken before owned helper/LS
restarts. Native task data, predictions, project XML and submitted annotations,
and local proposals, task mappings, immutable decisions, memberships and facts
match the original backup. The retained state has28 native tasks, 3 projects
and6 collected Synthetic decisions. Native unsynced draft storage was retained
across each restart; a normal Synthetic task view can create/update a native
draft. No real annotation was submitted or collected by this change.

Regression checks cover stable insertion-order backfill, concurrent new IDs,
duplicate aliases, alias/public-title separation, frozen target round trips,
removal authority across pending renewed proposals, mixed-source fixture
classification, native permission/host boundaries, delayed SPA responses, text
injection and loopback/wildcard listener conflicts. Final Python102/102 and Node
adapter/lifecycle/companion23/23 passed; project lint/typecheck/build passed
using existing caches. Explicit new-script lint and project format checks pass.
Independent review findings were repaired and focused checks passed.

One original native restart attempt reported helper-port occupancy after the
owned listener exited. The corrected bounded probe distinguishes closed-socket
TIME_WAIT from an actual listener and refuses both loopback and wildcard
listeners; no unrelated service was stopped. Older Synthetic import-intent
copies can predate final native data, so the companion reads the actual native
task and checks its exact stored data fingerprint and mapping. It never changes
native controls, values, task payloads, annotations or proposals.

Local setup and the object-directory/group UI are verified. Real45-photo local
AI inference remains verified as proposals requiring human decisions. The
previous actual Synthetic ArtVenn offline package/isolated Development Draft
flow remains the integration evidence; this display correction did not rerun or
write CMS. Production publication, real outbound transfer, Cloud fees and
automatic Owner approval remain unauthorized and unexecuted.

## Native Mac application and daily workflow (r3)

The task-private ArtVenn Curation.app was compiled with the installed Swift/SDK,
explicitly targeting arm64 macOS14. It is locally ad-hoc signed and signature
verification passes. No global installation, framework or dependency upgrade was
performed. Its AppKit window embeds the existing loopback workspace and Label
Studio with a task-private WebKit rule store, exact-origin navigation and a
helper-home/main-frame-only folder bridge. Credentials remain backend-private.

Actual Synthetic native-window acceptance selected the certified four-photo
folder with NSOpenPanel, checked Cancel retention, started unchanged-batch
analysis reuse, opened current-batch object galleries and existing grouping,
field and relationship tasks in the same window, and returned to the workspace.
The grouping companion displayed the current name/code/photos and expanded the
frozen reassignment target into its actual name/code/gallery. Field review
showed the prior explicit corrected value; relationship review showed both
objects and the prior deferred disposition. No new annotation was submitted.
Repeat Collect wrote0 new decisions. Explicit App selections prepared a valid
one-object/one-overview-photo offline Draft; label/evidence remained unchecked.

Cancel Quit preserved the current form. Confirmed Quit actually exited the App,
stopped both owned services and freed both loopback ports. Controlled local
comparison against consistent pre-change backups found all13 curation tables and
native project/task/prediction/submitted-annotation content preserved:
28tasks,3projects,6annotations,6collected Synthetic decisions. All45 selected
real source hashes and all four certified fixture hashes remained unchanged. The
original selected folder was restored byte-for-byte while stopped; a controlled
local dashboard confirmed45 source files and20 native review tasks. The App
reopened in a clearly marked Synthetic demonstration view, preserving the actual
selection and the six collected Synthetic decisions. Reopened persistence and
focused single-task Review are recorded in the final private native acceptance
receipt. Real material GUI acceptance is deferred to the Owner.

Corrections include current-batch Review/collect/preparation, actual reused
batch identity, selection generation reset, in-flight worker guards,
originating-media current-review links, exact PASS/PARTIAL/failure reporting,
lifecycle serialization and bounded HTTP readiness. An already analyzed folder
with changed photo contents is explicitly refused before new objects/batches are
created; stable incremental identity is not claimed. Synthetic authorization is
based on fixed generated image hashes, with actual source/media provenance
rechecked before Development. A filename or editable adjacent manifest cannot
authorize transfer. Native import readback validates predictions both after
import and on replay.

Original native failures are retained: the first Swift build required a
MainActor entry annotation; the first WebKit rule compilation rejected its
expression and loaded no page. A simpler three-rule list in a task-private store
then compiled and the actual App loaded successfully. A private preservation
probe initially used an upstream table-name assumption and was corrected after
schema-name inspection; its final aggregate comparison passed. During field GUI
observation the native cross-batch sidebar exposed a small amount of real AI
candidate text into the tool context. That content is not reproduced in
receipts, Git files or deliverable screenshots; subsequent observations return
only the Synthetic task. Focused helper-opened Review now constrains the native
task query before serialization, binds annotation/draft/prediction routes to the
current task, and refuses next/sample/export/cross-task navigation. Same-project
initial history returns an empty navigation array without querying native
history. The task pane is also removed from presentation; CSS is not the data
boundary. Actual local lists for certified Synthetic field, group and
relationship tasks each contained exactly one current task, with certified
images served. Synthetic toolbar home/back/refresh retained that fence and
rendered without a runtime error; ordinary helper views expire the fence for
real-folder use.

Independent source re-review found no remaining blockers in native lifecycle,
daily scope, provenance and prediction replay. Required project lint/typecheck/
build and23 Node adapter/lifecycle/companion tests passed using the existing
project runtimes; Python134 tests passed including the final focused-query,
history and versioned-preview regressions. The final normal task gate and exact
file fingerprint are recorded privately. Mock transport/lifecycle tests are
labeled separately from actual native UI, local-model and Development
verification. Existing actual Synthetic isolated Development Draft evidence is
retained; r3 does not repeat CMS writes or claim Owner acceptance. Real45-photo
semantic human review remains pending.

Production publication, real outbound transfer, Cloud fees and automatic Owner
approval were not executed. Source remains a local review-ready diff. A later
human request in the coordinating conversation authorizes Draft PR sync, but the
existing INCOMPLETE outward core-check batch remains stopped; no automatic new
security allowance, hook bypass, commit/push/merge or PR publication is implied
by local functional acceptance.
