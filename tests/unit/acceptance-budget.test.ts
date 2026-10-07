import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const { runWithinBudget, verificationBudgetMs } = (await import(
  new URL("../../scripts/verify.mjs", import.meta.url).href
)) as {
  verificationBudgetMs: (
    mode: string,
    flags?: string[],
    env?: Record<string, string>,
  ) => number;
  runWithinBudget: (
    commands: string[][],
    options: { budgetMs: number; graceMs: number; stdio: string },
  ) => Promise<{ code: number; durationMs: number }>;
};
const node = (code: string) => [process.execPath, "-e", code];
const options = { budgetMs: 1500, graceMs: 100, stdio: "ignore" };

it("returns real failure and never starts later checks", async () => {
  const result = await runWithinBudget(
    [node("process.exit(7)"), node("setInterval(() => {}, 1000)")],
    options,
  );
  expect(result.code).toBe(7);
  expect(result.durationMs).toBeLessThan(1000);
  expect((await runWithinBudget([node("process.exit(0)")], options)).code).toBe(
    0,
  );
});

it("shares one deadline across successive checks", async () => {
  const result = await runWithinBudget(
    [node("setTimeout(() => {}, 300)"), node("setTimeout(() => {}, 300)")],
    { ...options, budgetMs: 550, graceMs: 50 },
  );
  expect(result.code).toBe(124);
  expect(result.durationMs).toBeLessThan(1000);
});

it("kills a interrupt-resistant descendant even after its parent exits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "moya-budget-test-"));
  const pidFile = join(directory, "pid");
  const marker = join(directory, "late");
  const script = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'leaked'), 1200); setInterval(() => {}, 1000);`;
  try {
    const result = await runWithinBudget(
      [
        node(
          `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(script)}], { stdio: 'ignore', detached: true }); setInterval(() => {}, 1000);`,
        ),
      ],
      { ...options, budgetMs: 750, graceMs: 150 },
    );
    expect(result.code).toBe(124);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      })
      .toBe(true);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps routine budgets fixed and permits only the explicit complete CI test milestone", () => {
  const ci = {
    GITHUB_ACTIONS: "true",
    TEST_DATABASE_URL: "synthetic-test-target",
  };
  for (const mode of ["all", "lint", "typecheck", "test", "build", "e2e"]) {
    expect(verificationBudgetMs(mode)).toBe(120_000);
    expect(verificationBudgetMs(mode, [], ci)).toBe(120_000);
    if (mode !== "test")
      expect(() =>
        verificationBudgetMs(mode, ["--ci-milestone"], ci),
      ).toThrow();
  }
  // The hosted milestone runs to completion inside the job containment.
  expect(verificationBudgetMs("test", ["--ci-milestone"], ci)).toBe(900_000);
  expect(() => verificationBudgetMs("test", ["--ci-milestone"], {})).toThrow();
  expect(() =>
    verificationBudgetMs("test", ["--ci-milestone"], {
      GITHUB_ACTIONS: "true",
    }),
  ).toThrow();
  expect(() => verificationBudgetMs("test", ["--budget=600000"], ci)).toThrow();
  expect(() =>
    verificationBudgetMs("test", ["--ci-milestone", "extra"], ci),
  ).toThrow();

  const workflow = readFileSync(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  expect(workflow.match(/--ci-milestone/g)).toHaveLength(1);
  expect(workflow).toContain(
    "run: node scripts/verify.mjs test --ci-milestone",
  );
});
