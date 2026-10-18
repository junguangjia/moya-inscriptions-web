// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Root } from "react-dom/client";
import type { CatalogDetailPresentationLoader } from "../detail/load-catalog-detail";

const { shell } = vi.hoisted(() => ({
  shell: {
    platform: "phone",
    feedLayout: "single",
    orientation: "portrait",
    activeViewerMediaId: null,
    browseOnly: false,
    changeViewerMedia: vi.fn(),
    closeViewer: vi.fn(),
    openViewer: vi.fn(),
    recoverUnavailableAuthContent: vi.fn(),
  },
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => shell,
}));
import { PreviewCatalogDetailOverlay } from "./preview-catalog-detail-overlay";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
beforeEach(() => {
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  vi.stubGlobal("ResizeObserver", Observer);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }),
  });
});
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("Detail uses the existing presentation preference", () => {
  it.each([
    ["phone", "single", "calligraphy"],
    ["tablet", "single", "calligraphy"],
    ["phone", "double", "normal"],
    ["tablet", "double", "normal"],
    ["pc", "single", "normal"],
  ])(
    "%s/%s selects %s and mounts exactly one discussion",
    async (platform, feedLayout, expected) => {
      shell.platform = platform;
      shell.feedLayout = feedLayout;
      const loader = vi.fn<CatalogDetailPresentationLoader>(async () => ({
        state: "loaded",
        detail: {
          id: "mode-test",
          title: "题名",
          kind: "inscription",
          aliases: [],
          facts: [],
          media: [],
          source: "qa",
          sourceCitations: [],
        },
      }));
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await act(async () =>
        root!.render(
          <PreviewCatalogDetailOverlay
            backButtonRef={createRef()}
            catalogId="mode-test"
            initialScrollTop={0}
            loader={loader}
            commentSection={<section data-normal-discussion="" />}
            renderColophon={() => <section data-calligraphy-discussion="" />}
            onClose={vi.fn()}
            onScrollTopChange={vi.fn()}
          />,
        ),
      );
      expect(
        container
          .querySelector("[data-detail-mode]")
          ?.getAttribute("data-detail-mode"),
      ).toBe(expected);
      expect(
        container.querySelectorAll("[data-calligraphy-discussion]"),
      ).toHaveLength(expected === "calligraphy" ? 1 : 0);
      expect(
        container.querySelectorAll("[data-normal-discussion]"),
      ).toHaveLength(expected === "normal" ? 1 : 0);
      expect(loader).toHaveBeenCalledTimes(1);
    },
  );
});
