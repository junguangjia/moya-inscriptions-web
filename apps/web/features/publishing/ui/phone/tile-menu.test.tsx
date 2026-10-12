// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FixSheet, TileMenu, attentionOf, closeSheetDialog } from "./tile-menu";

import type { PhotoTileModel } from "./photo-tile";
import type { Attention, FixSheetProps, TileMenuProps } from "./tile-menu";
import type { ItemStatus } from "../media/media-status";
import type { WorkDraftItem } from "@moya/contracts";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const READY: ItemStatus = { kind: "ready", label: "已就绪" };
const MISSING: ItemStatus = {
  kind: "missing_local",
  label: "缺少本地文件",
  message: "本机已找不到这张照片，请重新选择",
};

const item: WorkDraftItem = {
  key: "a",
  itemId: `media-item-${"a".padStart(32, "0")}`,
  kind: "static",
  qualityMode: "standard",
  edit: { rotation: 0, crop: null },
};

const model = (status: ItemStatus = READY): PhotoTileModel => ({
  item,
  view: undefined,
  server: undefined,
  localStill: null,
  editedThumbSrc: null,
  status,
  failure: null,
  chosenCover: false,
});

let container: HTMLDivElement;
let root: Root;

const mount = (node: ReactNode) => {
  act(() => root.render(node));
  return container.querySelector<HTMLDialogElement>("dialog")!;
};

const action = (dialog: HTMLDialogElement, name: string) =>
  dialog.querySelector<HTMLButtonElement>(`[data-media-action="${name}"]`)!;

const iconOf = (button: HTMLButtonElement) =>
  button.querySelector("[data-icon]")?.getAttribute("data-icon") ?? null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // jsdom has no modal dialogs: `open` stands in for them.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("TileMenu", () => {
  const menu = (overrides: Partial<TileMenuProps> = {}) =>
    mount(
      <TileMenu
        count={3}
        model={model()}
        number={2}
        onCancel={vi.fn()}
        onComposeCover={vi.fn()}
        onMakeFirst={vi.fn()}
        onMove={vi.fn()}
        onRemove={vi.fn()}
        {...overrides}
      />,
    );

  it("points 前移 left and 后移 right by default", () => {
    const dialog = menu();
    expect(dialog.getAttribute("data-phone-sheet")).toBe("photo-menu");
    expect(iconOf(action(dialog, "earlier"))).toBe("previous");
    expect(iconOf(action(dialog, "later"))).toBe("next");
  });

  it("mirrors the arrows for the right-to-left strip and keeps what each row does", () => {
    const onMove = vi.fn();
    const dialog = menu({ direction: "rtl", onMove });
    const earlier = action(dialog, "earlier");
    const later = action(dialog, "later");
    // 前移 goes towards 第 1 项, which sits at the right edge.
    expect(earlier.textContent).toBe("前移");
    expect(iconOf(earlier)).toBe("next");
    expect(later.textContent).toBe("后移");
    expect(iconOf(later)).toBe("previous");
    for (const button of [earlier, later])
      expect(
        button.querySelector("[data-icon]")!.getAttribute("aria-hidden"),
      ).toBe("true");
    act(() => earlier.click());
    act(() => later.click());
    expect(onMove.mock.calls).toEqual([[-1], [1]]);
  });

  it("keeps item 1's rules in either direction", () => {
    const dialog = menu({ direction: "rtl", number: 1 });
    expect(dialog.querySelector("h2")!.textContent).toBe("第 1 项 · 首图");
    expect(action(dialog, "first").disabled).toBe(true);
    expect(action(dialog, "earlier").disabled).toBe(true);
    expect(action(dialog, "later").disabled).toBe(false);
    expect(action(dialog, "compose-cover")).not.toBe(null);
  });
});

describe("FixSheet", () => {
  const sheet = (
    attention: Attention,
    overrides: Partial<FixSheetProps> = {},
  ) =>
    mount(
      <FixSheet
        attention={attention}
        model={model(MISSING)}
        number={2}
        onCancel={vi.fn()}
        onRemedy={vi.fn()}
        onRemove={vi.fn()}
        {...overrides}
      />,
    );

  it("closes its dialog before 重新选择 runs, so the picker's input is not inert", () => {
    const attention = attentionOf(item, MISSING, null, "上传已暂停")!;
    expect(attention.remedy).toBe("reselect");
    // The input the flow clicks lives outside the sheet.
    const input = document.createElement("input");
    input.type = "file";
    document.body.append(input);
    const openAtClick: number[] = [];
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {
      openAtClick.push(document.querySelectorAll("dialog[open]").length);
    });
    const onRemedy = vi.fn(() => input.click());
    const dialog = sheet(attention, { onRemedy });
    expect(dialog.open).toBe(true);
    act(() => action(dialog, "reselect").click());
    expect(onRemedy).toHaveBeenCalledOnce();
    expect(openAtClick).toEqual([0]);
  });

  it("leaves the dialog to its owner for the other remedies", () => {
    const paused: ItemStatus = {
      kind: "paused",
      label: "已暂停",
      message: null,
    };
    const attention = attentionOf(item, paused, null, "上传已暂停")!;
    expect(attention.remedy).toBe("continue");
    const openAtRemedy: boolean[] = [];
    const dialog = sheet(attention, {
      onRemedy: () => openAtRemedy.push(dialog.open),
    });
    act(() => action(dialog, "continue").click());
    expect(openAtRemedy).toEqual([true]);
  });

  it("still returns focus to the opener once the owner unmounts a sheet it closed", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const attention = attentionOf(item, MISSING, null, "上传已暂停")!;
    const dialog = sheet(attention);
    expect(document.activeElement).toBe(action(dialog, "reselect"));
    act(() => action(dialog, "reselect").click());
    act(() => root.render(null));
    expect(document.activeElement).toBe(opener);
  });
});

describe("closeSheetDialog", () => {
  it("closes the open dialog that holds the element, and nothing else", () => {
    const dialog = document.createElement("dialog");
    const button = document.createElement("button");
    dialog.append(button);
    document.body.append(dialog);
    dialog.showModal();
    closeSheetDialog(button);
    expect(dialog.open).toBe(false);
    // Already closed, or outside any dialog: nothing happens.
    closeSheetDialog(button);
    expect(dialog.open).toBe(false);
    const outside = document.createElement("button");
    document.body.append(outside);
    expect(() => closeSheetDialog(outside)).not.toThrow();
  });

  it("drops the open attribute where dialogs cannot close themselves", () => {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    const button = document.createElement("button");
    dialog.append(button);
    document.body.append(dialog);
    expect(typeof dialog.close).not.toBe("function");
    closeSheetDialog(button);
    expect(dialog.hasAttribute("open")).toBe(false);
  });
});
