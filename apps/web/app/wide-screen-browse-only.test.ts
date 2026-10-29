import { afterEach, describe, expect, it, vi } from "vitest";
const { readVisitorAccessMock } = vi.hoisted(() => ({
  readVisitorAccessMock: vi.fn(),
}));
vi.mock("./product-access", () => ({
  readVisitorAccess: readVisitorAccessMock,
}));
import {
  WIDE_SCREEN_BROWSE_ONLY_ENV,
  isWideScreenBrowseOnlyEnabled,
  wideScreenBrowseOnlyHint,
  readAuthPageWideScreenRedirect,
} from "./wide-screen-browse-only";
afterEach(() => {
  vi.unstubAllEnvs();
  readVisitorAccessMock.mockReset();
});
describe("retired wide-screen presentation restriction (#260)", () => {
  it.each([
    undefined,
    "",
    "on",
    "1",
    "true",
    "ON",
    "yes",
    "off",
    "false",
    "0",
    " OFF ",
  ])(
    "cannot reactivate hidden features with legacy setting %j",
    async (value) => {
      vi.stubEnv(WIDE_SCREEN_BROWSE_ONLY_ENV, value);
      expect(isWideScreenBrowseOnlyEnabled(value)).toBe(false);
      expect(isWideScreenBrowseOnlyEnabled()).toBe(false);
      expect(
        wideScreenBrowseOnlyHint({
          state: "granted",
          closedBeta: false,
          token: undefined,
        }),
      ).toBeUndefined();
      await expect(readAuthPageWideScreenRedirect()).resolves.toBe(false);
      expect(readVisitorAccessMock).not.toHaveBeenCalled();
    },
  );
  it("leaves real product access and session data outside presentation decisions", () => {
    for (const closedBeta of [true, false])
      for (const token of [undefined, "synthetic-session-not-a-credential"]) {
        expect(
          wideScreenBrowseOnlyHint({ state: "granted", closedBeta, token }),
        ).toBeUndefined();
      }
  });
});
