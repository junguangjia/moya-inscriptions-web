import { describe, expect, it } from "vitest";

import { safeReturnPath } from "./auth-api";

describe("safeReturnPath", () => {
  it("keeps a same-origin application path", () => {
    expect(safeReturnPath("/#profile")).toBe("/#profile");
    expect(safeReturnPath("/works/1?tab=comments")).toBe(
      "/works/1?tab=comments",
    );
  });

  it("drops foreign and protocol-relative destinations", () => {
    expect(safeReturnPath("https://evil.example/phish")).toBe("/");
    expect(safeReturnPath("//evil.example")).toBe("/");
    expect(safeReturnPath("/\\evil")).toBe("/");
  });
});
