# Cursor PR review and CI diagnosis

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
and Fast enabled. Set `CURSOR_MODEL` to the exact CLI selection:

```text
grok-4.7[context=500k,effort=xhigh,fast=true]
```

The pinned official CLI supports bracket overrides on `--model`. After each
successful inference, the workflow checks the CLI's persisted model selection
against all requested parameters before accepting the response. A missing or
different selection produces `unavailable`, never an accepted downgraded review.
The PR summary includes the accepted model selection. This is runtime selection
verification, not independent proof of the provider's internal computation.

[Cursor's Grok 4.7 guide](https://prod.cursor.com/help/models-and-usage/grok-4-7)
documents Ultra access through the included Cursor Models pool, the 500K option,
four effort levels and Fast. Keep on-demand disabled. A
[reported local-SDK limitation](https://forum.cursor.com/t/grok-4-7-run-rejects-advertised-context-500k/172554/6)
means catalog availability alone is insufficient: verify this exact CLI setup
with a real hosted run before claiming it works. The bounded review packet is
unchanged; selecting 500K does not imply every large PR is fully covered.

Codex and Claude Code sessions are not automatically messaged by this workflow.
The following is an explicit handoff instruction to give a coding session:

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
up to six failed jobs and 36,000 log characters, retaining the start and end
when truncated. Binary files, oversized/missing patches and unavailable context
are reported explicitly. This is advisory change review, not a complete
repository security audit or a replacement for secret scanning, dependency
analysis or CI.

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

The inference deadline is seven minutes and the job ceiling is fifteen minutes.
Automatic and manual review events share a PR concurrency group. CI diagnosis
has its own branch group. A freshness step immediately before inference checks
the PR head and CI run attempt again after installation. Publication rechecks
the PR head; the commit is always visible in the report. Review and diagnosis
have separate comments so one does not overwrite the other. Older comments
remain visibly bound to their old commit until replaced; readers must compare
that SHA to the PR's current head.

To pause, set repository variable `CURSOR_AUTOMATION_ENABLED=false`. To resume,
remove it or set it to `true`. The advisory workflow is not a required check. To
revoke access, delete the repository secret and revoke this dedicated key in
Cursor. No local machine or background app needs to remain running.

## Verification

Run `node --test scripts/cursor-review.test.mjs` for eligibility, stale runs,
credential withholding, environment restrictions, report validation, stdin
transport, missing-key/failure handling and fresh-checkout publication with the
real controlled scanner and mocked GitHub transport. Run the existing
`verify-task.mjs` entry for cumulative applicable tooling checks. Tests do not
consume Cursor usage or exercise a live key.
