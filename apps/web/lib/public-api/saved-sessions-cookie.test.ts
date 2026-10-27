import { describe, expect, it } from "vitest";

import {
  readSavedSessions,
  savedSessionsCookieName,
  savedSessionsRetentionMs,
  serializeClearedSavedSessionsCookie,
  serializeSavedSessionsCookie,
} from "./saved-sessions-cookie";

// Synthetic accounts and opaque tokens only.
const firstToken = "A".repeat(43);
const secondToken = "B_-".repeat(14) + "b";
const shortToken = "short";
const now = Date.parse("2026-10-27T00:00:00.000Z");
const first = {
  userId: `user-${"a".repeat(32)}`,
  handle: "account-a",
  token: firstToken,
  expiresAt: now + 60_000,
};
const second = {
  userId: `user-${"b".repeat(32)}`,
  handle: "account-b",
  token: secondToken,
  expiresAt: now + 120_000,
};
const valueOf = (cookie: string) =>
  cookie.slice(`${savedSessionsCookieName}=`.length).split(";")[0]!;

describe("saved sessions cookie (account-switching-v1)", () => {
  it("stores at most two entries in an HttpOnly host-only cookie that outlives its latest entry", () => {
    const cookie = serializeSavedSessionsCookie([first, second], true);
    expect(savedSessionsCookieName).toBe("yoyi-saved-sessions");
    expect(cookie).toBe(
      `yoyi-saved-sessions=${first.userId}.account-a.${first.token}.${first.expiresAt}~${second.userId}.account-b.${second.token}.${second.expiresAt}; Expires=${new Date(second.expiresAt + savedSessionsRetentionMs).toUTCString()}; Path=/; HttpOnly; SameSite=Lax; Secure`,
    );
    // A lapsed entry is still reported for a week after its ceiling.
    expect(savedSessionsRetentionMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(cookie).not.toMatch(/Domain=/iu);
    expect(serializeSavedSessionsCookie([first], false)).not.toContain(
      "Secure",
    );
    expect(serializeSavedSessionsCookie([], true)).toBe(
      serializeClearedSavedSessionsCookie(true),
    );
    expect(serializeClearedSavedSessionsCookie(false)).toBe(
      "yoyi-saved-sessions=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
    );
  });

  it("refuses to store a malformed, duplicated or oversized list", () => {
    for (const entries of [
      [{ ...first, token: shortToken }],
      [{ ...first, userId: "user-other" }],
      [{ ...first, handle: "Bad.Handle" }],
      [{ ...first, expiresAt: 12 }],
      [first, { ...second, userId: first.userId }],
      [first, { ...second, token: first.token }],
      [first, second, { ...second, userId: `user-${"c".repeat(32)}` }],
    ])
      expect(() => serializeSavedSessionsCookie(entries, true)).toThrow();
  });

  it("reads back what it stored next to other cookies", () => {
    const value = valueOf(serializeSavedSessionsCookie([first, second], true));
    expect(
      readSavedSessions(
        `yoyi-session=${"S".repeat(43)}; ${savedSessionsCookieName}=${value}; payload-token=abc`,
        now,
      ),
    ).toEqual({ entries: [first, second], lapsed: [], stale: false });
    expect(readSavedSessions(undefined, now)).toEqual({
      entries: [],
      lapsed: [],
      stale: false,
    });
    expect(readSavedSessions(`yoyi-session=${"S".repeat(43)}`, now)).toEqual({
      entries: [],
      lapsed: [],
      stale: false,
    });
  });

  it("fails closed on anything malformed, so the cookie is cleared", () => {
    const one = `${first.userId}.account-a.${first.token}.${first.expiresAt}`;
    const two = `${second.userId}.account-b.${second.token}.${second.expiresAt}`;
    for (const value of [
      "",
      "garbage",
      `${one}~`,
      `${one}~${two}~${one.replace("a".repeat(32), "c".repeat(32))}`,
      `${one}~${one}`,
      one.replace(first.token, "short"),
      one.replace(".account-a.", ".Account-A."),
      one.replace(String(first.expiresAt), "12"),
      `${one} `.replace(" ", "%20"),
      `"${one}"`,
    ])
      expect(
        readSavedSessions(`${savedSessionsCookieName}=${value}`, now),
      ).toEqual({ entries: [], lapsed: [], stale: true });
    // A repeated cookie is ambiguous: neither copy is trusted.
    expect(
      readSavedSessions(
        `${savedSessionsCookieName}=${one}; ${savedSessionsCookieName}=${two}`,
        now,
      ),
    ).toEqual({ entries: [], lapsed: [], stale: true });
    expect(
      readSavedSessions(`yoyi-saved-sessionsx=${one}`, now).entries,
    ).toEqual([]);
  });

  it("keeps entries past their ceiling apart as lapsed, so they can still be reported", () => {
    const value = valueOf(serializeSavedSessionsCookie([first, second], true));
    expect(
      readSavedSessions(`${savedSessionsCookieName}=${value}`, first.expiresAt),
    ).toEqual({ entries: [second], lapsed: [first], stale: false });
    expect(
      readSavedSessions(
        `${savedSessionsCookieName}=${value}`,
        second.expiresAt + 1,
      ),
    ).toEqual({ entries: [], lapsed: [first, second], stale: false });
  });
});
