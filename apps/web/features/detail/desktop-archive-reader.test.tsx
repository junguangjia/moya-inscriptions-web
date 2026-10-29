// @vitest-environment jsdom
import { act, createRef, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopArchiveReader } from "./desktop-archive-reader";
import { CatalogDetailScreen } from "./catalog-detail-screen";
import type { CatalogDetailPresentation } from "./catalog-detail-presentation";
const auth = vi.hoisted(() => ({
  saved: new Map<string, unknown>(),
  captures: new Map<string, () => unknown>(),
}));
vi.mock("../auth/auth-return", () => ({
  useAuthReturnView: (slot: string, capture: () => unknown) => {
    auth.captures.set(slot, capture);
    return auth.saved.get(slot);
  },
}));
vi.mock("./catalog-detail-reading-strip", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    CatalogDetailReadingStrip: forwardRef(function Mock(
      {
        information,
        id,
      }: { information: import("react").ReactNode; id: string },
      ref,
    ) {
      useImperativeHandle(ref, () => ({
        checkpoint: vi.fn(),
        pagingState: () => ({ forward: false, backward: false }),
        scrollByPage: vi.fn(),
      }));
      return (
        <div data-detail-reading-strip="" id={id} tabIndex={0}>
          {information}
        </div>
      );
    }),
  };
});
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
const mount = (element: import("react").ReactNode) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(element));
  return { host, root };
};
const click = (host: HTMLElement, name: string) => {
  const tab = [
    ...host.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ].find((button) => button.textContent === name)!;
  act(() => tab.click());
  return tab;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) =>
    window.clearTimeout(id),
  );
  auth.saved.clear();
  auth.captures.clear();
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const sections = [
  { key: "overview", label: "概览", content: <h1>总览标题</h1> },
  { key: "transcription", label: "释文", content: <p>完整释文</p> },
  { key: "sources", label: "来源", content: <p>完整来源</p> },
];
describe("DesktopArchiveReader", () => {
  it("keeps the initial auth category through StrictMode and newer choices through reflow", () => {
    const slot = "desktop-archive-category:catalog:strict-auth";
    auth.saved.set(slot, { section: "sources" });
    const draw = (key: string) => (
      <StrictMode>
        <DesktopArchiveReader
          key={key}
          detailId="catalog:strict-auth"
          label="馆藏资料"
          positionKey="member:catalog:strict-auth:desktop"
          sections={sections}
        />
      </StrictMode>
    );
    const { host, root } = mount(draw("first-return"));
    expect(host.querySelector('[aria-selected="true"]')?.textContent).toBe(
      "来源",
    );
    click(host, "释文");
    act(() => root.render(draw("reflow")));
    expect(host.querySelector('[aria-selected="true"]')?.textContent).toBe(
      "释文",
    );
    auth.saved.set(slot, { section: "sources" });
    act(() => root.render(draw("new-auth-journey")));
    expect(host.querySelector('[aria-selected="true"]')?.textContent).toBe(
      "来源",
    );
  });
  it("provides one full-height semantic reading surface and keyboard category selection", () => {
    const { host } = mount(
      <DesktopArchiveReader
        detailId="catalog:keyboard"
        label="馆藏资料"
        sections={sections}
      />,
    );
    expect(host.querySelectorAll("[data-detail-reading-strip]")).toHaveLength(
      1,
    );
    expect(host.querySelector("details")).toBeNull();
    const tab = click(host, "释文");
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector("[role=tabpanel]")?.textContent).toBe("完整释文");
    act(() =>
      tab.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      ),
    );
    expect(document.activeElement?.textContent).toBe("来源");
    expect(host.querySelector("[role=tabpanel]")?.textContent).toBe("完整来源");
  });
  it("remembers category by account and content, with a separate exact auth-return snapshot", () => {
    const draw = (scope: string, key: string) => (
      <DesktopArchiveReader
        key={key}
        detailId="catalog:auth"
        positionKey={scope}
        label="馆藏资料"
        sections={sections}
      />
    );
    const { host, root } = mount(
      draw("guest:catalog:auth:calligraphy", "guest"),
    );
    click(host, "来源");
    auth.saved.set(
      "desktop-archive-category:catalog:auth",
      auth.captures.get("desktop-archive-category:catalog:auth")!(),
    );
    act(() => root.render(draw("member1:catalog:auth:calligraphy", "return")));
    expect(host.querySelector("[aria-selected=true]")?.textContent).toBe(
      "来源",
    );
    click(host, "释文");
    act(() =>
      root.render(draw("member1:catalog:auth:calligraphy", "after-reflow")),
    );
    expect(host.querySelector("[aria-selected=true]")?.textContent).toBe(
      "释文",
    );
    auth.saved.clear();
    act(() => root.render(draw("member2:catalog:auth:calligraphy", "other")));
    expect(host.querySelector("[aria-selected=true]")?.textContent).toBe(
      "概览",
    );
    act(() => root.render(draw("member1:catalog:auth:calligraphy", "again")));
    expect(host.querySelector("[aria-selected=true]")?.textContent).toBe(
      "释文",
    );
  });
  it("retains all available archive fields behind real categories without truncating prose", () => {
    const detail: CatalogDetailPresentation = {
      id: "archive-complete",
      source: "qa",
      kind: "inscription",
      title: "完整馆藏",
      aliases: ["别名"],
      summary: "独立摘要",
      facts: [{ label: "现藏单位", value: "完整现藏单位" }],
      sections: [
        { key: "description", title: "简介", text: "完整简介。".repeat(120) },
        { key: "transcription", title: "释文", text: "全部释文" },
      ],
      sourceCitations: [
        {
          label: "全部来源名",
          citation: "完整引文",
          scopeLabel: "释文、背景",
          url: "https://example.org/source",
        },
      ],
      media: [],
    };
    const { host } = mount(
      <CatalogDetailScreen
        desktop
        calligraphy
        activeMediaIndex={0}
        backButtonRef={createRef()}
        onActiveMediaIndexChange={vi.fn()}
        onBack={vi.fn()}
        onOpenViewer={vi.fn()}
        orientation="landscape"
        platform="pc"
        state={{ state: "loaded", detail }}
      />,
    );
    expect(host.textContent).toContain("完整现藏单位");
    expect(host.textContent).toContain("独立摘要");
    expect(host.textContent).toContain("别名");
    click(host, "简介");
    expect(
      host.querySelector("[role=tabpanel]")?.textContent?.match(/完整简介。/g),
    ).toHaveLength(120);
    click(host, "释文");
    expect(host.textContent).toContain("全部释文");
    click(host, "来源");
    expect(host.textContent).toContain("完整引文");
    expect(host.textContent).toContain("适用于：释文、背景");
    expect(
      host.querySelector('a[href="https://example.org/source"]'),
    ).not.toBeNull();
  });
});
