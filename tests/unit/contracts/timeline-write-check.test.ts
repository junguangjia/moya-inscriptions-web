import { describe, expect, it } from "vitest";
import {
  TIMELINE_ENTRIES_MAXIMUM,
  TIMELINE_RESPONSE_BYTES_MAXIMUM,
  checkTimelineEntryWrite,
  estimateTimelineResponseBytes,
  timelineEntrySchema,
  timelineImportEntrySchema,
} from "@moya/contracts/schemas";
import {
  createTimelineEntryCommandSchema,
  updateTimelineEntryCommandSchema,
} from "@moya/contracts/internal/community-operator";

import type { StoredTimelineEntry } from "@moya/contracts/schemas";

/*
 * home-timeline-v1 (Issue #384 r3, review r1): the check every operator write
 * runs refuses only what the write makes worse, and the timeline's text refuses
 * what PostgreSQL cannot store. Rows are synthetic.
 */

const row = (
  id: string,
  overrides: Partial<StoredTimelineEntry> = {},
): StoredTimelineEntry => ({
  id,
  title: `合成${id}`,
  fullTitle: `合成朝合成${id}`,
  startYear: 618,
  endYear: 618,
  precision: "year",
  dateLabel: null,
  onAxis: true,
  chapter: "唐",
  polity: null,
  disputed: false,
  groupId: null,
  groupTitle: null,
  province: null,
  holder: null,
  catalogId: null,
  position: 0,
  ...overrides,
});
/** Fails the import row: 300 UTF-16 units, past the 200 a title holds. */
const broken = (id: string) => row(id, { title: "\u{20000}".repeat(150) });
const update = (
  others: readonly StoredTimelineEntry[],
  before: StoredTimelineEntry,
  after: StoredTimelineEntry,
  hidden = false,
) => ({
  before: [...others, before],
  after: [...others, after],
  changes: [{ before, after, hidden }],
});
const fewRows = { entries: 3, responseBytes: TIMELINE_RESPONSE_BYTES_MAXIMUM };
const fewBytes = { entries: TIMELINE_ENTRIES_MAXIMUM, responseBytes: 1_000 };

