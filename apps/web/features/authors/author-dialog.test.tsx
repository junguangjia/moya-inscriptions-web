// @vitest-environment jsdom
import { StrictMode, act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorDialog } from "./author-dialog";
import type { AuthorDialogNavigationHandle } from "./author-dialog";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    }),
  });
  window.history.replaceState(
    { screen: "detail" },
    "",
    "/?workId=synthetic#detail",
  );
});
afterEach(async () => {
  window.history.replaceState({ screen: "detail" }, "", "/");
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});
const render = async (onClose: () => void, dirty = false) => {
  const element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  await act(async () =>
    root!.render(
      <StrictMode>
        <AuthorDialog title="编辑" onClose={onClose} dirty={dirty}>
          <input aria-label="私有文本" defaultValue="草稿" />
        </AuthorDialog>
      </StrictMode>,
    ),
  );
  return element;
};
describe("author modal history ownership", () => {
  it("finishes the modal Back before navigating to a parent profile view", async () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const navigate = vi.fn();
    await render(navigate);
    await act(async () =>
      root!.render(
        <StrictMode>
          <AuthorDialog title="编辑" onClose={navigate} closeRequested>
            <input aria-label="私有文本" defaultValue="草稿" />
          </AuthorDialog>
        </StrictMode>,
      ),
    );
    expect(back).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => {
      window.history.replaceState(
        { screen: "detail" },
        "",
        window.location.href,
      );
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: { screen: "detail" } }),
      );
    });
    expect(navigate).toHaveBeenCalledOnce();
  });
  it("registers once under StrictMode and browser Back closes only the modal", async () => {
    const push = vi.spyOn(window.history, "pushState"),
      close = vi.fn(),
      underlying = vi.fn();
    await render(close);
    expect(push).toHaveBeenCalledTimes(1);
    window.addEventListener("popstate", underlying);
    await act(async () => {
      window.history.replaceState(
        { screen: "detail" },
        "",
        window.location.href,
      );
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: { screen: "detail" } }),
      );
    });
    expect(close).toHaveBeenCalledOnce();
    expect(underlying).not.toHaveBeenCalled();
    window.removeEventListener("popstate", underlying);
  });
  it("releases history ownership during a delayed exit animation", async () => {
    const close = vi.fn(),
      underlying = vi.fn();
    await render(close);
    window.addEventListener("popstate", underlying);
    await popDialog({ screen: "detail" });
    expect(close).toHaveBeenCalledOnce();
    expect(underlying).not.toHaveBeenCalled();
    await popDialog({ screen: "home" });
    expect(close).toHaveBeenCalledOnce();
    expect(underlying).toHaveBeenCalledOnce();
    window.removeEventListener("popstate", underlying);
  });
  it("guards repeated close clicks while Back is pending", async () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const node = await render(vi.fn());
    await act(async () => {
      node.querySelector("button")!.click();
      node.querySelector("button")!.click();
    });
    expect(back).toHaveBeenCalledTimes(1);
    // A separate actual unmount also neutralizes its own entry, once.
    await act(async () => {
      window.history.replaceState(
        { screen: "detail" },
        "",
        window.location.href,
      );
      root!.unmount();
    });
    root = null;
    expect(back).toHaveBeenCalledTimes(1);
  });
  it("consumes only its own temporary entry on account-change unmount", async () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {}),
      underlying = vi.fn();
    await render(vi.fn());
    window.addEventListener("popstate", underlying);
    await act(async () => root!.unmount());
    root = null;
    expect(back).toHaveBeenCalledOnce();
    window.history.replaceState({ screen: "detail" }, "", window.location.href);
    window.dispatchEvent(
      new PopStateEvent("popstate", { state: { screen: "detail" } }),
    );
    expect(underlying).not.toHaveBeenCalled();
    window.removeEventListener("popstate", underlying);
  });
  it("preserves unsaved text when abandoning is declined", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false),
      back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const node = await render(vi.fn(), true);
    await act(async () => node.querySelector("button")!.click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(back).not.toHaveBeenCalled();
    expect(node.querySelector("input")?.value).toBe("草稿");
    window.history.replaceState({ screen: "detail" }, "", window.location.href);
  });
});

const childBack = vi.fn();
const ModalChildren = ({
  onClose,
  dirty = false,
  dismissible = true,
  guardChildBack = true,
}: {
  onClose: () => void;
  dirty?: boolean;
  dismissible?: boolean;
  guardChildBack?: boolean;
}) => {
  const [depth, setDepth] = useState(0);
  const navigation = useRef<AuthorDialogNavigationHandle>(null);
  return (
    <AuthorDialog
      title="消息"
      titleContent={<button>聊天作者</button>}
      navigationDepth={depth}
      navigationRef={navigation}
      onBack={(target) => {
        childBack(target);
        setDepth(target);
      }}
      dirty={dirty}
      guardChildBack={guardChildBack}
      dismissible={dismissible}
      onClose={onClose}
    >
      <output>{depth}</output>
      <button data-open-child="" onClick={() => setDepth((old) => old + 1)}>
        下一页
      </button>
      <button data-profile-back="" onClick={() => navigation.current?.back()}>
        主页返回
      </button>
    </AuthorDialog>
  );
};
const renderChildren = async (
  onClose = vi.fn(),
  dirty = false,
  dismissible = true,
  guardChildBack = true,
) => {
  childBack.mockClear();
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <StrictMode>
        <ModalChildren
          onClose={onClose}
          dirty={dirty}
          dismissible={dismissible}
          guardChildBack={guardChildBack}
        />
      </StrictMode>,
    ),
  );
  return node;
};
const popDialog = async (state: unknown) =>
  act(async () => {
    window.history.replaceState(state, "", window.location.href);
    window.dispatchEvent(new PopStateEvent("popstate", { state }));
  });

