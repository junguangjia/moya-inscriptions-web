# Turborepo local cache: output boundary and retention

Turborepo 2.10 keeps one local cache for the main checkout and every linked Git
worktree ("using shared worktree cache"): each `turbo run` reads and writes
`<main checkout>/.turbo/cache`, whichever worktree it starts in. That cache is
regenerable build output only; deleting an archive costs a rebuild on the next
miss and never touches source, dependencies, databases or running services.

## What a build archive contains

`turbo.json` caches `build` outputs as `.next/**` and `dist/**` with these
exclusions:

- `!.next/cache/**` — the Next.js compiler cache (Turbopack/webpack). It is
  large, machine-specific and rebuilt on demand.
- `!.next/dev/**` — Next 16 development-server output that sits beside a
  production build when `next dev` is running in the same worktree.
- Admin only (`admin#build`): `!dist/cache/**` and `!dist/dev/**`, because a
  Development harness may point the Admin `distDir` at `dist` through
  `MOYA_ADMIN_DIST_DIR`.

Everything the built application needs stays cached: `.next/server`,
`.next/static`, `.next/standalone` (Admin), `BUILD_ID`, route and build
manifests, generated `.next/types`, and every package `dist`. A harness that
selects another Admin `distDir` (for example `.next-pcint-dev`) is outside both
globs and is never cached, which is the intended behavior for task-owned
development output.

Older task branches keep the previous outputs until they integrate `main`; their
archives are still bounded by the retention below.

## Retention policy (workstation policy, not a Turbo requirement)

Run from any worktree:

```sh
pnpm cache:prune                     # plan only: prints totals, deletes nothing
pnpm cache:prune -- plan --plan-file /path/private/plan.json
pnpm cache:prune -- apply --from-plan /path/private/plan.json [--max-gib 15]
```

`plan` keeps an archive group (`<hash>.tar.zst`, `-manifest.json`, `-meta.json`)
when any existing registered worktree that has `node_modules` currently produces
that task hash, when its meta records a worktree's current HEAD, or when it is
newer than `--keep-days` (default 3). Current task hashes come from two
read-only `turbo run build lint typecheck test --dry-run=json` runs per
worktree: one plain, and one with `MOYA_VERIFICATION_TOOLCHAIN` set as
`scripts/verify.mjs` sets it, because that variable is a Turbo `globalEnv` and
changes every hash. The value uses the Node that runs the command, so run it
with the same Node as verification (`mise exec -- pnpm cache:prune`).

Remaining groups are then kept newest first while they fit `--budget-gib`
(default 10), non-legacy before legacy, where legacy means the archive still
holds compiler or development cache paths. A group that does not fit is skipped,
so a smaller, older group can still fill the remainder. Metadata left without
its archive is deleted once it is older than the retention window.

The plan file records which worktrees were covered, which had no Turbo, and
which dry runs failed. A failed dry run, or `--skip-dry-run`, marks the plan
incomplete. Without `--plan-file`, `plan` only prints totals.

`apply` deletes exactly the reviewed plan. It refuses an incomplete plan without
`--allow-incomplete` and a plan older than 24 hours without `--allow-stale`. It
validates every planned name before deleting anything, skips a group whose
commit has become a worktree HEAD since planning, re-checks each file's inode,
device, size and mtime, skips anything changed, records unlink failures and
continues, and is idempotent. `--max-gib` stops after the group that crosses the
limit, so one batch can exceed it by one group. It exits non-zero if any file
failed. The plan and result files hold local paths and belong in the task's
private artifacts directory, not in Git.

The default budget is an engineering choice for this machine. If the kept set is
larger than the budget, the command keeps it and reports it; it never deletes a
kept group to reach the number.

## Safety limits

- The command only operates on a real `<root>/.turbo/cache` directory, only on
  the three recognized file names per hash, never follows symlinks, and never
  descends into other directories.
- It refuses to apply while a `turbo` process is running or the cache was
  written in the last 30 seconds. That is a best-effort check, not a lock:
  coordinate relevant build activity yourself and do not run `apply` during
  another task's verification.
- There is no scheduled, hook-triggered or automatic run. Review the plan at
  task closeout and apply it deliberately.
- `du` counts APFS clones and hard links in full; measure reclaimed space with
  `df` before and after, and expect snapshots or open files to delay it.
