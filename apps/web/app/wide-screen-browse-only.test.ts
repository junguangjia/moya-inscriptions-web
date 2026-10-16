import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readVisitorAccessMock } = vi.hoisted(() => ({
  readVisitorAccessMock: vi.fn(),
}));

vi.mock("./product-access", () => ({
  readVisitorAccess: readVisitorAccessMock,
}));

import {
  WIDE_SCREEN_BROWSE_ONLY_ENV,
  isWideScreenBrowseOnlyEnabled,
  readAuthPageWideScreenRedirect,
  wideScreenBrowseOnlyHint,
} from "./wide-screen-browse-only";

import type { VisitorAccess } from "./product-access";

// A synthetic stand-in with the opaque session shape; not a credential.
const visitorSession = "s".repeat(43);

const granted = (
  closedBeta: boolean,
  token: string | undefined = undefined,
): Extract<VisitorAccess, { state: "granted" }> => ({
  state: "granted",
  closedBeta,
  token,
});

beforeEach(() => {
  readVisitorAccessMock.mockReset();
  // Start from an unset switch, whatever the shell running the tests has.
  vi.stubEnv(WIDE_SCREEN_BROWSE_ONLY_ENV, undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe("wide-screen browse-only switch (pc-browse-only-v1)", () => {
  it("is read from MOYA_WIDE_SCREEN_BROWSE_ONLY", () => {
    expect(WIDE_SCREEN_BROWSE_ONLY_ENV).toBe("MOYA_WIDE_SCREEN_BROWSE_ONLY");
  });

  it.each([undefined, "", "on", "1", "true", "ON", "yes"])(
    "is on for %j",
    (value) => {
      expect(isWideScreenBrowseOnlyEnabled(value)).toBe(true);
      vi.stubEnv(WIDE_SCREEN_BROWSE_ONLY_ENV, value);
      expect(isWideScreenBrowseOnlyEnabled()).toBe(true);
    },
  );

  it.each(["off", "false", "0", " OFF ", "False", "\toff\n"])(
    "is off for %j",
    (value) => {
      expect(isWideScreenBrowseOnlyEnabled(value)).toBe(false);
      vi.stubEnv(WIDE_SCREEN_BROWSE_ONLY_ENV, value);
      expect(isWideScreenBrowseOnlyEnabled()).toBe(false);
    },
  );

  it("reads the environment on every call", () => {
    expect(isWideScreenBrowseOnlyEnabled()).toBe(true);
    vi.stubEnv(WIDE_SCREEN_BROWSE_ONLY_ENV, "off");
    expect(isWideScreenBrowseOnlyEnabled()).toBe(false);
    vi.stubEnv(WIDE_SCREEN_BROWSE_ONLY_ENV, "on");
    expect(isWideScreenBrowseOnlyEnabled()).toBe(true);
  });
});

describe("wide-screen browse-only hint for the Formal root", () => {
  it("tells the client only whether a session cookie exists", () => {
    expect(wideScreenBrowseOnlyHint(granted(false))).toEqual({
      sessionHint: false,
    });
    const hint = wideScreenBrowseOnlyHint(granted(false, visitorSession));
    expect(hint).toEqual({ sessionHint: true });
    expect(JSON.stringify(hint)).not.toContain(visitorSession);
  });

  it("does not apply in a closed beta, whose gate needs sign-in", () => {
    expect(wideScreenBrowseOnlyHint(granted(true))).toBeUndefined();
    expect(
      wideScreenBrowseOnlyHint(granted(true, visitorSession)),
    ).toBeUndefined();
  });

  it.each(["off", "false", "0"])("does not apply when switched %s", (value) => {
    vi.stubEnv(WIDE_SCREEN_BROWSE_ONLY_ENV, value);
    expect(wideScreenBrowseOnlyHint(granted(false))).toBeUndefined();
    expect(
      wideScreenBrowseOnlyHint(granted(false, visitorSession)),
    ).toBeUndefined();
  });
});

describe("wide-screen redirect of /login and /register", () => {
  it.each([
    ["the public product without a session", true, granted(false)],
    ["the public product with a session", true, granted(false, visitorSession)],
    ["a closed beta", false, granted(true)],
    ["a closed beta with a session", false, granted(true, visitorSession)],
    ["a visitor asked to sign in", false, { state: "sign_in_required" }],
    [
      "a refused account",
      false,
      {
        state: "restricted",
        account: { displayName: "访碑者", handle: "member-04" },
      },
    ],
    ["an unknown access state", false, { state: "unavailable" }],
  ] as const)(
    "for %s is %s",
    async (_label, expected, access: VisitorAccess) => {
      readVisitorAccessMock.mockResolvedValue(access);
      await expect(readAuthPageWideScreenRedirect()).resolves.toBe(expected);
      expect(readVisitorAccessMock).toHaveBeenCalledOnce();
    },
  );

  it("keeps the form when the access answer is slower than the wait", async () => {
    vi.useFakeTimers();
    try {
      readVisitorAccessMock.mockReturnValue(new Promise(() => undefined));
      const decision = readAuthPageWideScreenRedirect(1_500);
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(decision).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["off", "false", "0"])(
    "asks the Backend nothing when switched %s",
    async (value) => {
      vi.stubEnv(WIDE_SCREEN_BROWSE_ONLY_ENV, value);
      readVisitorAccessMock.mockResolvedValue(granted(false));
      await expect(readAuthPageWideScreenRedirect()).resolves.toBe(false);
      expect(readVisitorAccessMock).not.toHaveBeenCalled();
    },
  );
});
