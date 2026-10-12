// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { attachPasteCapture, clipboardImageFiles } from "./paste-capture";

const paste = (
  target: EventTarget,
  data: { files?: File[]; items?: DataTransferItem[]; types?: string[] },
) => {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: data.files ?? [],
      items: data.items ?? [],
      types: data.types ?? ["Files"],
    },
  });
  target.dispatchEvent(event);
  return event;
};

const image = new File([new Uint8Array([1, 2, 3])], "image.png", {
  type: "image/png",
});
const text = new File(["hello"], "note.txt", { type: "text/plain" });

describe("clipboard image paste", () => {
  afterEach(() => document.body.replaceChildren());

  it("takes image files (from files or file items) and ignores other kinds", () => {
    expect(
      clipboardImageFiles({
        files: [image, text],
        items: [],
        types: ["Files"],
      } as unknown as DataTransfer),
    ).toEqual([image]);
    const item = {
      kind: "file",
      getAsFile: () => image,
    } as unknown as DataTransferItem;
    expect(
      clipboardImageFiles({
        files: [],
        items: [item],
        types: ["Files"],
      } as unknown as DataTransfer),
    ).toEqual([image]);
    expect(clipboardImageFiles(null)).toEqual([]);
  });

  it("stages pasted images and leaves text pastes into fields alone", () => {
    const onImages = vi.fn();
    const detach = attachPasteCapture(document, onImages);
    const event = paste(document.body, { files: [image] });
    expect(onImages).toHaveBeenCalledWith([image]);
    expect(event.defaultPrevented).toBe(true);

    const field = document.createElement("textarea");
    document.body.append(field);
    const textPaste = paste(field, {
      files: [image],
      types: ["Files", "text/plain"],
    });
    expect(onImages).toHaveBeenCalledTimes(1);
    expect(textPaste.defaultPrevented).toBe(false);
    // An image-only paste into a field still reaches the media step.
    paste(field, { files: [image], types: ["Files"] });
    expect(onImages).toHaveBeenCalledTimes(2);

    paste(document.body, { files: [text] });
    expect(onImages).toHaveBeenCalledTimes(2);
    detach();

    // Refused while inactive (e.g. a dialog is open): the paste is untouched.
    const inactive = vi.fn();
    const detachInactive = attachPasteCapture(document, inactive, () => false);
    const ignored = paste(document.body, { files: [image] });
    expect(inactive).not.toHaveBeenCalled();
    expect(ignored.defaultPrevented).toBe(false);
    detachInactive();
    paste(document.body, { files: [image] });
    expect(onImages).toHaveBeenCalledTimes(2);
  });

  it("stages a paste once when two captures listen", () => {
    const first = vi.fn();
    const second = vi.fn();
    const detachFirst = attachPasteCapture(document, first);
    const detachSecond = attachPasteCapture(document, second);
    paste(document.body, { files: [image] });
    expect(first).toHaveBeenCalledExactlyOnceWith([image]);
    expect(second).not.toHaveBeenCalled();
    detachFirst();
    detachSecond();
  });
});
