---
name: yoyi-handoff
description:
  Save or resume one ArtVenn / Yoyi task's writer checkpoint so Codex and Claude
  Code can continue the same worktree, branch and PR without rediscovery, resets
  or lost work. `save` releases the writer role after writing a compact
  checkpoint; `resume` verifies live state and acquires it. Use for 交接 /
  handoff / 接手 / continue this task.
---

# yoyi-handoff

One mutable worktree has one writer at a time. The checkpoint is the private,
machine-specific record that transfers that role; the Issue stays the
specification and the PR stays the evidence.

## Invocation

```text
yoyi-handoff save   [task ID]
yoyi-handoff resume <task ID | worktree path>
```

Codex: `$yoyi-handoff ...`. Claude Code: `/yoyi-handoff ...`. The checkpoint
lives at `~/Developer/artifacts/moya-inscriptions-web/<task-id>/handoff.md`
(mode 0600, never tracked). Do not create a global HANDOFF file in the
repository.

## Checkpoint fields

```text
Task ID and scope: <id> r<n> · Apple / Web / Shared · allowed paths · non-goals
Worktree, branch, HEAD, PR: <path> · <branch> · <sha> · <PR or none>
Writer and handoff state: released <tool> <ISO time> | held by <tool> <ISO time>
Completed / remaining / waiting: ...
Staged / unstaged / untracked paths: (from git status --short)
Commands, results, elapsed execution and preparation time: ...
Evidence HEAD or worktree content fingerprint; private output paths: ...
Running task processes, ports and writable data/output ownership: ...
Next smallest action: ...
Restrictions, approvals and delivery stop: ...
```

## `save`

1. Stop every source-changing activity you started: formatters, generators,
   watch modes, tests that write files. Leave other tasks' processes alone.
2. Do not reset, stash, rebuild, commit or push merely to hand off. Staged stays
   staged, unstaged stays unstaged, untracked stays untracked.
3. Record the fields above from the real state (`git status --short`,
   `git rev-parse HEAD`, `gh pr view`), including the exact commands and their
   results, and the fingerprint of the evidence you are leaving behind.
4. Write the checkpoint with `Writer and handoff state: released <tool> <time>`
   and report its path to the Owner. Never include credentials or token-bearing
   links.

## `resume`

1. Read the checkpoint. If none exists (quota exhaustion, crash), reconstruct it
   read-only from the actual worktree, branch, PR and evidence before
   continuing; say so.
2. Verify the live state against it: same worktree path and branch; local HEAD
   and PR head each match their recorded values (a legitimate unpushed local
   commit is recorded and reconciled, never forced to equal the PR head);
   `git status --short` and the recorded content fingerprints match, not only
   the file names. Report any difference before writing; never reset, stash,
   recreate a branch or discard work to make the states look identical.
3. Confirm no competing writer: the checkpoint says `released` (or the previous
   writer's interruption was reconstructed read-only), no newer held claim or
   conflicting task update exists, and no source-changing or Git-writing process
   from the previous execution is still running. Readers are not writers: an
   idle editor, a terminal, a read-only reviewer or this incoming session
   opening the directory does not block the takeover, and an open file or
   process id alone is not proof of write activity. The checkpoint is advisory
   coordination, not a lock; when a material unexplained difference or an actual
   competing writer exists, pause writing and ask the smallest necessary
   question.
4. Acquire the role by rewriting
   `Writer and handoff state: held by <tool> <time>` and continue the same
   worktree, branch and PR. Never create another branch or worktree for a
   handoff.
5. Reuse valid evidence. Unchanged content keeps its results; a changed tool
   alone does not require a rerun. Previous-head CI or device acceptance is not
   current-head evidence.

## Boundaries

- Both tools read the shared rules explicitly after a handoff; a resumed session
  must not assume its startup prompt refreshed edited instructions.
- The checkpoint carries local facts only. Task-level decisions belong in the
  Issue; verification evidence in the PR and the private output directory.

## Task preparation and context shortcuts

Use the task-resource prepare/inspect and snapshot/verify commands documented in
`docs/development/task-workflow.md`. Pass the inspected private resource
manifest to `verify-task.mjs --resources`; use `--reuse-summary` only for its
individually validated deterministic checks. An unchanged context snapshot is
advisory within an already-read session. New sessions still read applicable
authority, verify the writer checkpoint and keep the established worktree and
Draft/Owner boundaries.
