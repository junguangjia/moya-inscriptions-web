// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmationSheet, confirmationBlocked } from "./confirmation-sheet";
import { createEditorSessionStore } from "./editor-session-state";

import type {
  ConfirmationGate,
  ConfirmationSheetProps,
} from "./confirmation-sheet";
import type { FieldCheck, Readiness } from "./editor-session-state";
import type { Root } from "react-dom/client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT = `user-${"a".repeat(32)}`;

const ready: Readiness = {
  total: 0,
  ready: 0,
  blocking: 0,
  text: null,
  confirmed: true,
  unknownItemIds: [],
};

const titled = () => {
  const store = createEditorSessionStore(ACCOUNT, { type: "new" });
  store.setTitle("临兰亭");
  return store.get();
};

const tooLong: FieldCheck = {
  field: "title",
  label: "标题",
  length: 120,
  maximum: 100,
  message: "标题过长",
};

const roots: Root[] = [];
const render = (overrides: Partial<ConfirmationSheetProps> = {}) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const props: ConfirmationSheetProps = {
    state: titled(),
    readiness: ready,
    cover: null,
    issues: [],
    submission: { status: "idle" },
    unconfirmedFiles: 0,
    onSubmit: () => undefined,
    onGoToField: () => undefined,
    onCheckAgain: () => undefined,
    onRetry: () => undefined,
    ...overrides,
  };
  act(() => root.render(<ConfirmationSheet {...props} />));
  return container;
};

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe("confirmationBlocked", () => {
  it("keeps 发布 disabled for the same reasons the sheet does", () => {
    const gate: ConfirmationGate = {
      state: titled(),
      readiness: ready,
      issues: [],
      submission: { status: "idle" },
    };
    expect(confirmationBlocked(gate)).toBe(false);
    expect(
      confirmationBlocked({
        ...gate,
        state: { title: "", body: "", items: [] },
      }),
    ).toBe(true);
    expect(
      confirmationBlocked({
        ...gate,
        readiness: { ...ready, blocking: 1, text: "1 项仍在上传" },
      }),
    ).toBe(true);
    expect(
      confirmationBlocked({
        ...gate,
        readiness: { ...ready, confirmed: false },
      }),
    ).toBe(true);
    expect(confirmationBlocked({ ...gate, issues: [tooLong] })).toBe(true);
    expect(confirmationBlocked({ ...gate, resolving: true })).toBe(true);
    expect(
      confirmationBlocked({
        ...gate,
        submission: {
          status: "unconfirmed",
          requestId: "r",
          message: "未确认",
        },
      }),
    ).toBe(true);
    expect(
      confirmationBlocked({
        ...gate,
        submission: { status: "failed", code: null, message: "失败" },
      }),
    ).toBe(false);
  });
});

describe("ConfirmationSheet", () => {
  it("shows the summary card and 发布 unless asked to leave them out", () => {
    const full = render();
    expect(full.querySelector("[data-editor-summary]")).not.toBe(null);
    expect(full.querySelector("h3")!.textContent).toBe("临兰亭");
    const submit = full.querySelector<HTMLButtonElement>(
      "[data-editor-submit]",
    )!;
    expect(submit.textContent).toBe("发布");
    expect(submit.disabled).toBe(false);
    expect(
      render({ issues: [tooLong] }).querySelector<HTMLButtonElement>(
        "[data-editor-submit]",
      )!.disabled,
    ).toBe(true);

    const bare = render({ summary: "hidden", primary: "hidden" });
    expect(bare.querySelector("[data-editor-confirmation]")).not.toBe(null);
    expect(bare.querySelector("[data-editor-summary]")).toBe(null);
    expect(bare.querySelector("h3")).toBe(null);
    expect(bare.querySelector("[data-editor-submit]")).toBe(null);
    expect(bare.querySelector("[data-editor-submission]")).not.toBe(null);
  });

  it("ends a blocking readiness line in 前往处理 only where it is offered", () => {
    const store = createEditorSessionStore(ACCOUNT, { type: "new" });
    store.setMedia({
      items: [
        {
          key: "p1",
          itemId: null,
          kind: "static",
          qualityMode: "standard",
          edit: { rotation: 0, crop: null },
        },
      ],
      coverKey: null,
      coverCrop: null,
    });
    const blocked: Readiness = {
      ...ready,
      total: 1,
      blocking: 1,
      text: "1 项失败",
      confirmed: false,
    };
    const line = (container: HTMLElement) =>
      container.querySelector("[data-editor-readiness]")!;

    // The desktop sheet, and the phone with nothing for the author to fix.
    const plain = render({ state: store.get(), readiness: blocked });
    expect(line(plain).textContent).toBe("1 项失败。全部就绪或移除后才能发布");
    expect(plain.querySelector("[data-editor-resolve-media]")).toBe(null);

    const onGoToField = vi.fn();
    const onResolveMedia = vi.fn(() => onGoToField("media"));
    const phone = render({
      state: store.get(),
      readiness: blocked,
      onGoToField,
      onResolveMedia,
    });
    const action = phone.querySelector<HTMLButtonElement>(
      "[data-editor-resolve-media]",
    )!;
    expect(line(phone).lastElementChild).toBe(action);
    expect(action.textContent).toBe("前往处理");
    expect(action.className).toMatch(/inlineAction/u);
    act(() => action.click());
    expect(onGoToField).toHaveBeenCalledExactlyOnceWith("media");

    // Nothing blocks: nothing to go to.
    const settled = render({
      state: store.get(),
      readiness: { ...ready, total: 1, ready: 1 },
      onResolveMedia,
    });
    expect(settled.querySelector("[data-editor-resolve-media]")).toBe(null);
  });
});
