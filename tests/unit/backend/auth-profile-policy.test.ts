import { describe, expect, it } from "vitest";
import { authPasswordSchema, studioNameSchema } from "@moya/contracts/schemas";
import { isValidAuthPassword, normalizeStudioName } from "@moya/api";

describe("authentication domain profile policy", () => {
  it("counts scalar code points at both boundaries without trimming password bytes", () => {
    const valid = [
      "A1雪🌿_!",
      " A1ab ",
      "A1" + "🌿".repeat(18),
      "A1" + "雪".repeat(18),
      "A1e\u0301!_",
    ];
    const invalid = [
      "A1雪🌿_",
      " A1ab",
      "A1" + "🌿".repeat(19),
      "a1雪🌿_!",
      "A雪🌿_!字",
      "Ａ1雪🌿_!",
      "A１雪🌿_!",
    ];
    expect(valid.map((value) => isValidAuthPassword(value))).toEqual(
      valid.map(() => true),
    );
    expect(invalid.map((value) => isValidAuthPassword(value))).toEqual(
      invalid.map(() => false),
    );
    for (const value of [...valid, ...invalid])
      expect(isValidAuthPassword(value)).toBe(
        authPasswordSchema.safeParse(value).success,
      );
    // A six-point password remains six points: surrounding spaces are data.
    expect(isValidAuthPassword(" A1ab ")).toBe(true);
    expect(isValidAuthPassword(" A1ab ".trim())).toBe(false);
  });
  it("trims studio names, permits empty clearing and applies the six-point Unicode limit", () => {
    const cases = [
      [" 山🌿斋 ", "山🌿斋"],
      ["\u00a0山🌿斋\u00a0", "山🌿斋"],
      ["🌿".repeat(6), "🌿".repeat(6)],
      ["🌿".repeat(7), null],
      ["雪".repeat(6), "雪".repeat(6)],
      ["雪".repeat(7), null],
      ["", ""],
      ["  ", ""],
    ] as const;
    for (const [input, expected] of cases) {
      expect(normalizeStudioName(input) === expected).toBe(true);
      const parsed = studioNameSchema.safeParse(input);
      expect(normalizeStudioName(input) !== null).toBe(parsed.success);
      if (parsed.success)
        expect(normalizeStudioName(input) === parsed.data).toBe(true);
    }
  });
  it("rejects NUL, lone surrogates and non-text without rejecting valid surrogate pairs", () => {
    for (const invalid of ["\u0000", "\ud800", "\udfff"]) {
      const password = `A1abc${invalid}`;
      expect(isValidAuthPassword(password)).toBe(false);
      expect(authPasswordSchema.safeParse(password).success).toBe(false);
      expect(normalizeStudioName(`山${invalid}`) === null).toBe(true);
      expect(studioNameSchema.safeParse(`山${invalid}`).success).toBe(false);
    }
    expect(isValidAuthPassword("A1abc🌿")).toBe(true);
    expect(normalizeStudioName(" 山🌿 ") === "山🌿").toBe(true);
    for (const value of [null, undefined, 123, {}, []]) {
      expect(isValidAuthPassword(value)).toBe(false);
      expect(normalizeStudioName(value) === null).toBe(true);
    }
  });
});
