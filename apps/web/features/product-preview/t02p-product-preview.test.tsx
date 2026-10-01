// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentIdentity } from "@moya/contracts";
import type { ProductShellProps } from "../product-shell/product-shell";
import type { PreviewCatalogDetailOverlayProps } from "./preview-catalog-detail-overlay";
import type { T02pDevelopmentCatalogDestinationStates } from "./catalog-scenarios";

const fixture = vi.hoisted(() => ({
  kind: "topic" as "topic" | "work" | "catalog",
  topicId: "synthetic-topic",
  detailState: "missing" as "missing" | "loading" | "unavailable",
  author: null as null | {
    checking: boolean;
    sessionError: boolean;
    viewer: { id: string } | null;
  },
  recover: vi.fn(() => true),
  overlay: null as PreviewCatalogDetailOverlayProps | null,
  restoring: false,
  readerMounts: 0,
}));
vi.mock("../auth/auth-return", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/auth-return")>();
  return {
    ...actual,
    useAuthReturn: () =>
      fixture.restoring ? { isRestoring: () => fixture.restoring } : null,
  };
});
vi.mock("../authors/author-context", () => ({
  useOptionalAuthors: () => fixture.author,
  useAuthors: () =>
    fixture.author ?? { checking: false, sessionError: false, viewer: null },
}));
vi.mock("../product-shell/product-shell", () => ({
  ProductShell: (props: ProductShellProps) =>
    fixture.kind === "topic"
      ? props.renderTopicOverlay?.({
          topicId: fixture.topicId,
          backButtonRef: { current: null },
          onClose: vi.fn(),
        })
      : props.renderDetailOverlay?.({
          target: {
            type: fixture.kind,
            id:
              fixture.kind === "work"
                ? `work-${"a".repeat(32)}`
                : "synthetic-catalog",
          },
          backButtonRef: { current: null },
          initialScrollTop: 0,
          navigationRevision: 0,
          onClose: vi.fn(),
          onScrollTopChange: vi.fn(),
        }),
  useProductShell: () => ({
    feedLayout: "double",
    platform: "phone",
    recoverUnavailableAuthContent: fixture.recover,
  }),
}));
vi.mock("./preview-catalog-detail-overlay", () => ({
  PreviewCatalogDetailOverlay: (props: PreviewCatalogDetailOverlayProps) => {
    fixture.overlay = props;
    return (
      <p data-synthetic-detail="">
        {props.target?.type}:{props.target?.id}
      </p>
    );
  },
}));
vi.mock("../editorial-content/use-editorial-content", () => ({
  isArticleId: (id: string) => /^article-[0-9a-f]{32}$/u.test(id),
  isCollectionId: (id: string) => /^collection-[0-9a-f]{32}$/u.test(id),
  listedArticlePresentation: () => null,
  useArticle: () => ({ state: { state: fixture.detailState }, retry: vi.fn() }),
  useCollection: () => ({
    state: { state: fixture.detailState },
    retry: vi.fn(),
  }),
  useArticles: () => ({
    state: { state: "empty" },
    retry: vi.fn(),
    loadMore: vi.fn(),
    busy: false,
  }),
}));
vi.mock("../threads/use-threads", () => ({
  isThreadId: (id: string) => /^thread-[0-9a-f]{32}$/u.test(id),
  useThread: () => {
    useState(() => {
      fixture.readerMounts++;
      return 0;
    });
    return { state: { state: fixture.detailState }, retry: vi.fn() };
  },
  useThreadPosts: () => ({
    state: { state: "empty" },
    busy: false,
    loadMore: vi.fn(),
  }),
  useThreads: () => ({
    state: { state: "empty" },
    busy: false,
    refresh: vi.fn(),
    loadMore: vi.fn(),
  }),
}));
vi.mock("../publishing/publishing-entry", () => ({
  usePublishingEntry: () => ({ openEditor: vi.fn(), checking: false }),
}));
vi.mock("../publishing/publishing-provider", () => ({
  useSubmission: () => ({ state: { status: "idle" } }),
}));

import { T02pProductPreview } from "./t02p-product-preview";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const states: T02pDevelopmentCatalogDestinationStates = {
  inscriptions: { state: "unavailable" },
  calligraphy: {
    categories: {
      all: { state: "unavailable" },
      ink: { state: "classification-unavailable" },
      rubbing: { state: "classification-unavailable" },
    },
    classificationSource: "qa-synthetic",
  },
  home: {
    discover: { state: "empty" },
    nearby: { state: "empty" },
    topics: { state: "empty" },
  },
};
let root: Root;
let container: HTMLDivElement;
const render = async (topics = states.home.topics) =>
  act(async () =>
    root.render(
      // The author composition, which mounts what live Threads read.
      <T02pProductPreview
        initialPlatform="phone"
        liveThreads
        states={{ ...states, home: { ...states.home, topics } }}
      />,
    ),
  );
