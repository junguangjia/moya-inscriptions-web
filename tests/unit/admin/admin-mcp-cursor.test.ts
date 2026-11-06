import {
  ADMIN_CURSOR_LEGACY_UNTIL,
  ADMIN_CURSOR_PREFIXES,
  decodeCursor,
  encodeCursor,
  indexCursor,
  indexOfCursor,
  LIST_SOURCES,
  offsetCursor,
  offsetOfCursor,
  ROW_ID_MAX,
  rowCursor,
  rowIdOfCursor,
  runCursor,
  runKeysetOfCursor,
} from "admin/admin-mcp";
import { describe, expect, it } from "vitest";

/**
 * admin_read's cursors carry their format (admin-mcp-completion-v1 S8): `k1:` for a
 * row's keyset and `o1:` for an offset, over a base64url JSON payload. A bare cursor,
 * the form before, is read until its last day and refused after it, so a client that
 * still holds one goes on, and no other format is ever read as this one.
 */

const DAY_BEFORE_THE_LAST = new Date("2026-11-06T12:00:00Z");
const LAST_DAY = new Date(`${ADMIN_CURSOR_LEGACY_UNTIL}T23:59:59Z`);
const DAY_AFTER = new Date(
  new Date(`${ADMIN_CURSOR_LEGACY_UNTIL}T00:00:00Z`).getTime() + 86_400_000,
);

const base64url = (text: string) =>
  Buffer.from(text, "utf8").toString("base64url");

describe("a cursor", () => {
  it("is always written with its prefix, and reads back as written", () => {
    expect(rowCursor(42)).toBe(`k1:${base64url('{"id":42}')}`);
    expect(offsetCursor(200)).toBe(`o1:${base64url('{"offset":200}')}`);
    expect(rowIdOfCursor(rowCursor(42))).toBe(42);
    expect(rowIdOfCursor(rowCursor(ROW_ID_MAX))).toBe(ROW_ID_MAX);
    expect(offsetOfCursor(offsetCursor(0))).toBe(0);
    expect(offsetOfCursor(offsetCursor(200))).toBe(200);
    expect(
      decodeCursor(encodeCursor("keyset", { at: "x", id: "y" }), "keyset"),
    ).toEqual({ payload: { at: "x", id: "y" } });
    for (const prefix of Object.values(ADMIN_CURSOR_PREFIXES))
      expect(prefix).toMatch(/^[a-z]1:$/u);
  });

  it("is refused under another kind, another version or an unknown prefix", () => {
    const row = rowCursor(42);
    const offset = offsetCursor(42);
    expect(decodeCursor(offset, "keyset")).toBeUndefined();
    expect(decodeCursor(row, "offset")).toBeUndefined();
    expect(rowIdOfCursor(offset)).toBeUndefined();
    expect(offsetOfCursor(row)).toBeUndefined();
    for (const cursor of [
      `k2:${base64url('{"id":42}')}`,
      `o2:${base64url('{"offset":42}')}`,
      `x1:${base64url('{"id":42}')}`,
    ]) {
      expect(rowIdOfCursor(cursor), cursor).toBeUndefined();
      expect(offsetOfCursor(cursor), cursor).toBeUndefined();
    }
  });

  it("is refused when its payload is not one canonical JSON object", () => {
    for (const body of [
      "",
      "not base64!",
      base64url("not json"),
      base64url("[42]"),
      base64url("42"),
      base64url("null"),
      // The same bytes spelled another way: base64 padding, and stray bits.
      `${base64url('{"id":42}')}=`,
      `${base64url('{"id":4')}x`,
    ])
      expect(decodeCursor(`k1:${body}`, "keyset"), body).toBeUndefined();
  });

  it("names a row id or an offset only within its bounds, and nothing beside it", () => {
    for (const payload of [
      { id: 0 },
      { id: -1 },
      { id: 1.5 },
      { id: "42" },
      { id: ROW_ID_MAX + 1 },
      { id: 42, extra: true },
      {},
    ])
      expect(
        rowIdOfCursor(encodeCursor("keyset", payload)),
        JSON.stringify(payload),
      ).toBeUndefined();
    for (const payload of [
      { offset: -1 },
      { offset: 1_000_000_000 },
      { offset: "5" },
      { offset: 5, id: 1 },
    ])
      expect(
        offsetOfCursor(encodeCursor("offset", payload)),
        JSON.stringify(payload),
      ).toBeUndefined();
  });

  it("reads a bare one, as the old form wrote it, through its last day", () => {
    for (const now of [DAY_BEFORE_THE_LAST, LAST_DAY]) {
      expect(rowIdOfCursor("42", now)).toBe(42);
      expect(rowIdOfCursor(String(ROW_ID_MAX), now)).toBe(ROW_ID_MAX);
      expect(offsetOfCursor("200", now)).toBe(200);
      expect(offsetOfCursor("0", now)).toBe(0);
      // The old form's own bounds still hold.
      for (const cursor of ["0", "042", String(ROW_ID_MAX + 1), "1; DROP"])
        expect(rowIdOfCursor(cursor, now), cursor).toBeUndefined();
      for (const cursor of ["1234567890", "-1", "1e3"])
        expect(offsetOfCursor(cursor, now), cursor).toBeUndefined();
    }
  });

  it("refuses a bare one after its last day, and still reads a prefixed one", () => {
    expect(rowIdOfCursor("42", DAY_AFTER)).toBeUndefined();
    expect(offsetOfCursor("200", DAY_AFTER)).toBeUndefined();
    expect(rowIdOfCursor(rowCursor(42), DAY_AFTER)).toBe(42);
    expect(offsetOfCursor(offsetCursor(200), DAY_AFTER)).toBe(200);
  });
});

