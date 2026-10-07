import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getPayload } from "payload";

import config from "admin/config";

// The synthetic bootstrap runs on a disposable database that is created once
// per task and never reset; the verification session around it stops only its
// child processes. A repeated cumulative validation therefore meets the rows
// of the previous run. This suite runs the real script twice against the same
// database and expects two usable, distinct identity sets, then checks that a
// refusal is named by one bare category instead of raw diagnostics.

if (
  process.env.CMS_ENVIRONMENT !== "synthetic" ||
  !process.env.CMS_DATABASE_URL
) {
  throw new Error("An isolated synthetic CMS database is required");
}

const admin = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../apps/admin",
);
type Frame = Record<string, unknown>;
type Access = Record<string, string | number>;
type Run = { status: number | null; frames: Frame[]; handoff: string };
const frames = (stdout: string): Frame[] =>
  stdout
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Frame];
      } catch {
        return [];
      }
    })
    .filter((frame) => "syntheticBootstrap" in frame);
const bootstrap = (handoff: string | undefined): Run => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CMS_QA_HANDOFF_FILE;
  if (handoff) env.CMS_QA_HANDOFF_FILE = handoff;
  const result = spawnSync(
    process.execPath,
    ["node_modules/payload/bin.js", "run", "scripts/bootstrap-synthetic.ts"],
    { cwd: admin, env, encoding: "utf8", timeout: 25_000 },
  );
  return {
    status: result.status,
    frames: frames(result.stdout),
    handoff: handoff ?? "",
  };
};

let directory: string;
let payload: Awaited<ReturnType<typeof getPayload>>;
const runs: Run[] = [];

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "moya-bootstrap-test-"));
  payload = await getPayload({ config });
  // Twice, on purpose: the second run meets the first run's rows.
  for (const name of ["first", "second"])
    runs.push(bootstrap(path.join(directory, `${name}.json`)));
});

afterAll(async () => {
  await payload?.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("creates fresh namespaced identities on every run against the same database", async () => {
  for (const run of runs) {
    expect(run.status).toBe(0);
    expect(run.frames).toEqual([
      { syntheticBootstrap: "created", identities: 2, mcpKey: "scoped" },
    ]);
    expect((await stat(run.handoff)).mode & 0o077).toBe(0);
  }
  const accesses: Access[] = [];
  for (const run of runs)
    accesses.push(JSON.parse(await readFile(run.handoff, "utf8")) as Access);
  const [first, second] = accesses;
  if (!first || !second) throw new Error("two bootstrap runs are expected");
  for (const access of accesses) {
    expect(access.ownerEmail).toMatch(
      /^owner-[a-f0-9]{12}@editorial\.example\.invalid$/,
    );
    expect(access.automationEmail).toMatch(
      /^automation-[a-f0-9]{12}@editorial\.example\.invalid$/,
    );
    expect(String(access.ownerEmail).slice(6)).toBe(
      String(access.automationEmail).slice(11),
    );
    const owner = await payload.login({
      collection: "users",
      data: {
        email: String(access.ownerEmail),
        password: String(access.ownerPassword),
      },
    });
    expect(owner.user?.id).toBe(access.ownerId);
    expect(owner.user?.role).toBe("owner");
    const automation = await payload.login({
      collection: "users",
      data: {
        email: String(access.automationEmail),
        password: String(access.automationPassword),
      },
    });
    expect(automation.user?.id).toBe(access.automationId);
    expect(automation.user?.role).toBe("automation");
    expect(
      (
        await payload.find({
          collection: "payload-mcp-api-keys",
          where: { user: { equals: access.automationId } },
          overrideAccess: true,
          limit: 2,
        })
      ).totalDocs,
    ).toBe(1);
  }
  expect(first.ownerEmail).not.toBe(second.ownerEmail);
  expect(first.automationEmail).not.toBe(second.automationEmail);
  expect(first.ownerId).not.toBe(second.ownerId);
  expect(first.automationId).not.toBe(second.automationId);
});

it("names a refused run with one bare category and no raw diagnostics", () => {
  const refused = bootstrap(undefined);
  expect(refused.status).toBe(1);
  expect(refused.frames).toEqual([
    { syntheticBootstrap: "FAIL", category: "SYNTHETIC_HANDOFF_REQUIRED" },
  ]);
});