beforeEach(() => {
  fixture.kind = "topic";
  fixture.topicId = "synthetic-topic";
  fixture.detailState = "missing";
  fixture.author = null;
  fixture.overlay = null;
  fixture.restoring = false;
  fixture.readerMounts = 0;
  fixture.recover.mockClear();
  window.history.replaceState(null, "", "/dev/t02p");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("authentication source recovery adapters", () => {
  it.each(["catalog", "work"] as const)(
    "passes the actual %s identity into the shared detail overlay",
    async (kind) => {
      fixture.kind = kind;
      await render();
      const expected: ContentIdentity = {
        type: kind,
        id: kind === "work" ? `work-${"a".repeat(32)}` : "synthetic-catalog",
      };
      expect(fixture.overlay?.target).toEqual(expected);
      expect(fixture.overlay?.catalogId).toBe(expected.id);
      expect(fixture.recover).not.toHaveBeenCalled();
    },
  );

  it.each([
    `article-${"b".repeat(32)}`,
    `collection-${"c".repeat(32)}`,
    `thread-${"d".repeat(32)}`,
    "synthetic-topic",
  ])(
    "delegates canonical missing %s only after identity confirmation",
    async (id) => {
      fixture.restoring = true;
      fixture.topicId = id;
      fixture.author = { checking: true, sessionError: false, viewer: null };
      await render();
      expect(fixture.recover).not.toHaveBeenCalled();
      fixture.author = { checking: false, sessionError: true, viewer: null };
      await render();
      expect(fixture.recover).not.toHaveBeenCalled();
      fixture.author = {
        checking: false,
        sessionError: false,
        viewer: { id: "synthetic-confirmed-owner" },
      };
      await render();
      expect(fixture.recover).toHaveBeenCalledOnce();
    },
  );

  it("keeps ordinary topic readers mounted through initial and focus identity checks", async () => {
    fixture.topicId = `thread-${"d".repeat(32)}`;
    fixture.detailState = "loading";
    fixture.author = { checking: true, sessionError: false, viewer: null };
    await render();
    expect(fixture.readerMounts).toBe(1);
    fixture.author = {
      checking: false,
      sessionError: false,
      viewer: { id: "synthetic-confirmed-owner" },
    };
    await render();
    expect(fixture.readerMounts).toBe(1);
    fixture.author = { ...fixture.author, checking: true };
    await render();
    expect(fixture.readerMounts).toBe(1);
    fixture.author = { ...fixture.author, checking: false };
    await render();
    expect(fixture.readerMounts).toBe(1);
  });

  it("re-keys an authentication source once, then keeps it mounted through focus checks and journey retirement", async () => {
    fixture.restoring = true;
    fixture.topicId = `thread-${"d".repeat(32)}`;
    fixture.detailState = "loading";
    fixture.author = { checking: true, sessionError: false, viewer: null };
    await render();
    expect(fixture.readerMounts).toBe(1);
    fixture.author = {
      checking: false,
      sessionError: false,
      viewer: { id: "synthetic-confirmed-owner" },
    };
    await render();
    expect(fixture.readerMounts).toBe(2);
    fixture.author = { ...fixture.author, checking: true };
    await render();
    expect(fixture.readerMounts).toBe(2);
    fixture.restoring = false;
    await render();
    expect(fixture.readerMounts).toBe(2);
    fixture.author = { ...fixture.author, checking: false };
    await render();
    expect(fixture.readerMounts).toBe(2);
  });

  it.each(["loading", "unavailable"] as const)(
    "keeps %s topic reads without declaring the source missing",
    async (state) => {
      fixture.author = { checking: false, sessionError: false, viewer: null };
      fixture.detailState = state;
      for (const id of [
        `article-${"b".repeat(32)}`,
        `collection-${"c".repeat(32)}`,
        `thread-${"d".repeat(32)}`,
      ]) {
        fixture.topicId = id;
        await render();
        expect(fixture.recover).not.toHaveBeenCalled();
      }
      fixture.topicId = "synthetic-topic";
      await render({ state });
      expect(fixture.recover).not.toHaveBeenCalled();
    },
  );
});
