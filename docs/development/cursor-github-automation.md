# Cursor PR review and CI diagnosis

## Current automatic operation (Issue215 r10)

The Owner authorized recurring analysis on 2026-10-06. Enable
`CURSOR_AUTOMATION_ENABLED=true` after the reviewed workflow is installed on
`main`. PR opened/reopened/synchronize/ready events cover same-repository PRs,
including stacked bases. Canonical `CI` completion covers PR, manual-CI and push
runs; a merge-to-main notification records status and the postmerge CI supplies
integration evidence. Closing an unmerged PR does not invoke Cursor.

Host scripts resolve the PR, pin installed main, serialize jobs per PR and keep
one bot-owned durable ledger keyed by repository/PR/source/run/attempt/phase. PR
event aliases collapse to one source review. A surviving CI event can combine an
unprocessed review with its new failure evidence in one call; a surviving PR
alias reconciles the latest completed unprocessed CI from a bounded 20-run list.
Passing PR CI records status without re-review. Tree-identical postmerge success
reuses an accepted exact PR review; changed integration evidence receives its
own analysis. Failed/orphan claims suppress automatic retries, with incomplete
receipts. The ledger has a disclosed 100-record cap per PR; exhaustion stops
admission, rather than forgetting old calls. Cursor comments and its own
workflow are not triggers. GitHub's one-pending-job queue can coalesce events;
only the current source is eligible, and earlier superseded sources are not
retrospectively analyzed.

`CURSOR_MODEL` must be
`grok-4.7[context=500k,reasoning_effort=xhigh,fast=true]`. Each accepted
inference checks the fresh CLI selection, including `maxMode=true`. English is
preferred, not an answer-rejection condition. There is no application reasoning
timeout: NDJSON assistant/tool/result events and connection/process/error state
are recorded without exposing their text. Silence means activity unconfirmed;
process alive does not prove thinking. The hosted job has GitHub's 360-minute
ceiling, including preparation/retention; no unlimited-runtime promise, hidden
retry, model substitution or paid fallback is made. On-Demand stays off under
the existing account policy; runtime selection is not a billing/provider
attestation.

**Public repository Actions artifacts are repository-readable, not private
handoff storage.** Automatic transport contains only sanitized receipts,
validated results/citations and progress counters. Raw collected logs/context,
agent configuration and full private local evidence are excluded. A targeted
question must set `scope=repository-question-v1` and
`remoteEvidenceApproved=true`, with exact repository/PR/source/tree/canonical CI
run/attempt/workflow/base plus the three sanitized wrapper hashes. Only that
approved sanitized projection enters the compressed 60-KiB transport and
repository-readable continuation cache. Core credentials and nonpublic local
paths/authorizing URLs are rejected; full local context remains in existing
private artifact storage. No source/log content is treated as instructions.

A question runs through `operation=dialogue` on trusted `main`, with `candidate`
equal to the installed main SHA, a new 24-hex dialogue ID, round1,
`previousRun=null`, bounded English question, up to24 cache selectors and the
verified compressed sanitized wrappers. Preparation validates current
source/tree/CI and claims a question digest in the same per-PR ledger.
Follow-ups use retained exact structured context, require `needs_evidence` and
new literal coverage, and stop at three rounds. A genuinely new question gets a
new identity; old ANSWERED/failed histories are never rewritten or silently
renewed. Evidence is at most2MiB before compression, each selected record24K,
final prompt120K. Automatic collection retains the
existing80-file/36K-log/180K-context limits; literal citation records duplicate
sanitized subsets under a360K whole-packet cap. No arbitrary shell, native
observation or production tool is granted.

Local Codex owns source edits, necessary focused checks, submission and precise
questions. GitHub scripts execute existing CI and perform retrieval/cache/status
work. Cursor analyzes supplied originals and returns findings, exact excerpts,
uncertainty and next verification. The original media writer receives that
validated answer and edit-relevant code; it does not reread bulk logs. Human PR
comments are concise sanitized summaries; full approved machine results remain
separate. Workflow success, answer acceptance and citation validation are three
separate outcomes. No automatic product merge/deployment is implemented.

