// @vitest-environment jsdom
import { StrictMode, act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePreviewNavigationHistory } from "./use-preview-navigation-history";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
const source = { screen: "topic", topicId: "synthetic-topic" };
const restore = vi.fn();
const localBase = () => ({
  ...source,
  yoyiPreviewNavigation: {
    ...window.history.state.yoyiPreviewNavigation,
    depth: 0,
  },
});
const Harness = () => {
  const [depth, setDepth] = useState(0);
  const { requestBack } = usePreviewNavigationHistory({
    depth,
    onBack: (next) => {
      restore(next);
      setDepth(next);
    },
  });
  return (
    <>
      <output>{depth}</output>
      <button onClick={() => setDepth((old) => old + 1)}>Open</button>
      <button onClick={() => requestBack()}>Back</button>
      <button onClick={() => setDepth(0)}>Submit</button>
    </>
  );
};
const render = async () => {
  restore.mockClear();
  window.history.replaceState(source, "", "/?topic=synthetic-topic");
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    ),
  );
  return node;
};
const click = async (node: Element, text: string) =>
  act(async () => {
    [...node.querySelectorAll("button")]
      .find((button) => button.textContent === text)!
      .click();
  });
const pop = async (state: unknown) =>
  act(async () => {
    window.history.replaceState(state, "", window.location.href);
    window.dispatchEvent(new PopStateEvent("popstate", { state }));
  });
