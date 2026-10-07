import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MediaId } from "@moya/contracts";
import { HomeContentCard } from "./home-content-card";
import { MEDIA_SIZES } from "../media/responsive-media";
import { TopicCard } from "../topics/topic-card";
import { ContentQuickActionsProvider } from "../quick-actions/content-quick-actions";
import { quickActionContentKey } from "../quick-actions/quick-action-types";

const nearby = { id: "same-id", title: "附近内容" };
const topic = {
  id: "same-id",
  title: "专题内容",
  kind: "editorialTopic" as const,
  blurb: "简介",
  blocks: [],
};

describe("bounded Nearby and Topic quick actions", () => {
  it("keeps non-QA Nearby noninteractive and Topic's original short-press button", () => {
    const card = renderToStaticMarkup(<HomeContentCard item={nearby} />);
    const cover = renderToStaticMarkup(
      <TopicCard topic={topic} onOpen={() => undefined} />,
    );
    expect(card).not.toContain("<button");
    expect(card + cover).not.toContain("data-quick-actions");
    expect(cover.match(/<button/g)).toHaveLength(1);
    expect(cover).toContain('data-topic-id="same-id"');
  });

  it("uses one QA button per card and never presents a fake Catalog opener", () => {
    const html = renderToStaticMarkup(
      <ContentQuickActionsProvider
        environment={{
          likedIds: [],
          favoriteIds: [],
          onAction: () => undefined,
        }}
      >
        <HomeContentCard item={nearby} />
        <TopicCard topic={topic} onOpen={() => undefined} />
      </ContentQuickActionsProvider>,
    );
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html.match(/data-quick-actions="enabled"/g)).toHaveLength(2);
    expect(html).not.toContain("data-open-catalog");
    expect(html).toContain('data-quick-action-content-kind="nearby"');
    expect(html).toContain('data-quick-action-content-kind="topic"');
  });

  it("separates feedback by type and ID without delimiter collisions", () => {
    const keys = ["catalog", "nearby", "topic"].map((kind) =>
      quickActionContentKey({
        kind: kind as "catalog" | "nearby" | "topic",
        id: "same-id",
        title: "",
      }),
    );
    expect(new Set(keys).size).toBe(3);
    expect(
      quickActionContentKey({ kind: "nearby", id: "topic:x", title: "" }),
    ).not.toBe(
      quickActionContentKey({ kind: "topic", id: "nearby:x", title: "" }),
    );
  });
});

/* unified-media-pipeline-v1 (CW13): Nearby and Topic cards are covered boxes. */
describe("Nearby and Topic card media", () => {
  const origin = "https://media.example.invalid/nearby";
  const media = {
    id: "nearby-media" as MediaId,
    kind: "image" as const,
    alt: "附近图像",
    src: `${origin}/1200.webp`,
    width: 1200,
    height: 900,
    placeholderColor: "#5f6f58",
    renditions: [
      {
        src: `${origin}/480.webp`,
        width: 480,
        height: 360,
        contentType: "image/webp" as const,
      },
      {
        src: `${origin}/1200.webp`,
        width: 1200,
        height: 900,
        contentType: "image/webp" as const,
      },
    ],
  };

  it("offers card candidates with the anchor as src and paints the asset colour", () => {
    const card = renderToStaticMarkup(
      <HomeContentCard item={{ ...nearby, media }} />,
    );
    expect(card).toContain(`src="${origin}/1200.webp"`);
    expect(card).toContain(
      `srcSet="${origin}/480.webp 480w, ${origin}/1200.webp 1200w"`,
    );
    expect(card).toContain(`sizes="${MEDIA_SIZES.feedCard(media)}"`);
    expect(card).toContain("background-color:#5f6f58");
    const cover = renderToStaticMarkup(
      <TopicCard topic={{ ...topic, cover: media }} onOpen={() => undefined} />,
    );
    expect(cover).toContain(
      `srcSet="${origin}/480.webp 480w, ${origin}/1200.webp 1200w"`,
    );
    expect(cover).toContain(`sizes="${MEDIA_SIZES.topicCard(null)}"`);
    expect(cover).toContain("background-color:#5f6f58");
  });
});