describe("author modal child navigation", () => {
  it("returns profile to fans to messages before dismissing the modal", async () => {
    const close = vi.fn(),
      underlying = vi.fn();
    const node = await renderChildren(close);
    const messages = window.history.state;
    expect(node.querySelector("dialog")?.getAttribute("aria-label")).toBe(
      "消息",
    );
    expect(node.querySelector("h2 button")?.textContent).toBe("聊天作者");
    await act(async () =>
      node.querySelector<HTMLButtonElement>("[data-open-child]")!.click(),
    );
    const fans = window.history.state;
    await act(async () =>
      node.querySelector<HTMLButtonElement>("[data-open-child]")!.click(),
    );
    expect(window.history.state.phase4DialogDepth).toBe(2);
    window.addEventListener("popstate", underlying);
    await popDialog(fans);
    expect(node.querySelector("output")?.textContent).toBe("1");
    await popDialog(messages);
    expect(node.querySelector("output")?.textContent).toBe("0");
    expect(close).not.toHaveBeenCalled();
    await popDialog({ screen: "detail" });
    expect(close).toHaveBeenCalledOnce();
    expect(underlying).not.toHaveBeenCalled();
    window.removeEventListener("popstate", underlying);
  });
  it("shares one pending Back between the profile close handle and header", async () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const close = vi.fn();
    const node = await renderChildren(close);
    const messages = window.history.state;
    await act(async () =>
      node.querySelector<HTMLButtonElement>("[data-open-child]")!.click(),
    );
    await act(async () => {
      node.querySelector<HTMLButtonElement>("[data-profile-back]")!.click();
      node.querySelector<HTMLButtonElement>(".phase4-back")!.click();
    });
    expect(back).toHaveBeenCalledOnce();
    expect(childBack).not.toHaveBeenCalled();
    await popDialog(messages);
    expect(childBack).toHaveBeenCalledWith(0);
    expect(close).not.toHaveBeenCalled();
  });
  it("retains a dirty child when browser Back is declined", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const forward = vi
      .spyOn(window.history, "forward")
      .mockImplementation(() => {});
    const node = await renderChildren(vi.fn(), true);
    const messages = window.history.state;
    await act(async () =>
      node.querySelector<HTMLButtonElement>("[data-open-child]")!.click(),
    );
    const child = window.history.state;
    await popDialog(messages);
    expect(confirm).toHaveBeenCalledOnce();
    expect(forward).toHaveBeenCalledOnce();
    expect(childBack).not.toHaveBeenCalled();
    await popDialog(child);
    expect(node.querySelector("output")?.textContent).toBe("1");
  });
  it("keeps non-dismissible children in place without asking to discard", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const forward = vi
      .spyOn(window.history, "forward")
      .mockImplementation(() => {});
    const node = await renderChildren(vi.fn(), true, false);
    const messages = window.history.state;
    await act(async () =>
      node.querySelector<HTMLButtonElement>("[data-open-child]")!.click(),
    );
    await popDialog(messages);
    expect(forward).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    expect(childBack).not.toHaveBeenCalled();
  });
  it("consumes root plus nested child entries on session-change unmount", async () => {
    const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
    const node = await renderChildren();
    await act(async () =>
      node.querySelector<HTMLButtonElement>("[data-open-child]")!.click(),
    );
    await act(async () =>
      node.querySelector<HTMLButtonElement>("[data-open-child]")!.click(),
    );
    await act(async () => root!.unmount());
    root = null;
    expect(go).toHaveBeenCalledWith(-3);
    await popDialog({ screen: "detail" });
  });
});

describe("settings opt-in draft preservation", () => {
  it("skips only child dirty confirmation and still guards root exit", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const close = vi.fn();
    const node = await renderChildren(close, true, true, false);
    const modalRoot = window.history.state;
    await act(async () =>
      node.querySelector<HTMLButtonElement>("[data-open-child]")!.click(),
    );
    await popDialog(modalRoot);
    expect(childBack).toHaveBeenCalledWith(0);
    expect(confirm).not.toHaveBeenCalled();
    await popDialog({ screen: "detail" });
    expect(confirm).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });
  it("keeps non-dismissible and repeat-Back protection despite opting in", async () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const node = await renderChildren(vi.fn(), true, false, false);
    await act(async () =>
      node.querySelector<HTMLButtonElement>("[data-open-child]")!.click(),
    );
    await act(async () =>
      node.querySelector<HTMLButtonElement>("[data-profile-back]")!.click(),
    );
    expect(back).not.toHaveBeenCalled();
  });
});
