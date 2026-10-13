import console from "node:console";
import { readdirSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import { relative } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const files = new Set(
  readdirSync(new URL("./", import.meta.url))
    .filter((file) => /^[a-z0-9-]+\.test\.ts$/u.test(file))
    .map((file) => `tests/cms/${file}`),
);
const classes = new Set([
  "Error",
  "AssertionError",
  "TypeError",
  "ReferenceError",
  "SyntaxError",
  "TimeoutError",
]);
const codes = new Set([
  "23502",
  "23503",
  "23505",
  "23514",
  "40001",
  "40P01",
  "42P01",
  "42703",
  "42501",
  "55P03",
  "57014",
  "08006",
]);
const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 100000;
const location = (module, line) => ({
  file: files.has(module) ? module : "UNKNOWN",
  line: Number.isSafeInteger(line) && line > 0 && line < 1000000 ? line : null,
});
const errorClass = (error) => (classes.has(error?.name) ? error.name : "Error");
const postgresCode = (error) => {
  for (let depth = 0; error && depth < 4; depth++, error = error.cause)
    if (codes.has(error.code)) return error.code;
  return null;
};

/** A second projection at the harness boundary: no message, dynamic name,
 * raw stack, assertion value or arbitrary error code can leave the child. */
export function parseCmsDiagnosticOutput(output) {
  if (typeof output !== "string") return undefined;
  for (const line of output.split("\n")) {
    if (line.length > 65536) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      frame?.syntheticCMSDiagnostics !== 1 ||
      !["passed", "failed", "skipped"].every((key) => count(frame[key])) ||
      !count(frame.unhandled) ||
      !Array.isArray(frame.failures) ||
      frame.failures.length > 32 ||
      typeof frame.truncated !== "boolean"
    )
      continue;
    const failures = [];
    let invalid = false;
    for (const row of frame.failures) {
      if (
        !row ||
        !(files.has(row.file) || row.file === "UNKNOWN") ||
        !(
          row.line === null ||
          (Number.isSafeInteger(row.line) && row.line > 0 && row.line < 1000000)
        ) ||
        !classes.has(row.errorClass) ||
        !(row.postgresCode === null || codes.has(row.postgresCode))
      ) {
        invalid = true;
        break;
      }
      failures.push({
        ...location(row.file, row.line),
        errorClass: row.errorClass,
        postgresCode: row.postgresCode,
      });
    }
    if (!invalid)
      return {
        syntheticCMSDiagnostics: 1,
        passed: frame.passed,
        failed: frame.failed,
        skipped: frame.skipped,
        unhandled: frame.unhandled,
        truncated: frame.truncated,
        failures,
      };
  }
  return undefined;
}

/** Test definition locations only. Secrets and complete responses never enter
 * this frame; the harness still fails from the unchanged child exit status. */
export default class SafeCmsReporter {
  counts = { passed: 0, failed: 0, skipped: 0 };
  failures = [];
  truncated = false;
  addFailure(module, line, error) {
    if (this.failures.length >= 32) {
      this.truncated = true;
      return;
    }
    this.failures.push({
      ...location(relative(root, module ?? ""), line),
      errorClass: errorClass(error),
      postgresCode: postgresCode(error),
    });
  }
  onTestCaseResult(test) {
    const result = test.result();
    if (Object.hasOwn(this.counts, result.state)) this.counts[result.state]++;
    if (result.state === "failed")
      this.addFailure(
        test.module.moduleId,
        test.location?.line,
        result.errors?.[0],
      );
  }
  onTestRunEnd(modules, errors) {
    for (const module of modules)
      for (const error of module.errors())
        this.addFailure(module.moduleId, null, error);
    for (const error of errors) this.addFailure(undefined, null, error);
    console.log(
      JSON.stringify({
        syntheticCMSDiagnostics: 1,
        ...this.counts,
        unhandled: errors.length,
        truncated: this.truncated,
        failures: this.failures,
      }),
    );
  }
}