describe("the operator write check", () => {
  it("never refuses a write for another stored row that fails the contract", () => {
    const others = [broken("broken-a"), broken("broken-b"), row("tang-a")];
    expect(
      checkTimelineEntryWrite(
        update(others, row("song"), row("song", { dateLabel: "合成纪年" })),
      ),
    ).toEqual({ ok: true });
    // Each broken row is fixed alone while the other is still broken.
    expect(
      checkTimelineEntryWrite(
        update(
          [broken("broken-b"), row("tang-a")],
          broken("broken-a"),
          row("broken-a"),
        ),
      ),
    ).toEqual({ ok: true });
    const created = row("tang-b", { position: 1024 });
    expect(
      checkTimelineEntryWrite({
        before: others,
        after: [...others, created],
        changes: [{ before: null, after: created, hidden: false }],
      }),
    ).toEqual({ ok: true });
  });

  it("lets a write only hide a row that fails, and refuses to show it or change it while it fails", () => {
    const stored = broken("broken");
    expect(
      checkTimelineEntryWrite(update([row("tang-a")], stored, stored, true)),
    ).toEqual({ ok: true });
    for (const [after, hidden] of [
      [stored, false],
      [{ ...stored, dateLabel: "合成纪年" }, true],
      [{ ...stored, position: 1024 }, true],
    ] as const)
      expect(
        checkTimelineEntryWrite(update([row("tang-a")], stored, after, hidden)),
      ).toEqual({ ok: false, issue: { code: "ENTRY_INVALID", index: 0 } });
    expect(
      checkTimelineEntryWrite(
        update([], row("tang-a"), row("tang-a", { endYear: 600 }), true),
      ),
    ).toEqual({ ok: false, issue: { code: "ENTRY_INVALID", index: 0 } });
  });

  it("names a new row that breaks a rule across its fields", () => {
    for (const created of [
      row("ends-early", { startYear: 700, endYear: 650 }),
      row("half-group", { groupId: "group-a" }),
    ])
      expect(
        checkTimelineEntryWrite({
          before: [],
          after: [created],
          changes: [{ before: null, after: created, hidden: false }],
        }),
      ).toEqual({ ok: false, issue: { code: "ENTRY_INVALID", index: 0 } });
  });

  it("refuses a full set only for a write that adds a row", () => {
    const full = [row("a"), row("b"), row("c"), row("d")];
    expect(
      checkTimelineEntryWrite(
        update(full.slice(1), full[0]!, { ...full[0]!, title: "合成改题" }),
        fewRows,
      ),
    ).toEqual({ ok: true });
    const created = row("e");
    expect(
      checkTimelineEntryWrite(
        {
          before: full,
          after: [...full, created],
          changes: [{ before: null, after: created, hidden: false }],
        },
        fewRows,
      ),
    ).toEqual({ ok: false, issue: { code: "TIMELINE_FULL" } });
    expect(
      checkTimelineEntryWrite(
        {
          before: full.slice(2),
          after: [...full.slice(2), created],
          changes: [{ before: null, after: created, hidden: false }],
        },
        fewRows,
      ),
    ).toEqual({ ok: true });
  });

  it("refuses a size past the limit only for a write that grows it", () => {
    const long = "长".repeat(200);
    const rows = [row("a", { title: long }), row("b", { title: long })];
    expect(estimateTimelineResponseBytes(rows)).toBeGreaterThan(
      fewBytes.responseBytes,
    );
    const shorter = { ...rows[0]!, title: "合成" };
    expect(estimateTimelineResponseBytes([shorter, rows[1]!])).toBeGreaterThan(
      fewBytes.responseBytes,
    );
    expect(
      checkTimelineEntryWrite(update([rows[1]!], rows[0]!, shorter), fewBytes),
    ).toEqual({ ok: true });
    expect(
      checkTimelineEntryWrite(
        update([rows[1]!], rows[0]!, { ...rows[0]!, dateLabel: "合成纪年" }),
        fewBytes,
      ),
    ).toEqual({ ok: false, issue: { code: "TIMELINE_TOO_LARGE" } });
    // Growing within the limit passes.
    expect(
      checkTimelineEntryWrite(
        update([], row("a"), row("a", { dateLabel: "合成纪年" })),
        fewBytes,
      ),
    ).toEqual({ ok: true });
  });

  it("holds the contract's limits by default", () => {
    const stored = Array.from(
      { length: TIMELINE_ENTRIES_MAXIMUM },
      (_, index) => row(`row-${index}`),
    );
    const created = row("one-more");
    expect(
      checkTimelineEntryWrite({
        before: stored,
        after: [...stored, created],
        changes: [{ before: null, after: created, hidden: false }],
      }),
    ).toEqual({ ok: false, issue: { code: "TIMELINE_FULL" } });
    expect(estimateTimelineResponseBytes(stored)).toBeLessThan(
      TIMELINE_RESPONSE_BYTES_MAXIMUM,
    );
  });
});

describe("timeline text", () => {
  const valid = row("text-check");
  /** The public row: no position, and its media. */
  const publicOf = (value: object) => ({
    ...Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "position"),
    ),
    media: null,
  });

  it("refuses an unpaired surrogate or a NUL in every text field, and keeps a whole astral character", () => {
    const astral = { ...valid, title: "合成\u{20000}" };
    expect(timelineImportEntrySchema.safeParse(astral).success).toBe(true);
    expect(timelineEntrySchema.safeParse(publicOf(astral)).success).toBe(true);
    for (const field of [
      "title",
      "fullTitle",
      "dateLabel",
      "polity",
      "groupTitle",
      "province",
      "holder",
      "catalogId",
    ] as const)
      for (const text of ["合成\ud800", "\udc00合成", "合\u0000成"]) {
        const value =
          field === "groupTitle"
            ? { ...valid, groupId: "group-a", groupTitle: text }
            : { ...valid, [field]: text };
        expect(
          timelineImportEntrySchema.safeParse(value).success,
          `${field} ${JSON.stringify(text)}`,
        ).toBe(false);
        expect(timelineEntrySchema.safeParse(publicOf(value)).success).toBe(
          false,
        );
      }
  });

  it("refuses it in the operator commands, so the Backend answers it as a malformed command", () => {
    const create = {
      requestId: "00000000-0000-4000-8000-000000000000",
      ...valid,
    };
    expect(createTimelineEntryCommandSchema.safeParse(create).success).toBe(
      true,
    );
    expect(
      createTimelineEntryCommandSchema.safeParse({
        ...create,
        title: "合成\ud800",
      }).success,
    ).toBe(false);
    expect(
      updateTimelineEntryCommandSchema.safeParse({
        requestId: create.requestId,
        expectedVersion: 1,
        dateLabel: "合成\udfff",
      }).success,
    ).toBe(false);
  });
});
