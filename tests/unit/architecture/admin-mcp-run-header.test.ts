import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { discoverWorkspaces, repositoryRoot } from "./workspace-scanner.js";

// The run mark's places (admin-mcp-completion-v1 S8, plan 2.8). The Backend asks for a
// run id on an irreversible write; only the run executor issues the ticket that carries
// one, only the per-target core admits a target, and only these files name the header.
// A new place is a new way to reach an irreversible effect, so it is named here first.

const sources = async () => {
  const workspaces = await discoverWorkspaces();
  const files = workspaces
    .filter(({ manifest }) => manifest.name !== "@moya/tests")
    .flatMap(({ sourceFiles }) => sourceFiles)
    .filter((file) => !file.endsWith(".d.ts"));
  return Promise.all(
    files.map(async (file) => ({
      file: path.relative(repositoryRoot, file).replaceAll("\\", "/"),
      source: await readFile(file, "utf8"),
    })),
  );
};

const where = async (pattern: RegExp) =>
  (await sources())
    .filter(({ source }) => pattern.test(source))
    .map(({ file }) => file)
    .sort();

const ADMIN = "apps/admin/src/admin-mcp";

describe("the run header", () => {
  it("is named only where it is defined, read by the Backend, or set by the Admin", async () => {
    expect(await where(/AI_OPERATOR_RUN_HEADER|x-admin-mcp-run/u)).toEqual(
      [
        `${ADMIN}/ops/community-reads.ts`,
        `${ADMIN}/ops/community-writes.ts`,
        "packages/contracts/src/internal/admin-mcp/ai-routes.ts",
        "packages/contracts/src/internal/admin-mcp/index.ts",
        "services/backend-runtime/src/community/operator-handler.ts",
        "services/backend-runtime/src/community/reporting-handler.ts",
      ].sort(),
    );
  });

  it("is checked as a run id on both Backend paths, never as a bare presence", async () => {
    for (const file of [
      "services/backend-runtime/src/community/operator-handler.ts",
      "services/backend-runtime/src/community/reporting-handler.ts",
    ]) {
      const source = await readFile(path.join(repositoryRoot, file), "utf8");
      expect(source, file).toMatch(
        /isAiRunHeader\(request\.headers\[AI_OPERATOR_RUN_HEADER\]\)/u,
      );
      expect(source, file).not.toMatch(
        /!request\.headers\[AI_OPERATOR_RUN_HEADER\]/u,
      );
    }
  });
});

describe("a run ticket and an admission", () => {
  it("are issued by the run executor alone", async () => {
    // Once S8-09 builds it; until then nothing issues one. An export calls nothing.
    expect(
      (await where(/\bissueRunTicket\(/u)).filter(
        (file) => file !== `${ADMIN}/runs/executor.ts`,
      ),
    ).toEqual([]);
  });

  it("are granted only by the per-target core", async () => {
    expect(await where(/\badmitTarget\(/u)).toEqual([`${ADMIN}/ops/target.ts`]);
  });
});

// S8-11: past the threshold a run waits for the Owner, so the only call that confirms
// one, and the only cancel that reaches another credential's run, sit behind the
// control page's reserved routes. A new caller is a new way around the Owner.
describe("the Owner's hand on a run", () => {
  it("confirms and cancels across credentials only from the control page's routes", async () => {
    expect(await where(/\bconfirmRun\(/u)).toEqual([
      `${ADMIN}/control/endpoints.ts`,
    ]);
    expect(await where(/\bcancelRun\([^)]*"owner"/u)).toEqual([
      `${ADMIN}/control/endpoints.ts`,
    ]);
  });
});