Automatic collection also supplies bounded numbered current-source excerpts
beside changed hunks when a complete file exceeds24K, and canonical CI job/step
conclusions for successful postmerge runs. Excerpts retain exact source/blob
identity; entire files outside those windows remain missing. Original source is
limited to1MiB per file and optional retrieval stops after2MiB declared bytes;
the last response can cross that threshold by at most one bounded file. Existing
24K selected-source/180K packet/360K duplicate-citation limits remain. Job/step
success never claims an individual testcase result without that native record.

A structurally valid, runtime-confirmed, exactly cited partial reply is accepted
as usable report data with status `PARTIAL`, `coverageComplete=false` and
`cleanVerdict=false`. Its claim stays `incomplete`, so it is neither retried nor
reused as a complete review. Rejected transport/model/schema/citation responses
remain unaccepted. Older receipts are not retroactively changed or accepted.

The remaining sections preserve the initial setup and earlier single-case
experiments as historical context. Their manual/candidate and finite reasoning
windows are superseded for new authorized r10 operation, not retroactively
changed in historical evidence.

Task: [#215](https://github.com/junguangjia/moya-inscriptions-web/issues/215).

The `Cursor review` GitHub Actions workflow runs the official Cursor CLI on a
standard Ubuntu hosted runner. It reviews same-repository pull requests and
diagnoses failed PR runs of the existing `CI` workflow. A deterministic script
updates one PR comment for review and one for CI diagnosis. Each comment names
the commit, evidence gaps, actionable findings, smallest suggested repair and
relevant verification. Codex, Claude Code and the Owner can read these summaries
first and follow a CI link only when more evidence is needed.

## Basis and maturity

- [Cursor's official GitHub Actions guide](https://cursor.com/docs/cli/github-actions)
  recommends restricted autonomy: analysis is separate from publishing.
- The official
  [cursor-team-kit fix-ci workflow](https://github.com/cursor/plugins/blob/4e5b1cf2ccb0ea3716f08c8ee0a5856b5ab93536/cursor-team-kit/skills/fix-ci/SKILL.md)
  and
  [ci-watcher](https://github.com/cursor/plugins/blob/4e5b1cf2ccb0ea3716f08c8ee0a5856b5ab93536/cursor-team-kit/agents/ci-watcher.md)
  establish the failure-log → first actionable error → focused repair → concise
  status pattern. This integration implements collection and diagnosis, and
  leaves source changes to the existing authorized coding task.
- A public
  [community PR-review example](https://gist.github.com/adirkandel/b6561d64e20bc470050b5fa0f7d1bbe7)
  demonstrates CLI-triggered PR review. It is reference material, not an
  installed dependency or proof of reliability. Its agent-managed publication is
  not used.
- This repository's adapter is new code with automated boundary tests. The
  existence of an official pattern does not mean this exact integration has
  already passed a hosted, authenticated canary. Record that canary separately.

The Owner also selected
[Plate's Actions](https://github.com/udecode/plate/actions) as a reference. Its
[main CI](https://github.com/udecode/plate/blob/main/.github/workflows/ci.yml)
uses path filters, concurrency cancellation and package/build caching, while
[template CI](https://github.com/udecode/plate/blob/main/.github/workflows/ci-templates.yml)
has its own scope. Moya already has cumulative scope routing and library/pnpm
caches; this integration preserves them, shares a concurrency group for
automatic and manual review, and installs no application dependencies. Plate's
9-second
[release-PR run](https://github.com/udecode/plate/actions/runs/37224808131)
skipped actual checks, so it is not an ordinary-code validation benchmark. Its
direct-main pushes, non-frozen installs and commented-out browser tests are not
adopted. CodeQL and Dependabot remain distinct from AI review.

## One-time account setup

1. Keep **On-Demand Usage disabled** in the Cursor dashboard. This workflow
   cannot read or enforce an account billing switch. A model choice or a timeout
   alone does not enforce zero extra cost.
2. Open [Cursor API settings](https://cursor.com/dashboard/api). Under **User
   API Keys**, select **Add** and name the key `moya-github-actions`. Use the
   personal Cursor key accepted by the CLI; no OpenAI/Anthropic provider key is
   needed.
3. Open the repository's **Settings → Secrets and variables → Actions → New
   repository secret**. Name it `CURSOR_API_KEY` and paste the value into
   Secret. Never place it in a PR, repository file, chat or screenshot.
4. Optional repository variable `CURSOR_MODEL` selects the CLI model ID. The
   default is `composer-2.5`, intended for the Cursor Models included pool.
   Check the model available to the account before changing it. There is no
   fallback to another model or paid service.
5. After this workflow is on `main`, open **Actions → Cursor review → Run
   workflow**, select `main`, and enter an open same-repository PR number.
   Confirm a revision-bound comment, a successful CLI analysis and the charge in
   **Included Usage**, with no on-demand charge. A skipped run or an
   `unavailable` report is not successful activation.

[Cursor usage pools](https://cursor.com/docs/models-and-pricing) and
[on-demand billing](https://cursor.com/help/account-and-billing/overages) remain
account-controlled. Creating a key does not itself purchase a new plan. This
workflow uses the CLI, not the separate Cloud Agent API, Bugbot Autofix or
native Cursor Automations. It does not enable on-demand usage. Exhaustion or
authentication/model failure produces `unavailable` without an automatic retry.

The repository is public at setup time. Standard GitHub-hosted runners for
public repositories are free under
[GitHub's Actions billing rules](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
Private repositories use plan allowances and can incur overages; larger runners
have separate charges. This workflow uses `ubuntu-24.04`, installs no paid
GitHub feature, and needs no GitHub PAT or Copilot subscription. Account limits,
concurrency and service availability still apply.

## Viewing runs, choosing models and coding-agent handoff

Use
[Actions → Cursor review](https://github.com/junguangjia/moya-inscriptions-web/actions/workflows/cursor-review.yml)
for queued/running/completed tasks, timing, cancellation and manual dispatch.
The result is the `Cursor PR review` or `Cursor CI diagnosis` comment on the
corresponding PR. These are GitHub-hosted CLI tasks; the separate native Cursor
Automation named `Moya PR review and CI feedback` is not required and should
remain inactive to avoid duplicate reviews.

Set the repository Actions **variable** `CURSOR_MODEL` in
[Settings → Secrets and variables → Actions → Variables](https://github.com/junguangjia/moya-inscriptions-web/settings/variables/actions).
The default is `composer-2.5`. Use a CLI model ID available to the account; a
Cursor desktop/chat or native-Automation model selector does not change this
workflow. The value applies to subsequent runs. Other models may use a different
included pool/rate; retain disabled on-demand usage. An unavailable model fails
visibly without a paid fallback.

The Owner's selected configuration is Grok 4.7, 500K context, Extra High effort
and Fast enabled. The verified `CURSOR_MODEL` spelling is:

```text
grok-4.7[context=500k,reasoning_effort=xhigh,fast=true]
```

The pinned official CLI supports bracket overrides on `--model`. After each
successful inference, the workflow checks the CLI's persisted model selection
against all requested parameters before accepting the response. A missing or
different selection produces `unavailable`, never an accepted downgraded review.
The PR summary includes the accepted model selection. This is runtime selection
verification, not independent proof of the provider's internal computation.

Grok 4.7's cloud model catalog exposes `reasoning_effort`, whereas some CLI
examples use the generic `effort` spelling. The two catalogs are not
interchangeable. The adapter accepts both spellings for comparison but sends the
configured selection unchanged; it rejects duplicate aliases. The account
metadata run
[37292550895](https://github.com/junguangjia/moya-inscriptions-web/actions/runs/37292550895)
listed the CLI's Grok 4.7 xhigh/Fast model and the cloud catalog's full
500K/xhigh/Fast variant. This is compatibility evidence, not a successful
inference or a billing receipt.

Actual hosted run
[37293174827](https://github.com/junguangjia/moya-inscriptions-web/actions/runs/37293174827)
returned valid inference and passed the exact persisted model/parameter check.
Its
[PR214 comment](https://github.com/junguangjia/moya-inscriptions-web/pull/214#issuecomment-5992180782)
was `incomplete` because the old first/tail log excerpts missed failure bodies;
the workflow consequently failed after publishing. This was model acceptance,
not a clean CI diagnosis. New comments distinguish the configured identifier
from the effective model/parameters read from the fresh CLI configuration after
inference, including reported Max Mode. This does not prove provider internals,
exercise a 500K-token input, or establish the charge in Included Usage.
On-Demand off is Owner-confirmed; this integration cannot independently read
that switch or the account's per-run billing ledger. Historical rejection runs
retained only `CURSOR_MODEL_REJECTED`, not exact raw stderr; do not invent a
more precise historical error from the classification.

[Cursor's Grok 4.7 guide](https://prod.cursor.com/help/models-and-usage/grok-4-7)
documents Ultra access through the included Cursor Models pool, the 500K option,
four effort levels and Fast. Keep on-demand disabled. A
[reported local-SDK limitation](https://forum.cursor.com/t/grok-4-7-run-rejects-advertised-context-500k/172554/6)
means catalog availability alone is insufficient: verify this exact CLI setup
with a real hosted run before claiming it works. The bounded review packet is
unchanged; selecting 500K does not imply every large PR is fully covered.

For model compatibility diagnosis, manually run this workflow from `main` with
`operation=inspect-models`; no PR number is needed. This metadata-only operation
works while automatic review is paused. It invokes the pinned CLI's
`--list-models` and the official Cloud Agent API's `GET /v1/models`, then
reports only CLI Grok IDs and Grok 4.7 context/effort/Fast values in the Actions
summary. It starts no inference or cloud agent and posts no PR comment. These
two catalogs describe different runtimes; neither alone proves an inference will
succeed. Errors, account details, descriptions and credentials are not
published.

The root `AGENTS.md` now contains the evidence-reuse rule; `CLAUDE.md` imports
that shared authority. Codex and Claude Code use the rule with whichever model
the coding session selects. New sessions need an updated checkout, and existing
sessions must explicitly reread changed instructions. This workflow does not
send chat messages. The shared rule means:

> Before reviewing a PR or diagnosing CI, read the latest Cursor PR review and
> Cursor CI diagnosis comments, compare their commit SHA (and CI run/attempt)
> with the current PR and checks, and inspect their assessment and omissions.
> Reuse current, supported findings for the covered scope. Do not repeat a full
> review or reread every CI log solely to restate that summary. Inspect targeted
> source/logs when needed to verify a finding; fill only missing, stale or
> incomplete coverage. Treat model output as evidence to assess, not authority.
> After a fix, run the relevant existing checks and require fresh evidence for
> the new commit. Preserve required CI, independent review and merge rules.

This documentation does not automatically install a global agent instruction.
The separate Cursor summary never waives mandatory repository review or testing.

## Event and permission boundary

For an explicitly requested diagnosis of an existing failed CI run, use manual
`operation=diagnose-ci` from `main`. Supply `pr`, `ci_run`, `ci_attempt`,
`expected_head` (40-character SHA), and `base_ref` (the current PR base branch).
This supports same-repository stacked Draft PRs and CI runs started with
`workflow_dispatch`, without changing the PR base, marking it Ready or rerunning
CI. It only reads existing evidence and updates the separate CI diagnosis
comment. The run must belong to the canonical `CI` workflow, have a
failed/timed-out final result, and match the repository, associated PR, current
head, branch and exact attempt. Base branch/SHA and run freshness are rechecked
before inference and publication. Changed or mismatched targets are skipped.
This explicit manual operation can run while automatic reviews are paused; it
preserves the same trusted-main checkout, isolated credentials, model
constraints and coverage limits.

If a diagnosis identifies missing product code that the failing E2E test does
not import, a follow-up manual diagnosis can supply `source_paths`: up to eight
comma-separated repository code paths, optionally `path:start-end` for a range
of at most 400 lines. The collector reads only that exact PR head, scans each
complete file before selecting text, and puts this requested context ahead of
unrelated patches. Full files or exact ranges must fit 32K characters each and
the existing 180K packet budget; oversized files require a narrower range and
are disclosed instead of silently reduced to their first lines. Missing source
or runtime evidence can still produce `incomplete`. This input does not run CI
or grant the model file, shell or GitHub access.

When already-saved native traces supply necessary timing observations, manual
diagnosis can also include `ci_evidence` JSON with `head`, numeric `runId` and
`attempt`, `provenance` (test/project/retry/call and timing semantics), and up
to eight observation strings. The exact tuple must match; the entire input is
scanned and capped at 8 KiB before parsing, and only those fields enter the
existing packet budget. These remain supplied observations, explicitly not
host-verified artifacts. No links or artifacts are fetched by this input.

An `incomplete` report may retain validated partial findings. If the model's
label conflicts with its finding count, the host preserves the validated content
as `incomplete` with a fixed warning. Schema, path, credential and exact model
checks still apply; an incomplete publication still fails the workflow and
cannot be treated as a clean review or complete causal diagnosis.

CI evidence prioritizes GitHub error annotations and assertion/timeout windows
inside failed steps, followed by the failed-step tail. Setup and post-job
cleanup cannot crowd failure bodies out of the bounded packet. Excerpts and
missing patches remain disclosed; insufficient evidence still produces
`incomplete`.

- `pull_request_target` triggers on open, reopen, update and ready-for-review;
  Draft PRs are included. Only open, same-repository PRs targeting `main`
  qualify. Forks are deliberately skipped and receive no Cursor secret.
- `workflow_run` considers only completed failed/timed-out PR runs of
  `.github/workflows/ci.yml` named `CI`. It resolves the exact current open PR,
  including when GitHub omits the PR list. Replaced attempts and old heads skip.
  A successful, cancelled, unrelated or main-push run does not invoke Cursor.
- The workflow checks out **main only**, with checkout credential persistence
  disabled. PR patches and immutable blobs are retrieved as data. It does not
  check out PR code, install PR dependencies, run PR hooks or load PR
  MCP/skills. Manual dispatches from a non-main ref are ignored by the trusted
  entry point.
- The bounded evidence is passed directly through stdin. The agent runs in a
  fresh data directory with isolated Cursor configuration, Ask mode and explicit
  file-read/shell/write/web/MCP denial. Its environment has the Cursor key but
  no GitHub or Actions runtime token. CLI permissions are defense in depth, not
  an OS sandbox. Only trusted account administrators should change this
  workflow, its collector, or the pinned CLI.
- GitHub writes are confined to the publisher step with `pull-requests: write`;
  repository contents and Actions access stay read-only. No source push,
  automatic fix, approval, merge, settings change or independent-review waiver.
- The fresh hosted checkout provisions the existing credential scanner through
  its controlled installer using the repository's approved anonymous identity.
  Preparation and publication share a single 120-second process deadline.
- The CLI archive is pinned to `2026.10.01-e373342` and checked against SHA-256
  before extraction. Updates need an explicit code review and a fresh canary.

GitHub documents the privileged-event boundary in its
[workflow event reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target).

## Coverage, results and limits

Review input includes up to 80 changed-file patches and small complete changed
source files, bounded to about 180,000 characters total. CI diagnosis includes
up to six failed jobs and 36,000 log characters, prioritizing error windows
inside failed steps and the failed-step tail when truncated. Exact-head source
enrichment allows eight primary files and four direct helpers, 24 lookups, 256
KiB per file and 36,000 additional serialized characters within the same overall
packet cap. Binary files, oversized/missing patches and unavailable context are
reported explicitly. This is advisory change review, not a complete repository
security audit or a replacement for secret scanning, dependency analysis or CI.

Within the first 100 file entries returned by GitHub, executable source, tests,
migrations and configuration take priority over prose and generated lockfiles.
Smaller patches are allocated first within each group, then optional full source
uses the remaining space. Added-file patches are not duplicated as full source.
Every skipped patch is disclosed; files beyond the API listing are counted as
missing. Oversized or missing patches still prevent a complete review. Empty CI
logs are normal for PR review; failure logs are required only for CI diagnosis.

The existing core-credential rules scan the exact selected content before model
input and again before publication. A finding withholds the complete affected
file/log; only a location/category is reported. CLI stdout/stderr and raw logs
are never printed or uploaded as artifacts. The scanner has its documented
limits; this is not a guarantee of detecting deliberately concealed credentials.

`findings` means supported issues were found, not that every file was covered.
`no_findings` means no supported issue in the supplied scope. Evidence omissions
prevent a clean verdict. `incomplete` and `unavailable` fail this advisory
workflow after publishing a concise status; neither changes existing required
checks. Cursor does not run tests, so a review comment cannot prove CI passed.

The Owner removed arbitrary inference-time cutoffs for future authorized calls.
The official CLI now emits incremental NDJSON; deterministic scripts retain only
safe progress metadata and the scanned terminal answer. GitHub-hosted jobs have
a six-hour platform ceiling including preparation and retention. Automatic and
manual review events share a PR concurrency group. CI diagnosis uses the same
commit group for manual and automatic requests. A freshness step immediately
before inference checks the PR head and CI run attempt again after installation.
Publication rechecks the PR head; the commit is always visible in the report.
Review and diagnosis have separate comments so one does not overwrite the other.
Older comments remain visibly bound to their old commit until replaced; readers
must compare that SHA to the PR's current head.

To pause automatic reviews, set repository variable
`CURSOR_AUTOMATION_ENABLED=false`. Explicit metadata inspection and manual CI
diagnosis remain available. To resume, remove it or set it to `true`. The
advisory workflow is not a required check. To revoke access, delete the
repository secret and revoke this dedicated key in Cursor. No local machine or
background app needs to remain running.

## Verification

Run `node --test scripts/cursor-review.test.mjs` for eligibility, stale runs,
credential withholding, environment restrictions, report validation, stdin
transport, missing-key/failure handling and fresh-checkout publication with the
real controlled scanner and mocked GitHub transport. Run the existing
`verify-task.mjs` entry for cumulative applicable tooling checks. Tests do not
consume Cursor usage or exercise a live key.

## Bounded evidence dialogue (Draft evaluation only)

The Owner-approved enhancement uses the pinned official CLI with fresh isolated
invocations and validated prior-round replay. It installs no SDK/ACP and enables
no automatic review. The manual operation=dialogue route is restricted to branch
codex/cursor-bounded-dialogue and its exact open Draft candidate PR/SHA. All
ordinary routes retain trusted-main checks. Do not merge merely to evaluate.

The allowlist in scripts/cursor-dialogue.mjs separates workflow327712419 at
4d819e1af7c60f13f5ced38cb7868b26b3444817, diagnostic37347927743/attempt1 and
immutable
source7a2cba05b8596579fd1fcb6a58ba6ba9c018e8f1/treeb82796ec4f2a7e226ca4bae1eeca9a2d35ee286f.
Future targets require a reviewed scope change; canonical CI admission is
unchanged. Media source/tests/CI and remaining repair authority stay with the
original writer.

The cache command accepts a private JSON map of preparation, feedback and
execution paths to already-downloaded JSON originals. It verifies pinned SHA-256
hashes, scans raw and decoded text, checks native identity and stores one
private originals.json. Subsequent reads use this cache; no original CI
log/artifact download occurs. The select command takes file/pointer selectors
with optional start/count (array windows of at most32 elements). It emits
faithful original JSON values, original hash, selector, content hash and stable
ID, printing only index metadata. The complete original snapshot is compressed
for initial transport and reverified by the hosted job. Follow-ups restore it
from the preceding exact candidate/run artifact, never the original CI. Only
these JSON formats are admitted; arbitrary URLs, archives, images and automatic
discovery of other artifacts are unsupported.

The dialogue_request JSON fields are target, candidate, candidatePR, dialogueId
(24 hex), round, startedAt (epoch milliseconds), previousRun (null for round1),
question, selectors, optional sourcePaths, and originals (encoded snapshot for
round1 only). It permits one initial question plus at most two follow-ups: no
fixed model-reasoning cutoff (elapsed time remains recorded), a disclosed
six-hour GitHub-hosted job ceiling,60KiB transport,120K serialized prompt and24K
per selected record. Duplicate attempts/rounds, stale identity, errors, no new
follow-up evidence and budget exhaustion stop incomplete. A follow-up requires
an exact previous needs_evidence record. No hidden retry, paid fallback or model
substitution exists. Round JSON, report and verified cache are retained for
seven days.

English is preferred, not required, in dialogue and legacy reports. No prompt
requires Chinese. Useful evidence-backed responses are not rejected solely for
language, and no model call is made just to translate them. Validators still
require nonempty string fields and the existing length limits; dialogue failures
distinguish INVALID_NARRATIVE from NARRATIVE_TOO_LONG. Literal citation.quote
keeps its original form. Every finding cites an exact substring of a supplied
original record. Exact quote validation does not establish that the model's
inference is correct. The earlier ENGLISH_REQUIRED evaluation remains
incomplete; discarded output cannot be reconstructed or retroactively accepted
by this change.

Codex reads the answer, citations, uncertainty and edit-relevant code. It asks a
targeted question and selects missing evidence; it should not reread all cached
phase events or bulk logs to restate the answer. Exact-head status and
independent review remain metadata/gates. Incomplete/capped capture and
receive-time intervals must not become native timing, media PASS or authority to
replay tests.

Measure original reads/downloads, cache transfers, model calls, inference/wall
time, numeric usage only if exposed, citation spot-checks and actual writer
adoption. Unrecorded historical baseline counts remain unknown. One case cannot
establish token savings or general causal accuracy. On-Demand remains off; model
selection and usage fields do not constitute a per-run billing receipt.

Follow-up novelty is computed from original JSON leaf locations and values.
Overlapping parent/child selectors or longer requested array windows cannot
reset coverage. The initial run timestamp is read from GitHub and retained
unchanged across rounds; caller timestamps cannot extend the wall limit.

## Explicit interruption resumption and response retention (r7)

The Owner resumed this exact task at 2026-10-05 18:39 UTC. The original dialogue
`ffd4a715a80589390dea6007` started at 18:04:58 UTC; its 1800-second window
expired and is not relabeled. One narrowly pinned resumption admits round 2 from
the hash-verified retained record of run 37353258884. That failed round and its
358385ms/one-call cost remain unchanged. At most two calls and 541615ms
aggregate inference remain; the per-call limit stays 360000ms.

Requests use `resumption=owner-2026-10-05T18:39Z`, the original `startedAt`,
round 2, its exact `previousRun`, `originals`, and a gzip/base64 `resumeRecord`
of the already-downloaded `round.json`. The helper verifies its pinned SHA-256
and live prior-run metadata. It downloads neither the original CI artifacts nor
the cached prior record. GitHub's round-2 admission timestamp starts one
explicit resume interval of at most 900 seconds, capped at 19:39 UTC. The
interval and old elapsed wall time are recorded separately. Round 3 must carry
the unchanged `resumeAdmittedAt`, restore its exact predecessor, and supply new
evidence after `needs_evidence`. Other errors remain terminal; this is not a
general retry switch, count reset or permission expansion.

Dialogue output is now retained as `model-response.json` before answer
acceptance. The bounded body is scanned, including decoded values and escaped
credential forms. A credential-bearing string or key is wholly redacted;
redacted output cannot pass as an accepted answer. Only the scanned artifact is
stored/uploaded for seven days, never raw stderr or arbitrary transport fields.
Malformed but safe responses remain inspectable. Retention limits and scanning
failure can still prevent retaining unsafe/unbounded content.

Missing body, wrong body type, invalid JSON/schema, missing/empty narrative,
overlength narrative and unsafe output have separate categories. Narrative
failures retain only safe field paths, issue categories and lengths. Available
runtime-selection confirmation and numeric usage are retained independently of
answer validity. A retained response, model selection or usage value is not
diagnostic acceptance or a billing receipt. The old discarded answer remains
unrecoverable. These retention changes apply to the bounded dialogue path.

## Prospective waiting policy and exact-run analysis

The new Owner-authorized diagnosis targets CI37394447844/attempt1 at source
d9d9b5756a92feb5d446c4c84fd7f77f3a5d2618. Earlier answered/timeout records and
their exhausted three-call experiment remain historical. Each newly authorized
question has its own explicit invocation ledger; no automatic retry or implicit
reuse/reset of an old allowance occurs. This diagnosis authorizes one call and
advice only, not another media repair or required-CI submission.

Official stream-json assistant deltas and permitted tool start/completion events
are observable activity; init or process-alive alone are not. Additional event
categories can occur in the pinned CLI; their text is not retained or used to
verify hidden reasoning. Silence is activity-unconfirmed, not proof of a stall
and not a reason to abort at an arbitrary elapsed time. Scripts retain terminal
result/error, output-resource limits, exact model/identity checks and no paid
fallback. No additional tools are enabled for monitoring. See
[Cursor output formats](https://cursor.com/docs/cli/reference/output-format) and
[GitHub Actions limits](https://docs.github.com/en/actions/reference/limits).

Each NDJSON line and retained terminal result is bounded to256KiB; stderr stays
bounded to64KiB. The complete stream is counted and hashed incrementally rather
than buffered or capped as one final answer, so prompt echoes and partial-event
envelopes do not consume the answer allowance. Malformed events or progress
retention failures stop only the owned child and return a safe terminal category
with any retention gap disclosed.

Complete questions, scanned answers and native citation/projection identities
remain private. The public PR shows one concise human summary of observations,
unknown causes, actual writer adoption and the next authorized action or
blocker, with public SHA/run links. No raw artifacts, private paths or account
details are published. Cursor recommendations never authorize repairs or test
replays.
