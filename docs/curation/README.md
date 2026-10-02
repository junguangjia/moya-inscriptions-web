# ArtVenn local AI curation

This workstation path is configured and tested through the full Synthetic
review/Draft flow; the user-selected45-photo RAW sample also completed local
inference and reached native Review. Real human review is pending. Real material
stays local. The development adapter refuses every package containing
real-origin material. Production publication and Owner approval are not
available from this tool.

## Daily use in the Mac application

Double-click **ArtVenn Curation.app** in this task's private artifact directory.
The existing **Start ArtVenn Curation.command** also opens that App. It starts
or reuses this task's existing local services and shows the workspace in its own
Mac window. The native folder picker and Review stay in that window. Daily use
requires no terminal, JSON, IDs, database commands or environment variables. The
helper and Label Studio still run locally on loopback ports3580/3581; WebKit
reuses their existing interfaces inside the App. This is a local Mac wrapper
over the verified workflow, not a replacement review/model system.

1. **Choose and analyze.** Click **选择本地文件夹** and select a small folder,
   initially20–50 photos. Cancellation keeps the previous selection. Only that
   chosen tree is inspected; source photos are not moved or modified. Click
   **开始分析**. Counts distinguish readable photos and decoding failures;
   interrupted analysis retains completed model segments and offers
   **继续未完成的分析**. **重用本批已完成分析** reuses an unchanged completed
   batch and its tasks.
2. **Identify and review.** Click **看对象并打开审核**. Each card has a
   persistent AV code, private working name, current whole-group gallery and
   direct links for grouping, fields and relationships. Name unfamiliar groups
   before reviewing. In Review, the object companion explains that **belongs**
   keeps the photo in the displayed group; **remove** moves it out; **reassign**
   shows each target's name/code/photos beside its frozen native choice;
   **split** creates another group; **unresolved** records uncertainty. Field
   decisions are accepted/corrected/rejected/deferred independently of grouping.
   Keep uncertainty markers such as 传, 疑 and missing characters. Submit in
   Review, return with **工作台**, then click **检查并收集本批决定**. The
   workspace shows submitted and collected counts separately. Collection
   formally writes immutable human decisions locally; repeat collection is a
   no-op.
3. **Prepare a local Draft.** Missing-review links lead to the exact current
   tasks, including reassigned photos' originating group. After required
   review/collection, click **选择草稿内容** and explicitly choose the object,
   public title, supported kind, individual public photos, order and one
   representative. Evidence/label photos start unchecked. Confirm to generate
   the validated offline publication package; originals and private evidence
   remain separate. Real materials remain offline. Preparing a package does not
   approve or Publish anything.

The top toolbar provides **工作台**, **对象资料库**, **返回** and **刷新**. The
main Review link is limited to the current batch; the library separately shows
retained objects. **测试资料与其他操作** contains the clearly marked Synthetic
fixture, a Synthetic results view that preserves the selected folder, explicit
current-batch Review renewal and Synthetic Development validation. Renewal
creates new proposal/task versions while preserving collected decisions. Editing
an already collected annotation cannot silently replace it. Development receipts
distinguish PASS, PARTIAL and failure; partial progress is retained for retry.

Closing the window retains the running task and data. **退出 ArtVenn…** asks
whether to stop this task's analysis, helper, Label Studio and owned Development
services. Confirmed Quit preserves photos, model files, databases, decisions,
packages, receipts and the marked database container/volume. Double-click the
App again to continue. Other tasks' services are not stopped.

This version refuses a changed photo list or changed file contents in an already
analyzed folder before creating new objects. Put additional photos into a new
small batch folder; previous objects remain in the library. Automatic stable
identity across added or independently selected batches is not implemented. New
human reassignment can associate a photo with an existing local object.

Unsupported formal kinds such as `seal_carving` must remain local; never select
`calligraphy` to disguise them. The first version has no automatic cross-session
identity matching or existing-Catalog similarity search. A controlled human
reassignment can associate an image with an existing local object. Synthetic
success does not establish historical accuracy or recognition accuracy on real
inscriptions.

The directory distinguishes Synthetic test objects from selected local material.
An object containing any non-synthetic-origin gallery member cannot appear in
the Synthetic filter, even after a human reassignment. An already collected
human grouping remains the current directory gallery when a new AI candidate
awaits review; removed photos do not reappear merely because review is renewed.
The frozen native task still shows its original candidate/evidence images.

The companion resolves both native wrapper and actual editor task identity,
waits for native loading to finish, and discards delayed responses after task or
project changes. Missing metadata leaves native annotation controls usable.
Metadata requires loopback access, native authentication and project permission;
the helper's rename action retains its local-session and CSRF checks.

## Runtime and isolation

The private root is
`~/Developer/artifacts/moya-inscriptions-web/ai-curation-v1/runtime/`, on
internal local storage. `state/`, `label-studio/`, `served-previews/photos/`,
`derivatives/`, `receipts/`, `logs/`, `config/`, `models/`, `development/` and
the two Python environments are separate. Source folders are references only.
Private configuration is owner-only; credentials never appear in argv, the UI,
URLs or repository files. Serving exposes generated previews only, checks
containment/symlinks and requires a local session or LS login. All services bind
loopback.

