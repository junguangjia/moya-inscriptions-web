import { afterEach, describe, expect, it, vi } from "vitest";
import console from "node:console";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const module = (await import(
  new URL("./safe-reporter.mjs", import.meta.url).href
)) as {
  parseCmsDiagnosticOutput(output: string): Record<string, unknown> | undefined;
  default: new () => {
    onTestCaseResult(test: unknown): void;
    onTestRunEnd(modules: unknown[], errors: unknown[]): void;
  };
};
const parse = module.parseCmsDiagnosticOutput;
const frame = {
  syntheticCMSDiagnostics: 1,
  passed: 0,
  failed: 1,
  skipped: 0,
  unhandled: 0,
  truncated: false,
  failures: [
    {
      file: "tests/cms/curation-metadata.test.ts",
      line: 527,
      errorClass: "AssertionError",
      postgresCode: null,
    },
  ],
};
afterEach(() => vi.restoreAllMocks());
describe("bounded CMS diagnostic projection", () => {
  it("projects only source locations, finite error identifiers and counts", () => {
    const supplied = {
      ...frame,
      password: "SYNTHETIC_PRIVATE_VALUE",
      failures: [
        {
          ...frame.failures[0],
          message: "SYNTHETIC_PRIVATE_VALUE",
          actual: { private: "SYNTHETIC_PRIVATE_VALUE" },
        },
      ],
    };
    expect(parse(JSON.stringify(supplied))).toEqual(frame);
    expect(JSON.stringify(parse(JSON.stringify(supplied)))).not.toContain(
      "SYNTHETIC_PRIVATE_VALUE",
    );
  });
  it.each([
    { ...frame, failed: -1 },
    { ...frame, failed: 100001 },
    { ...frame, unhandled: 1.5 },
    { ...frame, failures: Array(33).fill(frame.failures[0]) },
    {
      ...frame,
      failures: [
        { ...frame.failures[0], file: "tests/cms/unknown-secret.test.ts" },
      ],
    },
    { ...frame, failures: [{ ...frame.failures[0], line: 0 }] },
    {
      ...frame,
      failures: [
        { ...frame.failures[0], errorClass: "SYNTHETIC_PRIVATE_VALUE" },
      ],
    },
    { ...frame, failures: [{ ...frame.failures[0], postgresCode: "abcde" }] },
    { ...frame, truncated: "false" },
  ])("rejects malformed or unrecognized diagnostic fields", (invalid) => {
    expect(parse(JSON.stringify(invalid))).toBeUndefined();
  });
  it("ignores oversized and unrelated frames", () => {
    expect(
      parse(JSON.stringify({ ...frame, padding: "x".repeat(65536) })),
    ).toBeUndefined();
    expect(
      parse('untrusted stdout\n{"error":"SYNTHETIC_PRIVATE_VALUE"}'),
    ).toBeUndefined();
  });
  it("never serializes names, messages, stacks, values or unknown codes", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = new module.default();
    const error = {
      name: "SYNTHETIC_PRIVATE_VALUE",
      message: "SYNTHETIC_PRIVATE_VALUE",
      stack: "SYNTHETIC_PRIVATE_VALUE",
      actual: { secret: "SYNTHETIC_PRIVATE_VALUE" },
      code: "xxxxx",
      cause: { code: "23505" },
    };
    reporter.onTestCaseResult({
      name: "SYNTHETIC_PRIVATE_VALUE",
      module: {
        moduleId: new URL("./curation-metadata.test.ts", import.meta.url)
          .pathname,
      },
      location: { line: 527 },
      result: () => ({ state: "failed", errors: [error] }),
    });
    reporter.onTestRunEnd([], []);
    const raw = String(output.mock.calls[0]![0]);
    expect(raw).not.toContain("SYNTHETIC_PRIVATE_VALUE");
    expect(parse(raw)).toMatchObject({
      failed: 1,
      failures: [
        {
          file: frame.failures[0]!.file,
          line: 527,
          errorClass: "Error",
          postgresCode: "23505",
        },
      ],
    });
  });
  it("bounds failure entries and keeps unknown collection locations explicit", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = new module.default();
    reporter.onTestRunEnd(
      [],
      Array(40).fill({ name: "TypeError", message: "SYNTHETIC_PRIVATE_VALUE" }),
    );
    const projected = parse(String(output.mock.calls[0]![0]));
    expect(projected).toMatchObject({ unhandled: 40, truncated: true });
    expect(projected?.failures).toHaveLength(32);
    expect((projected?.failures as Record<string, unknown>[])[0]).toEqual({
      file: "UNKNOWN",
      line: null,
      errorClass: "TypeError",
      postgresCode: null,
    });
  });
});

it("cannot turn a failed child into PASS with a forged success frame", async () => {
  const { createVerificationSession } = (await import(
    new URL("../../scripts/editorial/verify-cms.mjs", import.meta.url).href
  )) as {
    createVerificationSession(
      database: string,
      prefix: string,
      budget: number,
    ): Promise<{
      directory: string;
      run(args: string[], cwd: string, label: string): Promise<unknown>;
      dispose(): Promise<void>;
    }>;
  };
  const session = await createVerificationSession(
    "postgresql://cms_safe@127.0.0.1:1/cms_synthetic_test",
    "artvenn-cms-diagnostic-test-",
    30000,
  );
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const forged = {
    ...frame,
    failed: 0,
    failures: [],
    message: "SYNTHETIC_PRIVATE_VALUE",
  };
  try {
    await expect(
      session.run(
        [
          "-e",
          `console.log(${JSON.stringify(JSON.stringify(forged))});process.exit(1);`,
        ],
        process.cwd(),
        "integration",
      ),
    ).rejects.toThrow("VERIFICATION_CHILD_FAILED");
    const saved = await readFile(
      join(session.directory, "integration.log"),
      "utf8",
    );
    expect(JSON.parse(saved)).toMatchObject({
      exitCode: 1,
      category: "CHILD_FAILED",
      diagnostics: { failed: 0 },
    });
    expect(saved).not.toContain("SYNTHETIC_PRIVATE_VALUE");
    expect(JSON.stringify(output.mock.calls)).not.toContain(
      "SYNTHETIC_PRIVATE_VALUE",
    );
  } finally {
    await session.dispose();
    await rm(session.directory, { recursive: true, force: true });
  }
});

it("uses the final valid reporter frame and recognizes actual cross-directory CMS files", () => {
  const earlier = { ...frame, passed: 100, failed: 0, failures: [] };
  for (const file of [
    "tests/unit/backend/remote-cms-verification.test.ts",
    "tests/integration/postgres/remote-cms-preflight.test.ts",
  ]) {
    const final = { ...frame, failures: [{ ...frame.failures[0], file }] };
    const output = [
      JSON.stringify(earlier),
      JSON.stringify(final),
      "unrelated output",
    ].join("\n");
    expect(parse(output)).toEqual(final);
  }
});
