// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArticleDraft } from "@moya/contracts";

const { identity } = vi.hoisted(() => ({
  identity: { account: "user-" + "1".repeat(32) },
}));
vi.mock(
  "../../../lib/public-api/author-community-client",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    authorClient: {
      account: () => identity.account,
      accountEpoch: () => 1,
    },
  }),
);

import ArticleEditor from "./article-editor";
import type { ArticleEditorClient } from "./article-editor-props";
import type { ArticleMediaBridge } from "./article-attachments";

const initial: ArticleDraft = {
  id: `article-${"2".repeat(32)}` as ArticleDraft["id"],
  ownerId: identity.account as ArticleDraft["ownerId"],
  title: "合成专题",
  coverRefId: null,
  document: {
    format: "blocknote",
    version: 1,
    blocks: [
      {
        id: "body",
        type: "paragraph",
        props: {},
        content: [{ type: "text", text: "合成正文", styles: {} }],
        children: [],
      },
    ],
    references: {},
    galleries: {},
  },
  version: 1,
  status: "draft",
  publicVersion: null,
  updatedAt: "2026-09-30T00:00:00.000Z",
  fingerprint: "a".repeat(64),
};

describe("Article editor top-bar back", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "",
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
      })),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows only the shared back icon and leaves a clean draft", async () => {
    const onBack = vi.fn();
    const backButtonRef = createRef<HTMLButtonElement>();
    const client: ArticleEditorClient = {
      save: vi.fn(async () => initial),
      read: vi.fn(async () => initial),
      validate: vi.fn(),
      preview: vi.fn(),
      publish: vi.fn(),
    };
    const media: ArticleMediaBridge = {
      choose: vi.fn(async () => []),
      chooseCatalog: vi.fn(async () => null),
      render: () => null,
      renderCatalog: () => null,
    };
    await act(async () =>
      root.render(
        <ArticleEditor
          sessionKey="synthetic-session"
          accountEpoch={1}
          backButtonRef={backButtonRef}
          initial={initial}
          client={client}
          media={media}
          onBack={onBack}
          onPublished={vi.fn()}
          onReloadDraft={vi.fn()}
        />,
      ),
    );
    // The editor is live: the body is editable and Preview is enabled.
    expect(container.querySelector("[contenteditable='true']")).not.toBeNull();
    const preview = [
      ...container.querySelectorAll<HTMLButtonElement>("header button"),
    ].find((button) => button.textContent === "预览");
    expect(preview?.disabled).toBe(false);
    const back = container.querySelector<HTMLButtonElement>(
      "header button[aria-label='返回草稿箱']",
    );
    expect(back?.disabled).toBe(false);
    expect(back).not.toBeNull();
    expect(backButtonRef.current).toBe(back);
    expect(back!.textContent).toBe("");
    expect(back!.querySelector("[data-icon='back']")).not.toBeNull();
    expect(back!.querySelector("svg")).toBeNull();
    await act(async () => back!.click());
    expect(onBack).toHaveBeenCalledOnce();
    expect(client.save).not.toHaveBeenCalled();
  });
});
