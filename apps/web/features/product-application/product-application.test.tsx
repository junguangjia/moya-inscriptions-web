import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProductApplication } from "./product-application";
import { DiscoveryFeed, FilteredInscriptions } from "../authors/discovery-feed";
import { MessageTrigger } from "../authors/message-center";
import { DiscussionSection } from "../authors/discussion-section";
import { CreateWorkAction } from "../publishing/create-action";
import { renderEditorOverlay } from "../publishing/ui/editor/editor-overlay";
import {
  CatalogSearchHeaderAction,
  CatalogSearchNavigationAction,
} from "../search/catalog-search";

import type { ReactElement } from "react";

import type { T02pProductPreviewProps } from "../product-preview/t02p-product-preview";

const { previewMock, providersMock } = vi.hoisted(() => ({
  previewMock: vi.fn(),
  providersMock: vi.fn(),
}));

vi.mock("../product-preview/t02p-product-preview", async () => {
  const { useUploadSession } =
    await import("../publishing/publishing-provider");
  const { useEditorSessionRegistry } =
    await import("../publishing/ui/editor/editor-session-provider");
  return {
    T02pProductPreview: (props: unknown) => {
      previewMock(props);
      // Whether the shell (and so the editor overlay) renders inside the
      // publishing runtime and the editor session registry.
      let inside = true;
      try {
        useUploadSession();
        useEditorSessionRegistry();
      } catch {
        inside = false;
      }
      providersMock(inside);
      return <div data-clean-product-preview="" />;
    },
  };
});

const states = {
  identity: "states",
} as unknown as T02pProductPreviewProps["states"];
const lastPreviewProps = () =>
  previewMock.mock.calls.at(-1)?.[0] as T02pProductPreviewProps;

beforeEach(() => {
  previewMock.mockReset();
  providersMock.mockReset();
});

describe("ProductApplication", () => {
  it("keeps the accepted Detail without a comment section when comments are not composed", () => {
    const markup = renderToStaticMarkup(
      <ProductApplication
        comments={null}
        initialHomeFeed="nearby"
        initialPlatform="phone"
        initialTopicId="topic-one"
        states={states}
      />,
    );
    expect(markup).toContain("data-clean-product-preview");
    expect(lastPreviewProps()).toEqual({
      initialHomeFeed: "nearby",
      initialPlatform: "phone",
      initialTopicId: "topic-one",
      states,
    });
    expect(lastPreviewProps()).not.toHaveProperty("renderCommentSection");
  });

  it("composes typed Phase 4 discussion and author surfaces only when Development is enabled", () => {
    renderToStaticMarkup(
      <ProductApplication
        comments={{ signInHref: "/dev/community" }}
        authorCommunity
        initialPlatform="pc"
        states={states}
      />,
    );
    const { renderDiscussion, renderProfileOverlay, workDetailLoader } =
      lastPreviewProps();
    expect(renderDiscussion).toBeTypeOf("function");
    const section = renderDiscussion?.({
      type: "catalog",
      id: "catalog-one",
    }) as {
      key: string | null;
      props: Record<string, unknown>;
      type: unknown;
    };
    expect(renderProfileOverlay).toBeTypeOf("function");
    expect(workDetailLoader).toBeTypeOf("function");
    expect(section.type).toBe(DiscussionSection);
    expect(section.key).toBe("catalog:catalog-one");
    expect(section.props).toEqual({
      target: { type: "catalog", id: "catalog-one" },
    });
  });

  it("gives the author composition the plus dock action, header Search, and the editor seam", () => {
    renderToStaticMarkup(
      <ProductApplication
        comments={{ signInHref: "/dev/community" }}
        authorCommunity
        messageUnreadCount={105}
        initialPlatform="phone"
        navigationAction={<CatalogSearchNavigationAction />}
        states={
          {
            ...states,
            home: { identity: "home" },
          } as unknown as T02pProductPreviewProps["states"]
        }
      />,
    );
    const props = lastPreviewProps();
    const element = (node: unknown) =>
      node as ReactElement<{
        headerStart?: unknown;
      }>;
    expect(element(props.navigationAction).type).toBe(CreateWorkAction);
    expect(props.renderEditorOverlay).toBe(renderEditorOverlay);
    // Live Threads read the providers this composition mounts.
    expect(props.liveThreads).toBe(true);
    // Uploads and editor sessions live above the shell, not inside the overlay.
    expect(providersMock).toHaveBeenLastCalledWith(true);
    expect(element(props.headerStart).type).toBe(CatalogSearchHeaderAction);
    expect(element(props.headerEnd).type).toBe(MessageTrigger);
    expect(
      (props.headerEnd as ReactElement<{ unreadCount: number }>).props
        .unreadCount,
    ).toBe(105);
    expect(props.userPage).toBeDefined();
    for (const active of [true, false]) {
      const discover = props.renderDiscover?.(active) as ReactElement<{
        active: boolean;
        kind: string;
      }>;
      const inscriptions = props.renderInscriptions?.(active) as ReactElement<{
        active: boolean;
      }>;
      expect(discover.type).toBe(DiscoveryFeed);
      expect(discover.props).toEqual({ kind: "all", active });
      expect(inscriptions.type).toBe(FilteredInscriptions);
      expect(inscriptions.props).toEqual({ active });
    }
  });

  it("keeps the Search dock action and no editor outside the author composition", () => {
    const navigationAction = <CatalogSearchNavigationAction />;
    renderToStaticMarkup(
      <ProductApplication
        comments={{ signInHref: "/dev/community" }}
        initialPlatform="phone"
        navigationAction={navigationAction}
        states={states}
      />,
    );
    expect(lastPreviewProps().navigationAction).toBe(navigationAction);
    expect(lastPreviewProps()).not.toHaveProperty("renderEditorOverlay");
    expect(lastPreviewProps()).not.toHaveProperty("headerStart");
    expect(lastPreviewProps()).not.toHaveProperty("liveThreads");
    expect(providersMock).toHaveBeenLastCalledWith(false);
  });
});
