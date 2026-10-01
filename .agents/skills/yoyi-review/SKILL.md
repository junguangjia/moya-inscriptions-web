---
name: yoyi-review
description:
  Independently review one ArtVenn / Yoyi task against its Issue specification,
  the actual diff at the exact head SHA, applicable evidence and review threads.
  Reports blockers with location, consequence and evidence and keeps suggestions
  separate. Use when asked to review a PR, a task branch or a handoff for
  correctness before delivery (审查 / review).
---

# yoyi-review

A reviewer reads; it does not write source. Review binds a task ID, a PR, an
exact head SHA and the actual impact, nothing else.

## Invocation

```text
yoyi-review <PR number | branch | task ID> [--head <sha>]
```

Codex: `$yoyi-review ...`. Claude Code: `/yoyi-review ...`.

## Inputs to inspect, in this order

1. The task record: the Issue at its latest revision (goal, non-goals, scope,
   preserved behavior, acceptance criteria, delivery stop) or the formal
   specification it links.
2. The exact head: `gh pr view <n> --json headRefOid,baseRefName,isDraft` and
   `git diff <base>...<head> --stat`; state the SHA you reviewed. A later commit
   requires reviewing its delta and integration impact and binding the final
   decision to the new HEAD; retain the review of unchanged parts.
3. The actual task diff, or the new delta after an earlier review, file by file
   against the approved scope: paths outside the scope, deletions, both sides of
   renames, lockfile, migrations, Contracts, CI and instruction files.
4. Applicable evidence: CI check runs for that head, the task's private
   validation `summary.json` when the writer shared its path, and whether the
   evidence applies to the reviewed candidate. Required CI must match that
   candidate; reuse prior review and acceptance only under the final integration
   rules in `docs/development/task-workflow.md`. Do not relabel an earlier run
   as a new execution. Feedback-mode evidence labeled
   `FEEDBACK ONLY — NOT FULL ACCEPTANCE` is an intermediate preview only; it
   does not satisfy complete task validation or permission to merge.
5. Review threads and the PR template sections; Owner gates that apply (visual
   or real-device acceptance, directional decisions, Production authority).

## What the reviewer must not do

- Edit, format, generate or test-write in the writer's worktree. If a
  reproduction needs a checkout, use a separate review worktree and separate
  output directory; hand findings back to the writer for fixes.
- Reopen settled design merely because another implementation is possible.
- Infer delivery authority beyond what the task record says (see "Delivery after
  review"). Production authority is never inferred.
- Poll unrelated PRs, start review-of-review loops or repeat unchanged full
  suites.

## Delivery after review

Three cases, decided by the task record, never by the reviewer's opinion of the
code alone:

- **Ordinary machine-verifiable task.** The record names no delivery limit, or
  names review-and-merge. When the decision is "approve", every applicable check
  passes for the reviewed head and no Owner gate is pending, the reviewer
  completes delivery: `gh pr ready <n>`, then
  `gh pr merge <n> --squash --match-head-commit <reviewed sha>`, then
  merged-head verification (`gh pr view`, the `main` CI run, the task record).
  The tool's confirmation prompt for those two commands is the native consent
  step, not a new policy question; it needs no further Owner approval. A head
  newer than the reviewed one is never merged.
- **Task limited to Draft.** The record says so (a rollout checkpoint, a pending
  Owner acceptance, a dependency). Report and stop at Draft; only a recorded
  Owner decision changes that.
- **Production, remote settings or destructive operations.** Never part of
  review delivery, whatever the record says about merging.

The implementing session does not review or deliver its own change; a separate
session or context does. Posting the report as a formal `gh pr review` asks for
native confirmation, and neither a review nor a comment is new Owner authority
unless it records an explicit Owner instruction.

## Report format

```text
Reviewed: <PR> at <head sha>; base <sha>; task <id> r<n>
Blockers (must fix before delivery):
  - <path:line> — what is wrong — consequence — evidence
Suggestions (non-blocking): ...
Scope: within approved paths | deviations: ...
Evidence: CI <result for head> | private summary <PASS/FAIL/NOT TESTED> | Owner gates: <applicable / satisfied / pending>
Decision: approve for the recorded delivery stop | changes requested | STOPPED — OWNER DECISION REQUIRED
```

Blockers name a location, a consequence and the evidence that supports the
claim; a suspicion without evidence is a suggestion. Tool or model identity does
not make a review independent; a separate session that read the actual diff
does. Write the report to the PR as a review comment only when the task asks for
it; otherwise return it to the Owner.
