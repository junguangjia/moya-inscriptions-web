// @vitest-environment jsdom
import { act, forwardRef, useImperativeHandle } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogDetailContentPager } from "./catalog-detail-content-pager";
import { CatalogDetailScrollContext } from "./catalog-detail-scroll";
import { useCommentLocationReveal } from "../comments/comment-composer-portal";
import { usePublishCommentCount } from "../comments/comment-count";
import type { Root } from "react-dom/client";
import type { ReactNode } from "react";

vi.mock("../shell/horizontal-pager", () => ({
  HorizontalPager: forwardRef(function Pager(
    {
      onCommit,
      panels,
    }: {
      onCommit: (key: string) => void;
      panels: Record<string, ReactNode>;
    },
    ref,
  ) {
    useImperativeHandle(ref, () => ({ scrollToKey: onCommit }));
    return (
      <div>
        {panels.information}
        {panels.comments}
      </div>
    );
  }),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const Count = ({ value }: { value: number }) => {
  usePublishCommentCount(value);
  return <p>服务端评论</p>;
};

describe("Detail content pages", () => {
  it("reveals the comments page for an exact locator before scrolling", () => {
    const Target = () => {
      const location = useCommentLocationReveal();
      return (
        <button onClick={() => location?.reveal()}>
          {location?.active ? "located" : "locate"}
        </button>
      );
    };
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <CatalogDetailContentPager
          information={<p>资料</p>}
          comments={<Target />}
          platform="phone"
        />,
      ),
    );
    act(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "locate")!
        .click(),
    );
    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent,
    ).toBe("评论");
    expect(container.textContent).toContain("located");
  });

  it("restores independent information and comment positions through tab commits", () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    let desiredTop = 860;
    const restore = vi.fn((top: number) => {
      desiredTop = top;
    });
    act(() =>
      root.render(
        <CatalogDetailScrollContext.Provider
          value={{ read: () => desiredTop, restore, collapseTop: () => 320 }}
        >
          <CatalogDetailContentPager
            information={<p>资料</p>}
            comments={<Count value={0} />}
            platform="phone"
          />
        </CatalogDetailScrollContext.Provider>,
      ),
    );
    const tabs = container.querySelectorAll<HTMLButtonElement>("[role=tab]");
    expect(tabs[1]!.textContent).toBe("评论");
    act(() => tabs[1]!.click());
    expect(restore).toHaveBeenLastCalledWith(320);
    desiredTop = 540;
    act(() => tabs[0]!.click());
    expect(restore).toHaveBeenLastCalledWith(860);
    act(() => tabs[1]!.click());
    expect(restore).toHaveBeenLastCalledWith(540);
    expect(tabs[1]!.textContent).toBe("评论");
  });

  it.each([0, 140, 319])(
    "shares header expansion at %s even after both pages have saved offsets",
    (expandedTop) => {
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      let desiredTop = 860;
      const restore = vi.fn((top: number) => {
        desiredTop = top;
      });
      act(() =>
        root.render(
          <CatalogDetailScrollContext.Provider
            value={{
              read: () => desiredTop,
              restore,
              collapseTop: () => 320.4,
            }}
          >
            <CatalogDetailContentPager
              information={<p>资料</p>}
              comments={<p>暂无评论</p>}
              platform="phone"
            />
          </CatalogDetailScrollContext.Provider>,
        ),
      );
      const tabs = container.querySelectorAll<HTMLButtonElement>("[role=tab]");
      act(() => tabs[1]!.click());
      desiredTop = 320; // A fractional CSS threshold may be rounded by the scroller.
      act(() => tabs[0]!.click());
      expect(restore).toHaveBeenLastCalledWith(860);
      act(() => tabs[1]!.click());
      desiredTop = expandedTop;
      act(() => tabs[0]!.click());
      expect(restore).toHaveBeenLastCalledWith(expandedTop);
      act(() => tabs[1]!.click());
      expect(restore).toHaveBeenLastCalledWith(expandedTop);
      desiredTop = 500;
      act(() => tabs[0]!.click());
      expect(restore).toHaveBeenLastCalledWith(320.4);
    },
  );

  it("keeps collapsed body offsets when the media and actions change height", () => {
    let notify: (() => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    let top = 860;
    let collapse = 320;
    const restore = vi.fn((value: number) => {
      top = value;
    });
    act(() =>
      root.render(
        <CatalogDetailScrollContext.Provider
          value={{ read: () => top, restore, collapseTop: () => collapse }}
        >
          <CatalogDetailContentPager
            information={<p>资料</p>}
            comments={<p>暂无评论</p>}
            platform="phone"
          />
        </CatalogDetailScrollContext.Provider>,
      ),
    );
    const tabs = container.querySelectorAll<HTMLButtonElement>("[role=tab]");
    act(() => tabs[1]!.click());
    collapse = 500;
    act(() => notify?.());
    expect(restore).toHaveBeenLastCalledWith(500);
    act(() => tabs[0]!.click());
    expect(restore).toHaveBeenLastCalledWith(1040);
    top = 100;
    restore.mockClear();
    collapse = 600;
    act(() => notify?.());
    expect(restore).not.toHaveBeenCalled();
  });

  it("updates the comment label only from the supplied discussion total", () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = (count: number) =>
      act(() =>
        root.render(
          <CatalogDetailContentPager
            information={<p>资料</p>}
            comments={<Count value={count} />}
            platform="phone"
          />,
        ),
      );
    render(2);
    const tabs = container.querySelectorAll<HTMLButtonElement>("[role=tab]");
    expect(tabs[1]!.textContent).toBe("评论 2");
    act(() => {
      tabs[1]!.click();
      tabs[0]!.click();
      tabs[1]!.click();
    });
    expect(tabs[1]!.textContent).toBe("评论 2");
    render(3);
    expect(tabs[1]!.textContent).toBe("评论 3");
    render(0);
    expect(tabs[1]!.textContent).toBe("评论");
  });
});
