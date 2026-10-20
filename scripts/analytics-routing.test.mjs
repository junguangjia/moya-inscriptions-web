import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTask } from "./ci-task-scope.mjs";
import { scriptTests } from "./verify-task.mjs";

test("analytics maintenance changes select Web checks and their real script suites", () => {
  for (const path of [
    "scripts/analytics/export-canonical.mjs",
    "scripts/analytics/prune-umami.test.mjs",
  ]) {
    const plan = classifyTask([path]);
    assert.equal(plan.web, true);
    assert.equal(plan.apple, false);
  }
  assert(scriptTests().includes("scripts/analytics/export-canonical.test.mjs"));
  assert(scriptTests().includes("scripts/analytics/prune-umami.test.mjs"));
  assert.throws(
    () => classifyTask(["scripts/analytics-other/export.mjs"]),
    /Unmapped/,
  );
});
