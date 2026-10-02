# Contributing

Repository development is governed by the [Owner Development Constitution][1]
and the active [Owner amendments][2]. Read both before planning or changing
files. This guide supplies operational steps only. It cannot relax the
Constitution, an active amendment, frozen task scope, or an explicit Owner file
allowlist.

## Start a task

1. Record an explicit work reference: a GitHub Issue, a formal task ID, or
   another Owner-approved reference.
2. Freeze the goal, non-goals, allowed paths, and preserved behavior. Freeze a
   Behavior Matrix before implementation whenever user-visible behavior is in
   scope.
3. Sync `main`, record its exact `origin/main` base SHA, and create a
   short-lived task branch such as `feat/<reference>-<name>`,
   `fix/<reference>-<name>`, or `chore/<reference>-<name>`.
4. Check [module ownership][3]. Stop for an Owner decision only when the task
   crosses an unfrozen ownership or scope boundary, or triggers another active
   Owner-decision gate.

Never push directly to `main`. Never force-push the shared branch or rewrite
another contributor's history.

## Web local setup

Use the Node.js version in `.nvmrc` and the pnpm version pinned by the root
`package.json`:

```bash
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install --frozen-lockfile
```

Run `pnpm dev` only when the scoped work requires a local runtime.

## Validate the scoped change

Validation must be proportionate to the approved scope. Run formatting, lint,
typecheck, relevant automated tests, and a build whenever they apply to the
affected runtime, architecture, dependency, database, or user-visible surface.
Run PostgreSQL and E2E validation when those surfaces are affected. A
documentation-only change does not require unrelated runtime checks.

Do not hide, skip, or downgrade an applicable failure. Fix its cause and rerun
the affected validation. Record each applicable command and result in the PR.

### Test feedback loop

- Select applicable daily acceptance with
  `node scripts/verify-task.mjs --base origin/main --output <private-output>`;
  see the [shared task workflow](docs/development/task-workflow.md).
  `pnpm verify` is the existing Web entry, with dependencies and Chromium
  already installed; it is not an Apple-only or documentation-only prerequisite.
  Its formatting, lint, typecheck, ordinary tests, build and Formal browser
  smoke each run under an explicit validation profile from the
  [validation profiles amendment](docs/governance/amendments/2026-09-16-validation-profiles.md)
  (`--profile complete` selects the complete profile; an unflagged run keeps the
  quick 120-second cap). PostgreSQL runs when applicable to the selected Web
  validation, locally when `TEST_DATABASE_URL` is set and in its selected CI
  job.
- Browser-only daily check: `pnpm test:e2e:smoke`; five existing Formal cases,
  desktop Chromium, one worker, zero retries, first failure stops execution.
- During implementation, run relevant unit files and targeted browser cases for
  the behavior being changed. Preserve failures; do not automatically repeat an
  unchanged full suite. After complete task acceptance, upstream synchronization
  uses focused local checks under the shared workflow's final integration rules;
  the final candidate still requires cumulative CI. A timing investigation may
  request targeted repetition.
- Full cross-browser regression is explicit: `pnpm test:e2e`, or **CI → Run
  workflow** for the intended branch. It retains all five projects, three CI
  shards and the strict complete-report gate. It is not a daily prerequisite.
- A timeout is a failed profile ceiling, never a successful acceptance; the
  ceiling is not extended automatically. Daily smoke does not certify full
  cross-browser coverage or erase existing release failures. Scoped feature
  tests and Owner visual/device gates still apply.

See [the browser validation guide](tests/e2e/README.md) for deadlines, setup
exclusions, evidence locations, free test ports and the full regression policy.

## Pull request, review, and merge

- Open a Draft PR to `main` and complete the repository PR template.
- Keep commits and the diff scoped and reviewable. List every modified file and
  disclose deviations, risks, and deferred work.
- An independent reviewer must inspect the actual GitHub diff, exact head SHA,
  current remote state, applicable automated evidence, and review threads.
  Implementation-agent self-report and green CI alone are not sufficient.
- For a fully machine-verifiable task with no unresolved Owner gate, the
  independent review agent may mark the PR Ready, squash merge it while pinning
  the expected head SHA, and complete merged-head verification.
- Ask the Owner only when an active gate requires human visual or real-device
  judgment, a major directional decision, production authority, or resolution of
  a mandatory STOP condition. The review agent records the accepted revision and
  performs the routine Ready, merge, and merged-head operations. A later
  integration may retain that acceptance only under the shared workflow's
  unchanged-presentation and behavior conditions.
- Reply to, fix, and resolve review findings in the PR. New commits require
  review of their delta and integration impact; retain review of unchanged parts
  and bind the final decision to the current HEAD.
- Automated validation, independent diff or code review, and any applicable
  Owner judgment are distinct gates. For user-visible work, provide evidence for
  the task's approved platform matrix instead of a universal pair of phone and
  desktop screenshots.
- Delete a merged task branch through the approved post-merge workflow after
  merged-head verification.

Never commit `.env` files, tokens, cloud keys, production database credentials,
or other secrets. Public Contracts, root dependencies, lockfiles, database
schema or migrations, CI, deployment configuration, and other protected files
require explicit frozen task scope. Obtain an Owner decision only when the
required scope or direction has not already been approved.

Contributor, local, CI, and PR or test environments must not use production
credentials or a production database. Any production deployment is a separate
Owner-approved operation performed by an authorized operator from an approved
release tag created from a verified `main` commit. Repository candidate
deployment documents do not authorize it.

[1]: docs/governance/OWNER-DEVELOPMENT-CONSTITUTION.md
[2]: docs/governance/amendments/
[3]: docs/module-ownership.md
