# Browser validation and the two-minute daily budget

## Daily acceptance

The Owner requires daily mandatory acceptance to finish within 120 seconds.
Environment provisioning (dependency/browser installation and GitHub queueing)
is outside that budget. With dependencies and Chromium installed, run:

```sh
pnpm verify
```

This runs formatting, lint, typecheck, ordinary tests and build, then the
existing five `formal-web.spec.ts` cases on desktop Chromium. If
`TEST_DATABASE_URL` is set, it also runs database dependency builds, migrations
and PostgreSQL tests. Without that variable local PostgreSQL tests are not run;
CI always supplies it. The full local sequence shares one 119-second deadline,
with eight seconds reserved for forced teardown and one second for command
startup. Exceeding the budget is exit 124 / **TIME BUDGET EXCEEDED**, never PASS
or a reason to rerun automatically.

For just the mandatory browser portion, run `pnpm test:e2e:smoke`. Its native
Playwright deadline is 90 seconds including service startup; the outer
119-second deadline also bounds collection, report validation and process
teardown. It uses one worker, zero retries and stops at the first failure.
Existing assertions are unchanged. Evidence is kept in a fresh
`.local/e2e-ci/smoke-*` directory locally. The tests cover Formal root/QA
isolation, truthful lists, primary navigation, Detail/Viewer, browser
history/reload, redirects and missing/error data.

## GitHub CI

PR and main-push jobs for `lint`, `typecheck`, `test`, `build` and browser smoke
run in parallel after their respective environment setup. Each check uses the
same deadline runner. Only allowlisted documentation omits browser execution;
all other valid changes, including frontend, mixed and unknown paths, run smoke.
A missing or invalid comparison fails classification instead of silently passing
or starting a long regression. The stable required check is still `e2e`; it
requires successful selected execution and matching native collection/results.
Missing evidence, empty collections, skips, retries and flaky results fail.

The budget is an execution deadline, not a promise that arbitrary future changes
will pass. A timeout must be diagnosed as a speed regression. GitHub queueing,
installation and artifact upload are reported separately and cannot be given a
120-second end-to-end guarantee on shared hosted runners.

## Full regression on demand

`pnpm test:e2e` retains the complete five-project local suite. GitHub's **CI →
Run workflow** explicitly runs all five projects in the existing three native
shards. Select the intended branch when dispatching. The original three-shard
distribution, one worker, retry policy, strict flaky rejection and native report
aggregation remain unchanged. Owner-directed full acceptance disables Playwright
test/hook and suite execution deadlines (`timeout: 0`, `globalTimeout: 0`) and
removes shorter browser execution/report job and step limits. GitHub-hosted jobs
still stop at the unavoidable 360-minute platform cap; this is not unlimited
hosted execution. A hang or incomplete report fails the existing complete-result
gate and is never PASS.

Correctness assertions, their retry windows, native inputs and
alignment/readiness criteria remain unchanged. These assertion windows report a
failed condition; they do not impose a whole-suite cutoff. Fixture route
preparation uses unlimited HTTP waits when there is no explicit parent deadline.
Playwright 1.62.1 does not disable web-server availability waiting with zero, so
full startup uses the same six-hour platform ceiling. The smoke entry still
supplies its existing finite startup and suite budgets, and owned service
shutdown keeps its cleanup bound. Product HTTP, upload, database, lease and TTL
limits are unchanged.

Full regression is no longer automatically repeated on each frontend edit or
main push. Run it for a requested cross-browser investigation or a release
candidate that needs complete coverage. Daily smoke PASS establishes only its
listed coverage; it does not turn prior full-regression failures into passes or
replace scoped feature tests or Owner visual/real-device acceptance. Preserve
existing failure evidence and resolve applicable release blockers explicitly.

If the default ports are occupied, set both `MOYA_E2E_WEB_PORT` and
`MOYA_E2E_PUBLIC_API_PORT` to a free pair. The harness still runs in its own
temporary mirror with the deterministic Public API fixture. Product behavior,
Production data authority and all full-suite specs remain unchanged.
