// Frozen validation profiles from the Owner's 2026-09-16 amendment
// (docs/governance/amendments/2026-09-16-validation-profiles.md). Each value is
// a ceiling for one validation plan, never a waiting period or a per-hook
// allowance. A parent that runs several plans passes its remaining time down;
// a child treats that value as a ceiling on its own profile and never renews
// it. No environment variable changes a profile.
export const VALIDATION_PROFILES = Object.freeze({
  // FEEDBACK: the selected incremental quick plan; hard cap for the whole plan.
  // Only `verify-task --mode feedback` (and the Apple feedback build below)
  // carries this name and the FEEDBACK ONLY banner.
  feedback: Object.freeze({ name: "feedback", totalMs: 120_000 }),
  // Already-adequate quick ceilings of unflagged complete-check entry points
  // and of the dependency-free script suite. They share the 120 s cap but are
  // ordinary acceptance checks, so they never carry the feedback label.
  scriptTests: Object.freeze({ name: "script-tests", totalMs: 120_000 }),
  webQuick: Object.freeze({ name: "web-quick", totalMs: 120_000 }),
  cmsQuick: Object.freeze({ name: "cms-quick", totalMs: 120_000 }),
  // WEB COMPLETE CHECKS: one complete lint, typecheck, test or build run.
  webComplete: Object.freeze({ name: "web-complete", totalMs: 300_000 }),
  // CI TEST MILESTONE: the complete test run inside the hosted CI test job.
  // Owner, 2026-10-07: CI checks run to completion and are analysed
  // afterwards; the hosted job limit (`timeout-minutes: 20`) remains the
  // containment. This ceiling only stops a hung run inside that job and leaves
  // room for the PostgreSQL 16 step. Every local profile here is unchanged.
  ciTestMilestone: Object.freeze({
    name: "ci-test-milestone",
    totalMs: 900_000,
  }),
  // CMS COMPLETE CHECKS: integration or native Admin browser validation.
  cmsComplete: Object.freeze({ name: "cms-complete", totalMs: 300_000 }),
  // BROWSER SMOKE: warm prepared feedback path and cold complete smoke.
  browserSmokeWarm: Object.freeze({
    name: "browser-smoke-warm",
    totalMs: 120_000,
  }),
  browserSmokeCold: Object.freeze({
    name: "browser-smoke-cold",
    totalMs: 300_000,
  }),
  // APPLE FULL and the Apple feedback build; scripts/verify-apple.mjs owns the
  // internal preparation cap and pooled reserve of these totals.
  appleFull: Object.freeze({ name: "apple-full", totalMs: 600_000 }),
  appleFeedback: Object.freeze({ name: "apple-feedback", totalMs: 120_000 }),
  // LOCAL FULL COMBINED PLAN: serial combination of selected checks.
  localCombined: Object.freeze({ name: "local-combined", totalMs: 900_000 }),
  // CREDENTIAL DELIVERY CHECK: one genuine publication cycle.
  credentialDelivery: Object.freeze({
    name: "credential-delivery",
    totalMs: 120_000,
  }),
});

// Placeholder that a parent's command runner replaces with the remaining
// milliseconds at spawn time, so recorded commands show the real value passed.
export const REMAINING_MS_TOKEN = "<remaining-ms>";

export function parseRemainingMs(value) {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/u.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error("INVALID_REMAINING_MS");
  return Number(value);
}

/**
 * Effective ceiling for one plan: the profile total, lowered (never raised)
 * by a parent's remaining time. The source is reported so no summary can print
 * a profile total that was not actually in force.
 */
export function effectiveCeiling(profile, remainingMs = null) {
  const ceilingMs =
    remainingMs === null
      ? profile.totalMs
      : Math.min(profile.totalMs, remainingMs);
  return {
    profile: profile.name,
    totalMs: profile.totalMs,
    ceilingMs,
    ceilingSource: ceilingMs < profile.totalMs ? "parent-remaining" : "profile",
    remainingMs,
  };
}

/**
 * Split argv into `--profile <name>` / `--remaining-ms <n>` options and the
 * remaining arguments. Each option appears at most once; a missing or
 * flag-shaped value is an error. Unknown arguments are returned untouched so a
 * caller keeps its own flags.
 */
export function takeProfileOptions(argv, profiles) {
  const rest = [];
  const options = { profile: null, remainingMs: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--profile" || flag === "--remaining-ms") {
      const key = flag === "--profile" ? "profile" : "remainingMs";
      if (options[key] !== null) throw new Error("DUPLICATE_PROFILE_OPTION");
      const value = argv[i + 1];
      if (!value || value.startsWith("--"))
        throw new Error(
          flag === "--profile" ? "INVALID_PROFILE" : "INVALID_REMAINING_MS",
        );
      i += 1;
      if (key === "profile") {
        if (!Object.hasOwn(profiles, value)) throw new Error("INVALID_PROFILE");
        options.profile = value;
      } else options.remainingMs = parseRemainingMs(value);
    } else rest.push(flag);
  }
  return { ...options, rest };
}

/** Replace the remaining-time token inside one command with the real value. */
export function withRemaining(command, remainingMs) {
  return command.map((part) =>
    part === REMAINING_MS_TOKEN
      ? String(Math.max(1, Math.floor(remainingMs)))
      : part,
  );
}
