import { describe, expect, it } from "vitest";

import {
  createDevelopmentHomeData,
  createDevelopmentHomeScenario,
} from "./home-scenarios";

import type { CatalogId, CatalogSummary } from "@moya/contracts";

const catalogRecord: CatalogSummary = {
  aliases: [],
  id: "catalog-development-source" as CatalogId,
  kind: "inscription",
  title: "开发期 Catalog 条目",
};

describe("Development Home sources", () => {
  it("composes a tall fictional Timeline and both explicit Topic kinds", () => {
    const data = createDevelopmentHomeData("http://localhost:3100", {
      items: [catalogRecord],
      state: "populated",
    });

    expect(data.timeline.state).toBe("populated");
    if (data.timeline.state === "populated") {
      // Scroll restoration specs need a panel far taller than any viewport.
      expect(data.timeline.items.length).toBeGreaterThanOrEqual(400);
      expect(new Set(data.timeline.items.map(({ id }) => id)).size).toBe(
        data.timeline.items.length,
      );
      expect(data.timeline.items.some(({ startYear }) => startYear === 0)).toBe(
        false,
      );
      expect(
        data.timeline.items.some(
          ({ catalogId }) => catalogId === catalogRecord.id,
        ),
      ).toBe(false);
      // Demo images come from the origin the request gave the fixture.
      const media = data.timeline.items.flatMap(({ media }) => media ?? []);
      expect(media.length).toBeGreaterThan(0);
      expect(
        media.every(({ src }) => src.startsWith("http://localhost:3100/")),
      ).toBe(true);
    }

    expect(data.topics.state).toBe("populated");
    if (data.topics.state === "populated") {
      expect(new Set(data.topics.items.map(({ kind }) => kind))).toEqual(
        new Set(["editorialTopic", "catalogCollection"]),
      );
      const collection = data.topics.items.find(
        ({ kind }) => kind === "catalogCollection",
      );
      expect(collection?.kind).toBe("catalogCollection");
      if (collection?.kind === "catalogCollection") {
        expect(collection.records.map(({ id }) => id)).toEqual([
          catalogRecord.id,
        ]);
      }
    }
  });

  it("keeps unavailable and long-block scenarios explicit and bounded", () => {
    const unavailable = createDevelopmentHomeScenario(
      "timeline-unavailable",
      "http://localhost:3100",
      [catalogRecord],
    );
    expect(unavailable.initialFeed).toBe("timeline");
    expect(unavailable.data.timeline).toEqual({ state: "unavailable" });

    const demo = createDevelopmentHomeScenario(
      "timeline-demo",
      "http://localhost:3100",
      [catalogRecord],
    );
    expect(demo.initialFeed).toBe("timeline");
    expect(demo.data.timeline.state).toBe("populated");

    const longBlocks = createDevelopmentHomeScenario(
      "topic-long-blocks",
      "http://localhost:3100",
      [catalogRecord],
    );
    expect(longBlocks.initialFeed).toBe("discover");
    expect(longBlocks.initialTopicId).toBe("topic-cliff-paths");
    if (longBlocks.data.topics.state === "populated") {
      const topic = longBlocks.data.topics.items.find(
        ({ id }) => id === longBlocks.initialTopicId,
      );
      expect(topic?.kind).toBe("editorialTopic");
      if (topic?.kind === "editorialTopic") {
        expect(topic.blocks.map(({ type }) => type)).toEqual([
          "lead",
          "image",
          "rich-text",
          "quote",
          "video",
        ]);
      }
    }
  });
});
