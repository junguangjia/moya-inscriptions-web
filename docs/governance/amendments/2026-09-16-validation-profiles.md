# Owner Amendment — Explicit Validation Profiles

- Status: Active; recorded from the Owner's 2026-09-16 instruction "ArtVenn —
  validation policy remediation and complete acceptance".
- Amended by the Owner on 2026-11-04: CMS complete and the PostgreSQL stage are
  900 seconds and the hosted `test` and `cms` jobs 45 minutes. Each only stops a
  hung run.
- Scope: time limits for functional validation entry points, their CI wrappers
  and the publication-cycle boundary of the core-credential check.
- Preserved: credential protection, independent review, required CI, task
  ownership, accepted product behavior, remote-setting permissions, Production
  boundaries, product runtime timeouts (HTTP, request, upload, database, leases,
  TTLs).
- Retired: the shared 120-second daily budget as a universal acceptance cap and
  the Issue-lifetime functional-testing balance.

Time limits exist to accelerate useful feedback and prevent runaway work. They
must not turn ordinary development into repeated budget-approval requests.

## Replaced clauses

This amendment supersedes exactly these clauses; their historical wording
remains in Git history.

1. `docs/development/task-workflow.md` (formerly lines 132–138): "Daily quick
   acceptance has one shared 120-second execution budget across the selected
   checks. … A genuinely necessary longer milestone check needs explicit
   authority." Replaced by the profile pointer in that section.
2. `.agents/skills/yoyi-task/SKILL.md` (formerly lines 98–99): "One shared
   120-second execution budget; a timeout is a failure." Replaced by the profile
   pointer in that step.
3. `CONTRIBUTING.md` lines 57–58: the formatting/lint/typecheck/test/build/smoke
   "120-second daily budget" sentence. Its wording is reconciled by the Slice B
   shared-workflow task; until then this amendment governs.
4. The doctrine "ordinary entry points retain 120 seconds" in
   `scripts/verify.mjs` and "Owner-authorized local milestone only" in
   `scripts/verify-apple.mjs`: an explicitly selected profile is the ordinary
   entry, not a milestone exception. `verify.mjs` wording is reconciled by Slice
   B.
5. The two-minute Apple validation step in `.github/workflows/ci.yml`.
6. For Issue #145 (scope delta r4): the Issue-lifetime functional balance and
   the "one corrected-head attempt / no second corrective push" rule.
7. The reading of the 2026-09-07 amendment's delivery batch as "any new staged
   tree or batch ID starts a fresh 120-second allowance". The credential check
   keeps 120 seconds per genuine publication cycle; the cycle boundary is
   recorded completion of all declared outgoing checks plus new outgoing-content
   identity, never an agent-chosen name, a revision label or a cosmetic edit.
   The scanner ledger transition is implemented by Slice B.

## Profiles and authorized maximums

| Profile                       | Ceiling                                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FEEDBACK                      | Selected incremental checks; target 30–120 s; hard cap 120 s for the whole selected quick plan.                                                                                                                                        |
| APPLE FULL                    | 600 s total incl. preparation, native build/tests, teardown, Simulator cleanup and result processing; preparation ≤ 120 s inside it; ≈60 s pooled reserve for teardown, cleanup and evidence instead of several tiny independent caps. |
| APPLE HOSTED CONTAINMENT      | Validation step 12 min; existing job limit 20 min. Containment only, not extra native allowance.                                                                                                                                       |
| WEB COMPLETE CHECKS           | Existing CI test milestone 300 s; complete lint/typecheck/build may each use an explicit 300 s profile when selected.                                                                                                                  |
| CMS COMPLETE CHECKS           | Integration and native Admin browser validation may each use an explicit 900 s profile; disposable-target safeguards stay.                                                                                                             |
| LOCAL FULL COMBINED PLAN      | ≤ 900 s when selected checks genuinely require a serial combination; children receive remaining time, never renewed allowances.                                                                                                        |
| BROWSER SMOKE                 | Warm prepared feedback path 120 s; cold complete smoke ≤ 300 s incl. server startup, checks and cleanup.                                                                                                                               |
| FULL CROSS-BROWSER REGRESSION | Explicitly selected, never a daily default; current 18-minute suite policy unchanged.                                                                                                                                                  |
| CREDENTIAL DELIVERY CHECK     | 120 s per genuine publication cycle; incremental content- and rule-aware reuse and the anti-reset requirements remain mandatory.                                                                                                       |

These are ceilings, not required waiting periods or latency guarantees; finish
early whenever possible. Do not raise every timeout constant, including product
runtime limits, to these values. Each validation plan owns its deadline; nested
commands receive the remaining appropriate deadline and cleanup margin, not
fresh complete budgets. Independent CI jobs keep their own profiles; no
accidental shared 120-second parent may govern them. Historical total work is
tracked for reporting, not as an Issue-lifetime quota; a new substantive
validation plan gets its declared profile. Splitting one unchanged run, changing
tools or renaming a task never manufactures time or erases failed attempts.

## Feedback, acceptance and repair authority

Feedback output stays labeled `FEEDBACK ONLY — NOT FULL ACCEPTANCE`. A quick
timeout or uncovered check is incomplete feedback: neither successful acceptance
nor a prohibition on continuing safe development. Full acceptance covers the
complete actual diff and required dependency impact; a shorter selection cannot
masquerade as it. Existing native test methods, iterations, configurations and
assertions are preserved.

Within a frozen scope, an implementer may implement, diagnose, correct and
validate without asking the Owner to approve each ordinary test: one prepared
candidate plus at most two evidence-backed correction rounds per slice, each
addressing a recorded cause; one unchanged retry only for an evidenced transient
infrastructure failure. Deterministic assertions are not auto-retried, failed
runs are preserved, profile limits are not extended automatically, and exhausted
rounds stop with the narrow unresolved cause.

## Unchanged

Historical failures and elapsed-time records remain unchanged; updating policy
does not retroactively make a failed run pass. Credential protection,
independent exact-head review, required CI and branch protection, one-writer
task ownership, accepted product behavior and bytes, remote-setting permissions
and Production boundaries are not superseded. A passing Xcode 26.6 compatibility
job is not released-Xcode-27 CI; the latter remains a separately named
follow-up.
