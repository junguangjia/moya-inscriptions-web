// @vitest-environment jsdom
import { createElement } from "react";
import type { ReactNode } from "react";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArticlePendingPreview } from "@moya/contracts/internal/community-operator";

const runtime = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const { join } = await import("node:path");
  const require = createRequire(
    join(import.meta.dirname, "../../../apps/admin/"),
  );
  return {
    ui: realpathSync(require.resolve("@payloadcms/ui")),
    link: realpathSync(require.resolve("next/link")),
    navigation: realpathSync(require.resolve("next/navigation")),
    call: vi.fn(),
    modal: false,
    push: vi.fn(),
    params: new URLSearchParams(),
  };
});

vi.mock(runtime.ui, () => ({
  SetStepNav: () => null,
  useModal: () => ({
    openModal: () => {
      runtime.modal = true;
    },
    closeModal: () => {
      runtime.modal = false;
    },
  }),
  ConfirmationModal: ({
    body,
    confirmLabel,
    onConfirm,
  }: {
    body: ReactNode;
    confirmLabel: string;
    onConfirm: () => Promise<void>;
  }) =>
    runtime.modal
      ? createElement(
          "section",
          { role: "dialog" },
          body,
          createElement("button", { onClick: onConfirm }, confirmLabel),
        )
      : null,
}));
vi.mock(runtime.link, () => ({
  default: ({ children, ...props }: { children: ReactNode; href: string }) =>
    createElement("a", props, children),
}));
vi.mock(runtime.navigation, () => ({
  usePathname: () => "/admin/community-moderation/article-submissions",
  useRouter: () => ({ push: runtime.push }),
  useSearchParams: () => runtime.params,
}));
vi.mock("admin/community-api", async (original) => ({
  ...(await original<object>()),
  call: runtime.call,
}));

import { OperatorFailure } from "admin/community-api";
import { ArticleSubmissionsQueueClient } from "admin/community-article-client";
import {
  ArticleSubmissionPreview,
  articleSubmissionMediaSrc,
} from "admin/community-article-preview";

const id = `article-${"a".repeat(32)}` as ArticlePendingPreview["articleId"];
const candidate: ArticlePendingPreview = {
  articleId: id,
  ownerId: `user-${"c".repeat(32)}` as ArticlePendingPreview["ownerId"],
  expectedVersion: 4,
  candidateVersion: 3,
  fingerprint: "b".repeat(64),
  title: "待审文章",
  publicVersion: null,
  submittedAt: "2026-10-02T00:00:00Z",
  coverRefId: null,
  document: {
    format: "blocknote",
    version: 1,
    blocks: [
      {
        id: "p",
        type: "paragraph",
        props: {},
        content: [
          {
            type: "text",
            text: "精确候选正文<script>must remain text</script>",
            styles: { bold: true },
          },
        ],
        children: [],
      },
    ],
    references: {},
    galleries: {},
  },
  resolvedReferences: {},
};
beforeEach(() => {
  runtime.params = new URLSearchParams({ item: id });
  runtime.modal = false;
  runtime.call.mockReset();
  runtime.push.mockReset();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  runtime.call.mockImplementation(async (name: string) =>
    name === "read-article-submissions"
      ? { items: [candidate], nextCursor: null }
      : name === "read-article-submission"
        ? candidate
        : {
            articleId: id,
            candidateVersion: 3,
            fingerprint: candidate.fingerprint,
            version: 5,
            disposition: "approved",
            status: "published",
            publicVersion: 3,
          },
  );
});
afterEach(cleanup);

