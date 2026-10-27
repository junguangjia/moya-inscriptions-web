import { describe, expect, it } from "vitest";

import {
  readSavedSessions,
  savedSessionsCapacity,
  savedSessionsCookieName,
  savedSessionsRetentionMs,
  serializeClearedSavedSessionsCookie,
  serializeSavedSessionsCookie,
} from "./saved-sessions-cookie";

// Synthetic accounts and opaque tokens only.
const firstToken = "A".repeat(43);
const secondToken = "B_-".repeat(14) + "b";
const shortToken = "short";
const copyToken = "C".repeat(43);
const tokenOf = (index: number) => String(index).repeat(43);
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
/** An older session of the first account, kept until its sign-out is confirmed. */
const firstCopy = { ...first, token: copyToken, expiresAt: now + 30_000 };
const entryOf = (index: number) => ({
  userId: `user-${index.toString(16).repeat(32)}`,
  handle: `account-${index}`,
  token: tokenOf(index),
  expiresAt: now + 60_000,
});
const valueOf = (cookie: string) =>
  cookie.slice(`${savedSessionsCookieName}=`.length).split(";")[0]!;

describe("saved sessions cookie (account-switching-v1)", () => {
  it("stores entries in an HttpOnly host-only cookie that outlives its latest entry", () => {
    const cookie = serializeSavedSessionsCookie([first, second], true);
    expect(savedSessionsCookieName).toBe("yoyi-saved-sessions");
    expect(cookie).toBe(
      `yoyi-saved-sessions=${first.userId}.account-a.${first.token}.${first.expiresAt}~${second.userId}.account-b.${second.token}.${second.expiresAt}; Expires=${new Date(second.expiresAt + savedSessionsRetentionMs).toUTCString()}; Path=/; HttpOnly; SameSite=Lax; Secure`,
    );
    // An account whose session ended is still listed for a week after its
    // ceiling.
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

  it("keeps an older session of an account beside its newer one, up to the capacity", () => {
    const value = valueOf(
      serializeSavedSessionsCookie([first, second, firstCopy], true),
    );
    expect(
      readSavedSessions(`${savedSessionsCookieName}=${value}`).entries,
    ).toEqual([first, second, firstCopy]);
    expect(savedSessionsCapacity).toBe(6);
    const full = Array.from({ length: savedSessionsCapacity }, (_, index) =>
      entryOf(index + 1),
    );
    expect(
      readSavedSessions(
        `${savedSessionsCookieName}=${valueOf(serializeSavedSessionsCookie(full, true))}`,
      ).entries,
    ).toEqual(full);
  });

  it("refuses to store a malformed, repeated or oversized list", () => {
    for (const entries of [
      [{ ...first, token: shortToken }],
      [{ ...first, userId: "user-other" }],
      [{ ...first, handle: "Bad.Handle" }],
      [{ ...first, expiresAt: 12 }],
      [first, { ...second, token: first.token }],
      Array.from({ length: savedSessionsCapacity + 1 }, (_, index) =>
        entryOf(index + 1),
      ),
    ])
      expect(() => serializeSavedSessionsCookie(entries, true)).toThrow();
  });

  it("reads back what it stored next to other cookies", () => {
    const value = valueOf(serializeSavedSessionsCookie([first, second], true));
    expect(
      readSavedSessions(
        `yoyi-session=${"S".repeat(43)}; ${savedSessionsCookieName}=${value}; payload-token=abc`,
      ),
    ).toEqual({ entries: [first, second], stale: false });
    expect(readSavedSessions(undefined)).toEqual({
      entries: [],
      stale: false,
    });
    expect(readSavedSessions(`yoyi-session=${"S".repeat(43)}`)).toEqual({
      entries: [],
      stale: false,
    });
  });

  it("fails closed on anything malformed, so the cookie is cleared", () => {
    const one = `${first.userId}.account-a.${first.token}.${first.expiresAt}`;
    const two = `${second.userId}.account-b.${second.token}.${second.expiresAt}`;
    const seven = Array.from(
      { length: savedSessionsCapacity + 1 },
      (_, index) => {
        const entry = entryOf(index + 1);
        return `${entry.userId}.${entry.handle}.${entry.token}.${entry.expiresAt}`;
      },
    ).join("~");
    for (const value of [
      "",
      "garbage",
      `${one}~`,
      seven,
      `${one}~${one}`,
      `${one}~${two.replace(second.token, first.token)}`,
      one.replace(first.token, "short"),
      one.replace(".account-a.", ".Account-A."),
      one.replace(String(first.expiresAt), "12"),
      `${one} `.replace(" ", "%20"),
      `"${one}"`,
    ])
      expect(readSavedSessions(`${savedSessionsCookieName}=${value}`)).toEqual({
        entries: [],
        stale: true,
      });
    // A repeated cookie is ambiguous: neither copy is trusted.
    expect(
      readSavedSessions(
        `${savedSessionsCookieName}=${one}; ${savedSessionsCookieName}=${two}`,
      ),
    ).toEqual({ entries: [], stale: true });
    expect(readSavedSessions(`yoyi-saved-sessionsx=${one}`).entries).toEqual(
      [],
    );
  });

  it("returns an entry past its ceiling like any other: only the Backend can say it ended", () => {
    const lapsed = { ...first, expiresAt: now - 1 };
    const value = valueOf(serializeSavedSessionsCookie([lapsed, second], true));
    expect(readSavedSessions(`${savedSessionsCookieName}=${value}`)).toEqual({
      entries: [lapsed, second],
      stale: false,
    });
  });
});
