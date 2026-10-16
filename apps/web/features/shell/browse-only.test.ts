import { describe, expect, it } from "vitest";

import { resolveBrowseOnlySession } from "./browse-only";

describe("browse-only session (pc-browse-only-v1)", () => {
  // viewer, sessionHint, checking, sessionError → session
  it.each([
    // A signed-in viewer keeps everything, whatever else is known.
    [true, false, false, false, true],
    [true, false, true, false, true],
    [true, false, false, true, true],
    [true, false, true, true, true],
    [true, true, false, false, true],
    [true, true, true, false, true],
    [true, true, false, true, true],
    [true, true, true, true, true],
    // No session cookie: no account, even while /me is still asked.
    [false, false, false, false, false],
    [false, false, true, false, false],
    [false, false, false, true, false],
    [false, false, true, true, false],
    // A cookie /me could not check (5xx) is trusted.
    [false, true, false, true, true],
    [false, true, true, true, true],
    // A cookie still waiting for /me is undecided.
    [false, true, true, false, null],
    // A cookie /me refused (401) is no account.
    [false, true, false, false, false],
  ] as const)(
    "resolves viewer %s, cookie %s, checking %s, session error %s to %s",
    (viewer, sessionHint, checking, sessionError, expected) => {
      expect(
        resolveBrowseOnlySession({
          viewer,
          checking,
          sessionError,
          sessionHint,
        }),
      ).toBe(expected);
    },
  );

  it("follows the first /me check of a cookie holder", () => {
    const cookie = { viewer: false, sessionHint: true } as const;
    // Server render and the first client render: /me is pending.
    expect(
      resolveBrowseOnlySession({
        ...cookie,
        checking: true,
        sessionError: false,
      }),
    ).toBeNull();
    // 200: a viewer.
    expect(
      resolveBrowseOnlySession({
        ...cookie,
        viewer: true,
        checking: false,
        sessionError: false,
      }),
    ).toBe(true);
    // 401: an expired session.
    expect(
      resolveBrowseOnlySession({
        ...cookie,
        checking: false,
        sessionError: false,
      }),
    ).toBe(false);
  });
});
