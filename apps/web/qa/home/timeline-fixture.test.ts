import { describe, expect, it, vi } from "vitest";

import { authorClient } from "../../features/authors/author-data";
import {
  TIMELINE_CHAPTERS,
  buildShelfSections,
  buildTimelineIndex,
  buildTimelineRows,
} from "../../features/home/timeline/timeline-model";
import { createVisualCatalogItems } from "../home-catalog-scenarios";
import { createTimelineFixture } from "./timeline-fixture";

const origin = "http://localhost:3100";
const records = createVisualCatalogItems(origin);
const fixture = createTimelineFixture(origin, records);
const index = buildTimelineIndex(fixture);
const rows = buildTimelineRows(index);

describe("timeline QA fixture", () => {
  it("passes the public contract at about 420 rows", async () => {
    // The client parses every answer with the contract's `timelineSchema`.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ entries: fixture }))),
    );
    await expect(authorClient.timeline()).resolves.toEqual({
      entries: fixture,
    });
    vi.unstubAllGlobals();
    expect(fixture.length).toBeGreaterThanOrEqual(400);
    expect(fixture.length).toBeLessThanOrEqual(440);
    expect(new Set(fixture.map(({ id }) => id)).size).toBe(fixture.length);
  });

  it("is deterministic", () => {
    expect(createTimelineFixture(origin, records)).toEqual(fixture);
  });

  it("stays fictional", () => {
    for (const row of fixture) {
      if (row.catalogId !== null) continue;
      expect(row.title.startsWith("虚构")).toBe(true);
      if (row.province !== null) expect(row.province).toMatch(/^虚构/u);
      if (row.holder !== null) expect(row.holder).toMatch(/^虚构/u);
    }
  });

  it("orders rows as the API does", () => {
    fixture.forEach((row, at) => {
      if (at > 0)
        expect(row.startYear).toBeGreaterThanOrEqual(
          fixture[at - 1]!.startYear,
        );
    });
  });

  it("keeps the same empty chapters as the real list", () => {
    const empty = TIMELINE_CHAPTERS.map(({ chapter }) => chapter).filter(
      (chapter) => !index.counts.has(chapter),
    );
    expect(empty).toEqual(["商", "西周", "春秋", "当代"]);
    expect(index.onAxis.get("战国")).toBeUndefined();
    expect(index.shelf.get("战国")?.length).toBeGreaterThan(0);
  });

  it("covers every precision, row kind and tag", () => {
    expect(new Set(fixture.map(({ precision }) => precision))).toEqual(
      new Set(["year", "reign", "period", "multi", "dynasty"]),
    );
    expect(fixture.some(({ disputed }) => disputed)).toBe(true);
    expect(new Set(rows.map(({ kind }) => kind))).toEqual(
      new Set(["head", "empty", "marker", "entry", "group", "gap", "shelf"]),
    );
  });

  it("folds groups of 23, 3 and 10, and one more on a shelf", () => {
    const sizes = rows.flatMap((row) =>
      row.kind === "group" ? [row.entries.length] : [],
    );
    expect(sizes.sort((a, b) => a - b)).toEqual([3, 10, 23]);
    const spanning = rows.find(
      (row) => row.kind === "group" && row.entries.length === 10,
    );
    expect(spanning).toMatchObject({ year: 175, endYear: 183, mark: "bar" });

    const shelfItems = buildShelfSections(
      index.shelf.get("南北朝") ?? [],
      "place",
    ).flatMap(({ items }) => items);
    expect(shelfItems.some(({ type }) => type === "group")).toBe(true);
  });

  it("leaves a pair sharing an id as plain rows", () => {
    const pair = rows.filter(
      (row) => row.kind === "entry" && row.entry.groupId === "qa-tl-pair",
    );
    expect(pair).toHaveLength(2);
  });

  it("has gaps of 20 years or more, one across the missing year 0", () => {
    const gaps = rows.flatMap((row) => (row.kind === "gap" ? [row.years] : []));
    expect(gaps).toEqual(expect.arrayContaining([93, 25, 32]));
    expect(gaps.every((years) => years >= 20)).toBe(true);
  });

  it("shows all nine rows of its crowded year", () => {
    const crowded = rows.filter(
      (row) => row.kind === "entry" && row.chapter === "唐" && row.year === 720,
    );
    expect(crowded).toHaveLength(9);
  });

  it("shares a reign title across chapters", () => {
    const chapters = new Set(
      fixture
        .filter(({ dateLabel }) => dateLabel?.startsWith("太玄"))
        .map(({ chapter }) => chapter),
    );
    expect(chapters.size).toBeGreaterThan(1);
  });

  it("shows both image shapes from the given origin, with or without records", () => {
    const plain = createTimelineFixture(origin);
    expect(plain.every(({ catalogId }) => catalogId === null)).toBe(true);
    for (const rows of [plain, fixture]) {
      const media = rows.flatMap(({ media }) => media ?? []);
      expect(media.some(({ width, height }) => width > height)).toBe(true);
      expect(media.some(({ width, height }) => height > width)).toBe(true);
      expect(media.every(({ src }) => src.startsWith(`${origin}/`))).toBe(true);
    }
    expect(
      plain.find(({ startYear }) => startYear === 140)?.media,
    ).toMatchObject({
      width: 600,
      height: 420,
    });
    expect(
      plain.find(({ startYear }) => startYear === 456)?.media,
    ).toMatchObject({
      width: 360,
      height: 610,
    });
  });

  it("links each visual record once, with its own media or text only", () => {
    const linked = fixture.filter(({ catalogId }) => catalogId !== null);
    const ids = linked.map(({ catalogId }) => catalogId);
    expect(linked.length).toBe(records.length);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of linked) {
      const record = records.find(({ id }) => id === row.catalogId);
      expect(row.title).toBe(record?.title);
      if (row.groupId === null)
        expect(row.media).toEqual(record?.representativeMedia ?? null);
    }
    expect(linked.some(({ media }) => media === null)).toBe(true);
    expect(linked.some(({ media }) => media !== null)).toBe(true);
  });
});