describe("Author Article candidate review", () => {
  it("renders the actual candidate as text and sends exactly the reviewed triple after confirmation", async () => {
    const { container } = render(<ArticleSubmissionsQueueClient />);
    await screen.findByText("精确候选正文<script>must remain text</script>");
    expect(container.querySelector("script")).toBeNull();
    const approve = screen.getByRole("button", { name: "通过并公开…" });
    await waitFor(() =>
      expect((approve as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(approve);
    fireEvent.click(
      await screen.findByRole("button", { name: "确认通过并公开" }),
    );
    await waitFor(() =>
      expect(runtime.call).toHaveBeenCalledWith("moderate-article-submission", {
        id,
        expectedVersion: 4,
        candidateVersion: 3,
        fingerprint: candidate.fingerprint,
        action: "approve",
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      }),
    );
  });
  it("refreshes a stale candidate without silently replaying the old action", async () => {
    runtime.call.mockImplementation(async (name: string) => {
      if (name === "moderate-article-submission")
        throw new OperatorFailure("STATE_CONFLICT", "conflict", 409);
      return name === "read-article-submissions"
        ? { items: [candidate], nextCursor: null }
        : candidate;
    });
    render(<ArticleSubmissionsQueueClient />);
    await screen.findByText("精确候选正文<script>must remain text</script>");
    const approve = screen.getByRole("button", { name: "通过并公开…" });
    await waitFor(() =>
      expect((approve as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(approve);
    fireEvent.click(
      await screen.findByRole("button", { name: "确认通过并公开" }),
    );
    await screen.findByText(/待审核版本已变化/);
    await waitFor(() =>
      expect(
        runtime.call.mock.calls.filter(
          ([name]) => name === "read-article-submission",
        ),
      ).toHaveLength(2),
    );
    expect(
      runtime.call.mock.calls.filter(
        ([name]) => name === "moderate-article-submission",
      ),
    ).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "确认上次处理结果" }),
    ).toBeNull();
  });
  it("reuses the same request identity after an unknown outcome", async () => {
    let first = true;
    runtime.call.mockImplementation(async (name: string) => {
      if (name === "moderate-article-submission") {
        if (first) {
          first = false;
          throw new OperatorFailure("OPERATOR_UNREACHABLE", "unreachable", 502);
        }
        return { disposition: "rejected" };
      }
      return name === "read-article-submissions"
        ? { items: [candidate], nextCursor: null }
        : candidate;
    });
    render(<ArticleSubmissionsQueueClient />);
    fireEvent.click(await screen.findByRole("button", { name: "拒绝…" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认拒绝" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "确认上次处理结果" }),
    );
    await waitFor(() =>
      expect(
        runtime.call.mock.calls.filter(
          ([name]) => name === "moderate-article-submission",
        ),
      ).toHaveLength(2),
    );
    const attempts = runtime.call.mock.calls.filter(
      ([name]) => name === "moderate-article-submission",
    );
    expect(attempts[1]![1]).toEqual(attempts[0]![1]);
  });
  it("renders only the Owner relay for managed images and waits for their successful load", async () => {
    const itemId = `media-item-${"d".repeat(32)}`;
    const mediaCandidate = {
      ...candidate,
      document: {
        ...candidate.document,
        blocks: [
          ...candidate.document.blocks,
          {
            id: "image",
            type: "managedImage" as const,
            props: {
              refId: "photo",
              alt: "待审图片",
              caption: "作者说明",
              cropX: 0.25,
              cropY: 0.25,
              cropWidth: 0.5,
              cropHeight: 0.5,
            },
            children: [],
          },
        ],
        references: { photo: { type: "managed" as const, itemId } },
      },
      resolvedReferences: {
        photo: {
          type: "managed" as const,
          media: {
            id: itemId,
            kind: "static" as const,
            src: `/api/community/publishing/media/${itemId}/display/base`,
            width: 200,
            height: 100,
          },
        },
      },
    } as ArticlePendingPreview;
    const readiness = vi.fn();
    render(
      <ArticleSubmissionPreview
        candidate={mediaCandidate}
        onAvailabilityChange={readiness}
      />,
    );
    const image = screen.getByRole("img", { name: "待审图片" });
    expect(image.getAttribute("src")).toBe(
      articleSubmissionMediaSrc(mediaCandidate, "photo", "display"),
    );
    expect(image.getAttribute("src")).not.toContain(itemId);
    expect((image as HTMLImageElement).style.width).toBe("200%");
    expect(readiness).toHaveBeenLastCalledWith(false);
    fireEvent.load(image);
    await waitFor(() => expect(readiness).toHaveBeenLastCalledWith(true));
    fireEvent.error(image);
    await screen.findByRole("alert");
    await waitFor(() => expect(readiness).toHaveBeenLastCalledWith(false));
  });
});

describe("Canonical Article preview fidelity", () => {
  it("preserves adjacent numbering resets and nested numbering", () => {
    const content = (value: string) => [
      { type: "text" as const, text: value, styles: {} },
    ];
    const numbered = {
      ...candidate,
      document: {
        ...candidate.document,
        blocks: [
          {
            id: "one",
            type: "numberedListItem" as const,
            props: { start: 1 },
            content: content("first"),
            children: [],
          },
          {
            id: "seven",
            type: "numberedListItem" as const,
            props: { start: 7 },
            content: content("reset"),
            children: [
              {
                id: "nested",
                type: "numberedListItem" as const,
                props: { start: 5 },
                content: content("nested"),
                children: [],
              },
            ],
          },
        ],
      },
    };
    const { container } = render(
      <ArticleSubmissionPreview candidate={numbered} />,
    );
    const lists = container.querySelectorAll("ol");
    expect([...lists].map((list) => list.start)).toEqual([1, 5]);
    expect(
      [...lists[0]!.children].map((item) => (item as HTMLLIElement).value),
    ).toEqual([1, 7]);
    expect(lists[1]!.querySelector("li")?.value).toBe(5);
  });

  it("preserves the canonical color palette and every line spacing", () => {
    const modes = ["default", "gray", "red", "brown"] as const;
    const spacings = ["normal", "compact", "relaxed"] as const;
    const styled = {
      ...candidate,
      document: {
        ...candidate.document,
        blocks: spacings.map((lineSpacing, index) => ({
          id: `style-${index}`,
          type: "paragraph" as const,
          props: { lineSpacing, textAlignment: "justify" as const },
          content: modes.map((mode) => ({
            type: "text" as const,
            text: `${lineSpacing}-${mode}`,
            styles: { textColor: mode, backgroundColor: mode },
          })),
          children: [],
        })),
      },
    };
    render(<ArticleSubmissionPreview candidate={styled} />);
    const colors = [
      "rgb(39, 36, 31)",
      "rgb(95, 90, 81)",
      "rgb(179, 74, 50)",
      "rgb(105, 98, 88)",
    ];
    const backgrounds = [
      "transparent",
      "rgb(234, 228, 216)",
      "rgb(232, 213, 204)",
      "rgb(201, 192, 178)",
    ];
    for (const [index, spacing] of spacings.entries()) {
      const paragraph = screen.getByText(`${spacing}-red`).closest("p")!;
      expect(paragraph.style.lineHeight).toBe(["1.9", "1.5", "2.2"][index]);
      expect(paragraph.style.textAlign).toBe("justify");
      for (const [colorIndex, color] of modes.entries()) {
        const styledText = screen.getByText(`${spacing}-${color}`);
        expect(styledText.getAttribute("data-article-text-color")).toBe(color);
        expect(styledText.style.color).toBe(colors[colorIndex]);
        expect(styledText.style.backgroundColor).toBe(backgrounds[colorIndex]);
      }
    }
  });

  it("uses one crop frame for still and Live motion, requiring metadata and refusing media errors", async () => {
    const itemId = `media-item-${"e".repeat(32)}`;
    const live = {
      ...candidate,
      document: {
        ...candidate.document,
        blocks: [
          {
            id: "live",
            type: "managedImage" as const,
            props: {
              refId: "live",
              alt: "裁剪实况",
              caption: "",
              cropX: 0.2,
              cropY: 0.1,
              cropWidth: 0.5,
              cropHeight: 0.4,
            },
            children: [],
          },
        ],
        references: { live: { type: "managed" as const, itemId } },
      },
      resolvedReferences: {
        live: {
          type: "managed" as const,
          media: {
            id: itemId,
            kind: "live" as const,
            src: `/api/community/publishing/media/${itemId}/display/base`,
            motionSrc: `/api/community/publishing/media/${itemId}/motion/base`,
            width: 200,
            height: 100,
          },
        },
      },
    } as ArticlePendingPreview;
    const readiness = vi.fn();
    const { container } = render(
      <ArticleSubmissionPreview
        candidate={live}
        onAvailabilityChange={readiness}
      />,
    );
    const still = screen.getByRole("img", {
      name: "裁剪实况",
    }) as HTMLImageElement;
    const video = container.querySelector("video")!;
    expect(video.parentElement).toBe(still.parentElement);
    expect(video.parentElement!.style.overflow).toBe("hidden");
    expect(video.parentElement!.style.aspectRatio).toBe("100 / 40");
    for (const field of [
      "width",
      "height",
      "left",
      "top",
      "objectFit",
    ] as const)
      expect(video.style[field]).toBe(still.style[field]);
    expect(video.style.width).toBe("200%");
    expect(video.style.height).toBe("250%");
    expect(video.style.left).toBe("-40%");
    expect(video.style.top).toBe("-25%");
    expect(video.getAttribute("src")).toBe(
      articleSubmissionMediaSrc(live, "live", "motion"),
    );
    fireEvent.load(still);
    expect(readiness).toHaveBeenLastCalledWith(false);
    fireEvent.loadedMetadata(video);
    await waitFor(() => expect(readiness).toHaveBeenLastCalledWith(true));
    fireEvent.play(video);
    expect(video.style.visibility).toBe("visible");
    expect(
      screen
        .getByRole("button", { name: "暂停实况" })
        .closest("[data-article-media-frame]"),
    ).toBeNull();
    fireEvent.ended(video);
    expect(video.style.visibility).toBe("hidden");
    fireEvent.error(video);
    await screen.findByRole("alert");
    await waitFor(() => expect(readiness).toHaveBeenLastCalledWith(false));
  });

  it("requires all cover/gallery references while deduplicating repeated images", async () => {
    const first = `media-item-${"e".repeat(32)}`,
      second = `media-item-${"f".repeat(32)}`;
    const gallery = {
      ...candidate,
      coverRefId: "cover",
      document: {
        ...candidate.document,
        blocks: [
          {
            id: "gallery",
            type: "imageGallery" as const,
            props: { groupId: "group" },
            children: [],
          },
        ],
        references: {
          cover: { type: "managed" as const, itemId: first },
          second: { type: "managed" as const, itemId: second },
        },
        galleries: { group: { referenceIds: ["cover", "second"] } },
      },
      resolvedReferences: Object.fromEntries(
        [
          ["cover", first],
          ["second", second],
        ].map(([refId, itemId]) => [
          refId,
          {
            type: "managed",
            media: {
              id: itemId,
              kind: "static",
              src: `/api/community/publishing/media/${itemId}/display/base`,
              width: 200,
              height: 100,
            },
          },
        ]),
      ),
    } as ArticlePendingPreview;
    const readiness = vi.fn();
    const { container } = render(
      <ArticleSubmissionPreview
        candidate={gallery}
        onAvailabilityChange={readiness}
      />,
    );
    const images = [...container.querySelectorAll("img")];
    expect(images).toHaveLength(3);
    const cover = screen.getByRole("img", { name: "文章封面" });
    fireEvent.load(cover);
    expect(readiness).toHaveBeenLastCalledWith(false);
    const last = images.find(
      (image) => new URL(image.src).searchParams.get("refId") === "second",
    )!;
    fireEvent.load(last);
    await waitFor(() => expect(readiness).toHaveBeenLastCalledWith(true));
    fireEvent.error(last);
    await waitFor(() => expect(readiness).toHaveBeenLastCalledWith(false));
  });

  it("refuses an open confirmation after the displayed candidate refreshes", async () => {
    const refreshed = {
      ...candidate,
      expectedVersion: 6,
      candidateVersion: 5,
      fingerprint: "d".repeat(64),
      title: "更新后的候选",
    };
    let reads = 0;
    runtime.call.mockImplementation(async (name: string) => {
      if (name === "read-article-submissions")
        return { items: [candidate], nextCursor: null };
      if (name === "read-article-submission")
        return ++reads === 1 ? candidate : refreshed;
      throw new Error("No decision may be sent for a replaced confirmation");
    });
    render(<ArticleSubmissionsQueueClient />);
    const approve = await screen.findByRole("button", { name: "通过并公开…" });
    await waitFor(() =>
      expect((approve as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(approve);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByRole("heading", { name: "更新后的候选" });
    fireEvent.click(screen.getByRole("button", { name: "确认通过并公开" }));
    await screen.findByText("详情已刷新，请重新检查当前版本后决定。");
    expect(
      runtime.call.mock.calls.filter(
        ([name]) => name === "moderate-article-submission",
      ),
    ).toHaveLength(0);
  });
});