// list.runs (S8-10): a run's place is its creation to the microsecond and its id, a
// target's its index. Neither was ever written bare, so a bare one names neither.
describe("a run's cursor and a target's", () => {
  const RUN = "8c3f1e2a-1234-4abc-8def-0123456789ab";
  const AT = "2026-11-06T10:30:00.123456Z";

  it("reads back as written, fits admin_read's cursor, and holds nothing else", () => {
    const cursor = runCursor({ at: AT, id: RUN });
    expect(cursor).toBe(`k1:${base64url(`{"at":"${AT}","id":"${RUN}"}`)}`);
    expect(cursor.length).toBeLessThanOrEqual(128);
    expect(runKeysetOfCursor(cursor)).toEqual({ at: AT, id: RUN });
    expect(indexCursor(0)).toBe(`k1:${base64url('{"index":0}')}`);
    expect(indexOfCursor(indexCursor(0))).toBe(0);
    expect(indexOfCursor(indexCursor(4_999))).toBe(4_999);
  });

  it("is never read as another kind, nor another kind as it", () => {
    const run = runCursor({ at: AT, id: RUN });
    expect(rowIdOfCursor(run)).toBeUndefined();
    expect(indexOfCursor(run)).toBeUndefined();
    expect(runKeysetOfCursor(rowCursor(42))).toBeUndefined();
    expect(runKeysetOfCursor(indexCursor(42))).toBeUndefined();
    expect(indexOfCursor(rowCursor(42))).toBeUndefined();
    expect(rowIdOfCursor(indexCursor(42))).toBeUndefined();
    expect(runKeysetOfCursor(offsetCursor(42))).toBeUndefined();
    for (const cursor of ["42", "0"]) {
      expect(runKeysetOfCursor(cursor, DAY_BEFORE_THE_LAST)).toBeUndefined();
      expect(indexOfCursor(cursor, DAY_BEFORE_THE_LAST)).toBeUndefined();
    }
  });

  it("names a run only by a whole microsecond time and a lower-case uuid", () => {
    for (const payload of [
      { at: "2026-11-06T10:30:00.123Z", id: RUN },
      { at: "2026-11-06 10:30:00.123456+00", id: RUN },
      { at: AT, id: RUN.toUpperCase() },
      { at: AT, id: "not-a-run" },
      { at: AT, id: RUN, extra: 1 },
      { at: AT },
      { id: RUN },
    ])
      expect(
        runKeysetOfCursor(encodeCursor("keyset", payload)),
        JSON.stringify(payload),
      ).toBeUndefined();
    for (const payload of [{ index: -1 }, { index: 1.5 }, { index: "3" }, {}])
      expect(
        indexOfCursor(encodeCursor("keyset", payload)),
        JSON.stringify(payload),
      ).toBeUndefined();
  });
});

interface ObjectSchema {
  readonly shape: Readonly<Record<string, unknown>>;
}

describe("a CMS list source's filter table", () => {
  it.each(Object.keys(LIST_SOURCES) as (keyof typeof LIST_SOURCES)[])(
    "has exactly the keys %s's filter takes",
    (name) => {
      const source = LIST_SOURCES[name];
      // The schema's own keys; this package reads zod's shape and does not import it.
      const { filter } = (source.input as unknown as ObjectSchema).shape as {
        readonly filter: { unwrap: () => ObjectSchema };
      };
      expect(Object.keys(source.filters).sort()).toEqual(
        Object.keys(filter.unwrap().shape).sort(),
      );
    },
  );
});
