// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TopicCard } from "./topic-card";
import { TopicDetail } from "./topic-detail";

import type { CatalogId, CatalogSummary, MediaId } from "@moya/contracts";
import type { Root } from "react-dom/client";
import type { EditorialTopic, Topic } from "./topic";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

const renderClient = (node: React.ReactNode) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return container;
};

const media = {
  alt: "专题演示图",
  height: 400,
  id: "topic-media" as MediaId,
  kind: "image" as const,
  src: "https://example.invalid/topic.svg",
  width: 600,
};

const editorial: EditorialTopic = {
  blurb: "专题摘要",
  blocks: [
    { text: "导语", type: "lead" },
    { text: "正文", type: "rich-text" },
    { text: "引文", type: "quote" },
    { caption: "图注", media, type: "image" },
    { caption: "视频占位", type: "video" },
  ],
  cover: media,
  id: "topic-editorial",
  kind: "editorialTopic",
  title: "策展专题",
};

const renderDetail = (topic: Topic | null) =>
  renderToStaticMarkup(
    <TopicDetail
      backButtonRef={createRef<HTMLButtonElement>()}
      feedLayout="double"
      onClose={vi.fn()}
      platform="phone"
      topic={topic}
    />,
  );

describe("Topic components", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("exposes the entire Topic card as one native button", () => {
    const markup = renderToStaticMarkup(
      <TopicCard onOpen={vi.fn()} topic={editorial} />,
    );
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).toContain('data-topic-id="topic-editorial"');
    expect(markup).toContain("策展专题");
    expect(markup).toContain("专题/策展");
    expect(markup).not.toContain('role="listitem" type="button"');
  });

  it("renders the bounded editorial blocks in source order", () => {
    const markup = renderDetail(editorial);
    const positions = [
      'data-topic-block="lead"',
      'data-topic-block="rich-text"',
      'data-topic-block="quote"',
      'data-topic-block="image"',
      'data-topic-block="video"',
    ].map((marker) => markup.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(
      [...positions].sort((left, right) => left - right),
    );
  });

  it("renders a Catalog collection without inventing a Detail action", () => {
    const record: CatalogSummary = {
      aliases: [],
      id: "catalog-collection-item" as CatalogId,
      kind: "inscription",
      title: "集合条目",
    };
    const markup = renderDetail({
      blurb: "集合摘要",
      id: "topic-collection",
      kind: "catalogCollection",
      records: [record],
      title: "集合专题",
    });
    expect(markup).toContain("data-topic-collection");
    expect(markup).toContain("集合条目");
    expect(markup).not.toContain("data-open-catalog");
  });

  it("uses a truthful bounded not-found state for an invalid TopicId", () => {
    const markup = renderDetail(null);
    expect(markup).toContain('data-topic-detail-state="not-found"');
    expect(markup).toContain("未找到这个专题");
  });

  it("preserves failed Topic cover geometry", () => {
    const container = renderClient(
      <TopicCard onOpen={vi.fn()} topic={editorial} />,
    );
    act(() =>
      container
        .querySelector("img")
        ?.dispatchEvent(new Event("error", { bubbles: true })),
    );
    expect(
      container.querySelector<HTMLElement>('[data-topic-cover-state="failed"]')
        ?.style.aspectRatio,
    ).toBe("600 / 400");
  });

  it("preserves failed Topic block geometry and caption", () => {
    const container = renderClient(
      <TopicDetail
        backButtonRef={createRef<HTMLButtonElement>()}
        feedLayout="double"
        onClose={vi.fn()}
        platform="phone"
        topic={editorial}
      />,
    );
    const block = container.querySelector<HTMLElement>(
      '[data-topic-block="image"]',
    )!;
    act(() =>
      block
        .querySelector("img")
        ?.dispatchEvent(new Event("error", { bubbles: true })),
    );
    expect(
      block.querySelector<HTMLElement>(
        '[data-topic-block-media-state="failed"]',
      )?.style.aspectRatio,
    ).toBe("600 / 400");
    expect(block.querySelector("figcaption")?.textContent).toBe("图注");
  });

  // unified-media-pipeline-v1: the tolerant Topic guard keeps candidates.
  it("offers a block image its inline candidates and loads it lazily", () => {
    const candidate = (width: number, height: number) => ({
      src: `https://example.invalid/topic-${width}.webp`,
      width,
      height,
      contentType: "image/webp" as const,
    });
    const responsive = {
      ...media,
      src: candidate(600, 400).src,
      renditions: [
        candidate(300, 200),
        candidate(600, 400),
        candidate(1200, 800),
      ],
    };
    const markup = renderDetail({
      ...editorial,
      blocks: [{ caption: "图注", media: responsive, type: "image" }],
    });
    expect(markup).toContain(`src="${responsive.src}"`);
    expect(markup).toContain(
      `srcSet="https://example.invalid/topic-300.webp 300w, ${responsive.src} 600w"`,
    );
    expect(markup).toContain(
      'sizes="(min-width: 760px) 728px, calc(100vw - 32px)"',
    );
    expect(markup).toContain('loading="lazy"');
    expect(markup).not.toContain("topic-1200.webp");
  });
});