Native Python 3.12.9 environments use Label Studio 1.23.2 / SDK 2.1.2 / Pillow
12.3.0 / rawpy 0.27.1 (LibRaw 0.22.1) and MLX-VLM 0.7.4 / MLX 0.32.3 /
Transformers 5.17.0 / Hugging Face Hub 1.6.0. Exact transitive hashes are in the
two `requirements.lock` files. The one model is
[Qwen3-VL-4B-Instruct-4bit](https://huggingface.co/mlx-community/Qwen3-VL-4B-Instruct-4bit),
fixed revision `2fd8dacbdb8f1e54b8c005f081ec5bf79c56376b`; the checked manifest
records Apache-2.0 and the exact weight SHA/size. Inference uses native MLX,
offline model files, one load per run, segment deadlines, cancellation and
durable checkpoints. No cloud fallback or API fees.

Label Studio analytics/version reporting and both Sentry settings are disabled
using the installed upstream settings. Model downloads are anonymous inbound
public artifacts. Bounded actual inference/service socket samples observed no
non-loopback connection; these samples do not prove complete absence of all
network behavior.

Only PostgreSQL uses an already installed `postgres:18.4` Docker image. Native
CMS uses existing Next/Payload and repository migrations in a fresh task-marked
synthetic database, separate retained volume, unique container labels and
dynamic loopback ports. Restart verifies exact process birth, container/volume
labels, mount, port, protected configuration and actual DB marker. It does not
re-bootstrap, migrate Production, delete anything or change global runtimes.

## Reproducible setup and diagnostics

The optional double-click **Setup ArtVenn Curation.command** offers status
checking or first setup. It uses already installed uv/Python, creates only
absent task environments from hashed locks, and downloads only the absent pinned
model. Existing environments must match the complete lock inventory;
drift/incomplete files are preserved and refused. It has no
repair/delete/global-install path. A setup readiness result is separate from
actual inference and Draft validation.

Developer status/start/stop entries are `service.py status|start|stop`; the
daily UI provides these actions. Python tests use
`runtime/ls-env/bin/python -m unittest discover -s scripts/curation -p 'test_*.py'`.
Offline Node adapter/lifecycle tests run with the repository's mise Node and
existing built contract dependencies. The full CMS acceptance suite includes
Owner approval/Publish and was intentionally not run for this bounded task.

Sony ARW and the other supported RAW extensions use an isolated native LibRaw
child with a 60-second per-photo deadline. The named preview recipe uses camera
white balance, half-size development, explicit BT.709 gamma, no automatic
brightness and the RAW orientation exactly once. It does not claim to reproduce
the camera JPEG colors. Review previews have a 1536-pixel maximum edge; the
current public JPEG derivative is separately generated from that normalized
review preview. Original full-resolution RAW remains unchanged. Decoder, LibRaw,
recipe, orientation, source/preview hashes and derivative lineage are retained
locally. Failed assets can retry with the same identity; the previous failure is
retained. Ready reviewed preview bytes are reused. Completed model windows keep
their membership, and newly recovered photos append new windows. HEIC and other
formats still depend on the installed decoder; support is not claimed without an
actual successful conversion.

If a photo cannot be decoded, the menu lists `UNSUPPORTED_OR_CORRUPT_MEDIA`; no
successful conversion is claimed. Unplugged/changed source folders fail
preparation or analysis. Invalid model JSON, absent Evidence and unrecognized
IDs fail validation without repair. A timeout or cancellation retains completed
model segments. Partial Draft/media receipts are retained and replayed with
stable IDs; conflicting revisions require a new current mapping/review, never a
force overwrite. A port occupied by another task is reported and left untouched.

See [validation report](validation-report.md) and the local private receipts for
the actual completed gates and original failures.

## Scoped photo correction and offline handoff (r4)

In the existing local App, open the workspace, then the object directory. Select
only the candidate groups you intend to review and choose **Start this review**
(开始本次整理). The page freezes the exact groups and unique photos. It does not
select or combine the entire folder. A physical inscription has one object;
overview, detail, label and context are independent photo roles.

1. Check the target object's visible code/name and every photo. Assign
   individual photos, or explicitly choose that the selected photos depict the
   same object. A removed assignment retains the original source file. Empty
   source groups remain as history and indicate the destination code.
2. Confirm a title and object description. Optional person/date fields may be
   entered, rejected or deferred. Existing candidate fields require an explicit
   disposition; deferred fields block package preparation. Manual additions use
   `human-entry/v1`, not a model inference claim.
3. **Save entries for later** stores only a private form. **Confirm and save
   decisions** requires the page acknowledgement, submits versioned native LS
   annotations and collects exactly those tasks. LS supplies annotation IDs and
   the authenticated reviewer. The UI distinguishes saved entries, pending
   submission/collection and collected decisions. Partial work remains
   resumable; an uncertain POST is reconciled by readback rather than blindly
   repeated.
4. Select the draft's formal Catalog type, photos, order and one representative
   image. **Prepare offline package** uses the existing adapter's real offline
   contract and media validation. Saved selections remain visible on reopening.
   This does not transfer real material or create a remote Draft.

The workspace's **Continue this review** entry reopens the saved form. Native
Review records remain accessible from that page. Changed proposal/decision
versions invalidate an old form or completed package-preparation view; start a
new scoped review from current object cards. Previous annotations and decisions
are retained. Package local annotations include selected photo roles, incoming
reassignment decisions, scoped annotation snapshots and manual field provenance.

This is a bounded daily workflow improvement. Cross-batch identity stability,
incremental catalog consolidation, full-resolution publication quality and
Algorithm Dataset export remain a next-stage prerequisite for large-scale use.
