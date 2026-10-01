import {
  hashPassword,
  verifyPassword,
  validPassword,
  PasswordHashBusyError,
} from "@moya/api";
import { authPasswordSchema, studioNameSchema } from "@moya/contracts/schemas";
import { describe, it, expect } from "vitest";
describe("versioned asynchronous password hashing", () => {
  it("uses salted fixed OWASP scrypt parameters, rejects wrong passwords and noncanonical versions", async () => {
    const unicodeSample = "SYNTHETIC_A1雪";
    const password = unicodeSample;
    const left = await hashPassword(password),
      right = await hashPassword(password);
    expect(left === right).toBe(false);
    expect(left.startsWith("scrypt-v1$32768$8$3$")).toBe(true);
    expect(await verifyPassword(password, left)).toBe(true);
    expect(await verifyPassword("SyntheticWrong2", left)).toBe(false);
    expect(await verifyPassword(password, left.replace("$32768$", "$1$"))).toBe(
      false,
    );
    expect(await verifyPassword(password, null)).toBe(false);
  });
  it("counts code points, accepts symbols/non-ASCII, and never trims", () => {
    for (const value of ["A1雪🌿_!", " A1雪🌿_! ", "A1" + "🌿".repeat(18)]) {
      expect(validPassword(value)).toBe(true);
      expect(authPasswordSchema.safeParse(value).success).toBe(true);
    }
    for (const value of [
      "a123456",
      "ABCDEF",
      "A1🌿",
      "A1" + "🌿".repeat(19),
      "A1abc\0",
      "A1abc\ud800",
    ]) {
      expect(validPassword(value)).toBe(false);
      expect(authPasswordSchema.safeParse(value).success).toBe(false);
    }
    expect(studioNameSchema.parse(" 山🌿斋 ")).toBe("山🌿斋");
    expect(studioNameSchema.safeParse("🌿".repeat(6)).success).toBe(true);
    expect(studioNameSchema.safeParse("🌿".repeat(7)).success).toBe(false);
  });
  it("keeps the event loop responsive and bounds global hash work instead of spawning unlimited workers", async () => {
    let ticked = false;
    const timer = setTimeout(() => {
      ticked = true;
    }, 0);
    const jobs = Array.from({ length: 11 }, () => hashPassword("SyntheticA1"));
    const settled = await Promise.allSettled(jobs);
    clearTimeout(timer);
    expect(ticked).toBe(true);
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(
      10,
    );
    const rejected = settled.find((item) => item.status === "rejected");
    expect(
      rejected?.status === "rejected" &&
        rejected.reason instanceof PasswordHashBusyError,
    ).toBe(true);
  });
});
