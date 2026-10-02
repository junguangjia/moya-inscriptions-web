import assert from "node:assert/strict";
import test from "node:test";
import { classifyTask } from "./ci-task-scope.mjs";
import {
  createDraftReadClient,
  developmentOrigin,
} from "./curation/adapter.mjs";

const config = {
  instance: "development",
  syntheticOnly: true,
  targetVerified: true,
  baseURL: "http://127.0.0.1:43219",
  apiKey: "SYNTHETIC_TEST_ONLY_NOT_A_REAL_KEY",
  catalogIds: ["synthetic-catalog"],
};
test("local native curation has scoped tooling checks without approval/publish CMS suites", () => {
  const plan = classifyTask(
    [
      "scripts/curation/app.py",
      "scripts/curation/model/requirements.lock",
      "scripts/curation/templates/group.xml",
      "docs/curation/README.md",
    ],
    "local",
  );
  assert.equal(plan.lightweight, true);
  assert.equal(plan.cms, false);
  assert.equal(plan.web, false);
  assert.throws(
    () => classifyTask(["scripts/other-unmapped-tool.py"], "local"),
    /Unmapped changed paths/u,
  );
  assert.equal(
    classifyTask(["apps/admin/src/app/api/editorial/route.ts"], "local").cms,
    true,
  );
});
test("curation client refuses Owner approval and Publish before HTTP", async () => {
  let calls = 0;
  const client = createDraftReadClient(config, {
    fetchImpl: async () => {
      calls++;
    },
  });
  for (const route of [
    "/api/editorial/approve-batch",
    "/api/editorial/publish-approved",
    "/api/editorial/restore-version",
  ]) {
    await assert.rejects(
      client.request(route, "POST", {}),
      /OPERATION_NOT_AUTHORIZED/u,
    );
  }
  assert.equal(calls, 0);
  for (const patch of [
    { instance: "production" },
    { syntheticOnly: false },
    { baseURL: "https://example.invalid" },
    { targetVerified: false },
  ])
    assert.throws(() => developmentOrigin({ ...config, ...patch }));
});