afterEach(async () => {
  window.history.replaceState(source, "", "/");
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("preview child history", () => {
  it("passes another child's pop through an unchanged parent preview depth", async () => {
    const node = await render();
    await click(node, "Open");
    const nested = vi.fn();
    window.addEventListener("popstate", nested);
    await pop({
      ...window.history.state,
      commentImageNavigation: { id: "synthetic-gallery", depth: 0 },
    });
    expect(nested).toHaveBeenCalledOnce();
    expect(node.querySelector("output")?.textContent).toBe("1");
    expect(restore).not.toHaveBeenCalled();
    window.removeEventListener("popstate", nested);
  });

  it("closes a native child before replaying a history jump beyond its base", async () => {
    const destination = { screen: "primary", destination: "home" };
    const NativeViewer = () => {
      const [depth, setDepth] = useState(1);
      usePreviewNavigationHistory({
        depth,
        nativeModal: true,
        stateKey: "commentImageNavigation",
        onBack: setDepth,
      });
      return depth ? <dialog open /> : <output>closed</output>;
    };
    window.history.replaceState(source, "", "/");
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    await act(async () => root!.render(<NativeViewer />));
    const underlying = vi.fn(() =>
      expect(document.querySelector("dialog")).toBeNull(),
    );
    window.addEventListener("popstate", underlying);
    await pop(destination);
    expect(underlying).toHaveBeenCalledOnce();
    expect(node.querySelector("output")?.textContent).toBe("closed");
    window.removeEventListener("popstate", underlying);
  });
  it("lets a native image viewer own Back without replacing its parent preview marker", async () => {
    const parent = {
      ...source,
      yoyiPreviewNavigation: { id: "synthetic-parent", depth: 2 },
    };
    window.history.replaceState(parent, "", "/?topic=synthetic-topic");
    const close = vi.fn();
    const NativeViewer = () => {
      usePreviewNavigationHistory({
        depth: 1,
        stateKey: "commentImageNavigation",
        nativeModal: true,
        onBack: close,
      });
      return <dialog open />;
    };
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    await act(async () => root!.render(<NativeViewer />));
    expect(window.history.state.yoyiPreviewNavigation).toEqual(
      parent.yoyiPreviewNavigation,
    );
    const underlying = vi.fn();
    window.addEventListener("popstate", underlying);
    const base = {
      ...window.history.state,
      commentImageNavigation: {
        ...window.history.state.commentImageNavigation,
        depth: 0,
      },
    };
    await pop(base);
    expect(close).toHaveBeenCalledWith(0);
    expect(underlying).not.toHaveBeenCalled();
    expect(window.history.state.yoyiPreviewNavigation).toEqual(
      parent.yoyiPreviewNavigation,
    );
    window.removeEventListener("popstate", underlying);
  });
  it("keeps the shell parent entry and returns nested profile then post before the shell", async () => {
    const push = vi.spyOn(window.history, "pushState");
    const underlying = vi.fn();
    const node = await render();
    window.addEventListener("popstate", underlying);
    expect(push).not.toHaveBeenCalled();
    await click(node, "Open");
    const post = window.history.state;
    const base = localBase();
    await click(node, "Open");
    expect(push).toHaveBeenCalledTimes(2);
    await pop(post);
    expect(node.querySelector("output")?.textContent).toBe("1");
    expect(underlying).not.toHaveBeenCalled();
    await pop(base);
    expect(node.querySelector("output")?.textContent).toBe("0");
    expect(underlying).not.toHaveBeenCalled();
    await pop({ screen: "home" });
    expect(underlying).toHaveBeenCalledOnce();
    window.removeEventListener("popstate", underlying);
  });
  it("uses browser Back once for repeated header clicks and consumes submitted composer history", async () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
    const node = await render();
    await click(node, "Open");
    const base = localBase();
    await click(node, "Back");
    await click(node, "Back");
    expect(back).toHaveBeenCalledOnce();
    await pop(base);
    await click(node, "Open");
    await click(node, "Submit");
    expect(go).toHaveBeenCalledWith(-1);
    restore.mockClear();
    await pop(base);
    expect(restore).not.toHaveBeenCalled();
  });
  it("lets a native modal own its popstate without dismissing the discussion child", async () => {
    const node = await render();
    await click(node, "Open");
    const dialog = document.createElement("dialog");
    dialog.open = true;
    document.body.append(dialog);
    const modal = vi.fn();
    window.addEventListener("popstate", modal, true);
    await pop({ ...window.history.state, phase4Dialog: "synthetic-modal" });
    expect(modal).toHaveBeenCalledOnce();
    expect(restore).not.toHaveBeenCalled();
    expect(node.querySelector("output")?.textContent).toBe("1");
    window.removeEventListener("popstate", modal, true);
    dialog.remove();
  });
  it("cleans up only child entries and shields the shell from the cleanup pop", async () => {
    const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
    const node = await render();
    await click(node, "Open");
    await click(node, "Open");
    const underlying = vi.fn();
    window.addEventListener("popstate", underlying);
    await act(async () => root!.unmount());
    root = null;
    expect(go).toHaveBeenCalledOnce();
    expect(go).toHaveBeenCalledWith(-2);
    await pop(source);
    expect(underlying).not.toHaveBeenCalled();
    window.removeEventListener("popstate", underlying);
  });
  it("passes a history-menu jump beyond the local base to the shell", async () => {
    const node = await render();
    await click(node, "Open");
    const shell = vi.fn();
    window.addEventListener("popstate", shell);
    // Equivalent to history.go(-2): child -> topic base -> discussion primary.
    await pop({ screen: "primary", destination: "discussion" });
    expect(shell).toHaveBeenCalledOnce();
    expect(restore).not.toHaveBeenCalled();
    // Shell will unmount the topic; cleanup must not traverse another entry.
    const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
    await act(async () => root!.unmount());
    root = null;
    expect(go).not.toHaveBeenCalled();
    window.removeEventListener("popstate", shell);
  });
  it("neutralizes Forward to discarded children without sending its correction to the shell", async () => {
    const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
    const node = await render();
    await click(node, "Open");
    const child = window.history.state;
    const base = localBase();
    await pop(base);
    const underlying = vi.fn();
    window.addEventListener("popstate", underlying);
    await pop(child);
    expect(go).toHaveBeenCalledWith(-1);
    await pop(base);
    expect(node.querySelector("output")?.textContent).toBe("0");
    expect(underlying).not.toHaveBeenCalled();
    window.removeEventListener("popstate", underlying);
  });
});
