# Owner Amendment — Machine-Verified Review and Merge

- Status: Active
- Effective date: 2026-08-24
- Applies to:
  - repository task review;
  - Ready transitions;
  - pull request merges;
  - merged-head verification.

The Owner explicitly directed:

> 只有需要真人视觉验证和大方向决定性判断的事项交给 Owner；其他内容由代理独立验证并 merge。

This is an explicit Owner amendment under the Constitution's authority
hierarchy. It supersedes any conflicting blanket requirement in the
Constitution, contributor guides, pull request template, branching rules, or
module-ownership documents that every pull request must be manually marked Ready
or merged by the Owner.

## 1. Default rule

A fully machine-verifiable task must be independently reviewed, validated,
merged, and verified at the merged head. Routine review and merge operations do
not require the Owner.

Machine-verifiable evidence may include:

- the actual GitHub diff and exact head SHA;
- frozen Scope, non-goals, and Behavior Matrix where applicable;
- architecture and dependency-boundary inspection;
- applicable format, lint, typecheck, unit, integration, PostgreSQL, build, and
  E2E results;
- GitHub CI and review-thread state;
- deterministic remote-state and merged-head checks.

Green CI or an implementation-agent self-report alone is not sufficient. An
independent review agent must inspect the actual diff, applicable evidence, and
current remote state.

Owner clarification, 2026-10-01: after complete task acceptance, an upstream
synchronization requires local checks and independent review of its actual
changes and integration impact, not automatic repetition of every local check
and unchanged review. The final candidate still requires cumulative CI and a
review decision bound to its HEAD. Apply the final integration rules in
[`task-workflow.md`](../../development/task-workflow.md#implementation-and-final-integration-boundaries)
using existing commands and records; no new verification mode is required.

## 2. Owner decision gates

Stop and obtain an explicit Owner decision only when at least one of these gates
applies:

1. **Visual or real-device acceptance.** This includes user-visible layout,
   styling, interaction feel, gestures, responsive presentation, or another
   result that requires human visual or physical-device judgment.
2. **Major directional judgment.** This includes an unresolved choice that
   changes product direction, architecture authority, data governance, domain or
   Contract scope, production-provider strategy, material cost or security
   posture, or another long-term policy not already frozen by an approved task.
3. **Production authority.** This includes purchasing resources, deploying to
   Production, changing production credentials or secrets, or performing another
   explicitly Owner-controlled external operation.
4. **Mandatory STOP condition.** This includes unresolved ambiguity, unexpected
   remote state, unapproved scope expansion, or another conflict that cannot be
   settled from approved evidence.

A protected file, Contract, migration, or dependency change does not by itself
require a second manual Owner merge when its scope and direction were already
explicitly approved. It still requires applicable independent review and
validation.

## 3. Review and merge workflow

The normal workflow is:

```text
implementation
→ applicable automated validation
→ commit and push
→ Draft PR
→ independent actual-diff review
→ applicable Owner decision or visual gate
→ Ready transition
→ expected-head squash merge
→ merged-head verification
```

For a machine-verifiable task with no unresolved Owner gate, the independent
review agent may:

- complete the review;
- mark the pull request Ready;
- squash merge it while pinning the expected head SHA;
- perform merged-head CI and content verification;
- report the final merged SHA and closure status.

For user-visible work, the review agent completes all machine review first and
asks the Owner only for the necessary visual or real-device judgment. After that
judgment is recorded, the review agent performs the routine Ready, merge, and
merged-head operations. For a later integration candidate, the reviewer may
carry forward that judgment only after establishing that the accepted
presentation, behavior and relevant dependencies/configuration are unchanged,
and recording the accepted revision and the final HEAD. Changed scenarios need
Owner acceptance again. Explicit task-specific exact-head and Draft stops remain
binding.

For a major directional decision, the Owner chooses the direction. Once the
choice is frozen, implementation and routine review or merge return to the
machine-managed workflow.

## 4. Branch authority

- Short-lived task pull requests targeting `main` may be merged by an authorized
  independent review agent after all applicable gates pass.
- A stable milestone requires an explicit Owner decision selecting a verified
  `main` commit. After approval, an authorized agent creates the annotated tag
  and GitHub Release. Production operations remain separately Owner-controlled.
- Direct pushes to shared branches, force-pushes, and history rewriting remain
  prohibited.

The single-main topology and release model are defined by the active
[`2026-09-04 single-main trunk unification`](2026-09-04-single-main-trunk-unification.md)
amendment.

## 5. Definition of Done

A machine-verifiable task is CLOSED only after:

- approved scope is complete;
- applicable tests and CI pass;
- independent actual-diff review passes;
- every applicable Owner gate is either not applicable or explicitly satisfied;
- the pull request is merged;
- merged-head verification passes.

User-visible work additionally requires recorded Owner visual or real-device
acceptance. Directional work additionally requires the recorded Owner decision.

This amendment does not relax architecture, data, security, scope, testing,
Development or Production, T02, or secret-protection rules. It changes who
performs routine review and merge operations and when Owner judgment is
required.
