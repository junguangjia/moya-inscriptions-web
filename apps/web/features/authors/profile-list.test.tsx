// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Root } from "react-dom/client";

const { works, author, draftsCard, cardItems } = vi.hoisted(() => ({
  works: vi.fn(),
  cardItems: [] as import("@moya/contracts").ContentCard[],
  author: {
    cache: new Map<string, unknown>(),
    viewer: null as { id: string } | null,
    revision: 1,
    guestFavorites: [],
  },
  draftsCard: vi.fn(),
}));
vi.mock("./author-data", async (original) => ({
  ...(await original<typeof import("./author-data")>()),
  authorClient: { works, collection: vi.fn(), card: vi.fn() },
}));
vi.mock("./author-context", () => ({ useAuthors: () => author }));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({ platform: "phone", feedLayout: "double" }),
}));
vi.mock("./content-card", () => ({
  ContentCard: ({ item }: { item: import("@moya/contracts").ContentCard }) => {
    cardItems.push(item);
    return <article data-work-card={item.target.id} role="listitem" />;
  },
}));
vi.mock("../publishing/ui/drafts/drafts-card", () => ({
  DraftsCard: (props: { accountId: string; active: boolean }) => {
    draftsCard(props);
    return <article data-drafts-card={props.accountId} role="listitem" />;
  },
}));

import { ProfileList, workCard, workCardExcerpt } from "./profile-list";

import type { UserWork, WorkMedia } from "@moya/contracts";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = `user-${"1".repeat(32)}`;
const VISITOR = `user-${"2".repeat(32)}`;
const work = (n: number, overrides: Partial<UserWork> = {}): UserWork => ({
  id: `work-${String(n).padStart(32, "0")}`,
  authorId: OWNER,
  authorName: "作者",
  title: `作品${n}`,
  text: "",
  firstPublishedAt: "2026-09-01T00:00:00.000Z",
  media: [],
  version: 1,
  canEdit: false,
  available: true,
  ...overrides,
});
const itemId = (n: number) => `media-item-${String(n).padStart(32, "0")}`;
const still = (n: number): WorkMedia => ({
  id: itemId(n),
  src: `/api/community/publishing/media/${itemId(n)}/display/base`,
  width: 800 + n,
  height: 600,
  kind: "static",
});
const live = (n: number): WorkMedia => ({
  id: itemId(n),
  src: `/api/community/publishing/media/${itemId(n)}/display/base`,
  width: 900,
  height: 1200,
  kind: "live",
  motionSrc: `/api/community/publishing/media/${itemId(n)}/motion/base`,
  hasAudio: true,
});

let root: Root | null = null;
const render = async (props: {
  authorId: string | null;
  owner: boolean;
  tab?: "works" | "favorites" | "likes";
  strict?: boolean;
}) => {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  const content = (
    <ProfileList
      active
      authorId={props.authorId}
      entryId="entry-1"
      owner={props.owner}
      tab={props.tab ?? "works"}
    />
  );
  await act(async () =>
    root!.render(props.strict ? <StrictMode>{content}</StrictMode> : content),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return node;
};
const cards = (node: HTMLElement) =>
  Array.from(node.querySelectorAll("[role='listitem']")).map((card) =>
    card.getAttribute("data-drafts-card") !== null
      ? "drafts"
      : card.getAttribute("data-work-card"),
  );

beforeEach(() => {
  author.cache.clear();
  author.viewer = null;
  works.mockResolvedValue({
    items: [work(1), work(2)],
    page: 1,
    pageSize: 12,
    total: 2,
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  cardItems.length = 0;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("Profile works drafts card", () => {
  it("finishes revalidating cached Works when StrictMode replays the mount", async () => {
    author.viewer = { id: OWNER };
    author.cache.set(`list:${OWNER}:entry-1:${OWNER}:works`, {
      items: [workCard(work(1))],
      page: 1,
      total: 1,
      search: "",
      kind: "all",
      revision: author.revision,
    });
    works.mockResolvedValue({ items: [work(2)], total: 1 });
    const node = await render({ authorId: OWNER, owner: true, strict: true });
    expect(cards(node)).toEqual(["drafts", work(2).id]);
    expect(node.textContent).not.toContain("正在加载");
  });

  it("puts the drafts card first in the signed-in owner's own Works tab", async () => {
    author.viewer = { id: OWNER };
    const node = await render({ authorId: OWNER, owner: true });
    expect(cards(node)).toEqual(["drafts", work(1).id, work(2).id]);
    expect(draftsCard).toHaveBeenLastCalledWith({
      accountId: OWNER,
      active: true,
      onSettled: expect.any(Function),
    });
  });

  it("never gives a visitor the drafts card", async () => {
    author.viewer = { id: VISITOR };
    const node = await render({ authorId: OWNER, owner: false });
    expect(cards(node)).toEqual([work(1).id, work(2).id]);
    expect(draftsCard).not.toHaveBeenCalled();
  });

  it("never gives a signed-out visitor the drafts card", async () => {
    const node = await render({ authorId: OWNER, owner: false });
    expect(cards(node)).toEqual([work(1).id, work(2).id]);
    expect(draftsCard).not.toHaveBeenCalled();
  });

  it("does not trust an owner flag that disagrees with the confirmed viewer", async () => {
    author.viewer = { id: VISITOR };
    const node = await render({ authorId: OWNER, owner: true });
    expect(cards(node)).not.toContain("drafts");
    expect(draftsCard).not.toHaveBeenCalled();
  });

  it("keeps drafts out of the owner's other tabs", async () => {
    author.viewer = { id: OWNER };
    const node = await render({
      authorId: OWNER,
      owner: true,
      tab: "favorites",
    });
    expect(cards(node)).not.toContain("drafts");
    expect(draftsCard).not.toHaveBeenCalled();
  });
});

describe("Profile works cards", () => {
  /** A cover derivative under a cover crop: never the display image. */
  const croppedCover = (n: number) =>
    `/api/community/publishing/media/${itemId(n)}/cover/${"3".repeat(32)}`;

  it("uses the revision's chosen cover, marks a Live cover and passes only the card media fields", () => {
    const card = workCard(
      work(1, {
        media: [still(1), live(2)],
        coverMediaId: itemId(2),
        coverSrc: croppedCover(2),
      }),
    );
    expect(card.media).toEqual({
      id: itemId(2),
      src: croppedCover(2),
      width: 900,
      height: 1200,
    });
    expect(card.live).toBe(true);
  });

  it("lists the work's images as the card gallery, like a feed card", () => {
    const detail = (n: number, variant: string, width: number) => ({
      src: `/api/community/publishing/media/${itemId(n)}/${variant}/base`,
      width,
      height: width === 801 ? 600 : Math.round((width * 600) / 801),
      contentType: "image/webp" as const,
    });
    const card = workCard(
      work(1, {
        media: [
          {
            ...still(1),
            // Detail candidates: the card keeps those up to the still.
            renditions: [
              detail(1, "thumb", 480),
              detail(1, "display", 801),
              detail(1, "full", 1602),
            ],
            placeholderColor: "#4a4038",
          },
          live(2),
        ],
      }),
    );
    expect(card.mediaCount).toBe(2);
    expect(card.gallery).toEqual([
      {
        id: itemId(1),
        src: still(1).src,
        width: 801,
        height: 600,
        renditions: [detail(1, "thumb", 480), detail(1, "display", 801)],
        placeholderColor: "#4a4038",
      },
      // A Live entry is its still and the flag, never its motion.
      { id: itemId(2), src: live(2).src, width: 900, height: 1200, live: true },
    ]);
    // At most ten entries; the total stays the work's.
    const many = workCard(
      work(2, { media: Array.from({ length: 12 }, (_, n) => still(n + 1)) }),
    );
    expect(many.gallery).toHaveLength(10);
    expect(many.mediaCount).toBe(12);
    // A text-only work has neither.
    expect(workCard(work(3))).not.toHaveProperty("gallery");
    expect(workCard(work(3))).not.toHaveProperty("mediaCount");
  });

  it("takes the card still from the revision's cover crop, not the display image", () => {
    // M03/L10: the cover crop belongs to the revision, so the Works tab must
    // not fall back to the uncropped display image of the cover item.
    const cropped = workCard(
      work(1, {
        media: [still(1), still(2)],
        coverMediaId: itemId(2),
        coverSrc: croppedCover(2),
      }),
    );
    expect(cropped.media?.src).toBe(croppedCover(2));
    expect(cropped.media?.src).not.toBe(still(2).src);
    // The bytes are the cover's; the measurements are still the entry's own,
    // because a work record carries no size beside `coverSrc`, so the box
    // reserved before the image loads can differ from the Home feed's.
    expect(cropped.media?.width).toBe(still(2).width);
    expect(cropped.media?.height).toBe(still(2).height);
    // Only a record without the field at all falls back to the cover entry.
    const legacy = workCard(
      work(1, { media: [still(1), still(2)], coverMediaId: itemId(2) }),
    );
    expect(legacy.media).toEqual({
      id: itemId(2),
      src: still(2).src,
      width: still(2).width,
      height: still(2).height,
    });
  });

  // unified-media-pipeline-v1 (CW4): the cover framing's own candidates give
  // the Works-tab card the same reservation and candidates as Home's card.
  it("reserves the cover crop's own size from its candidates", () => {
    const candidate = (variant: "thumb" | "cover", width: number) => ({
      src: `/api/community/publishing/media/${itemId(2)}/${variant}/${"3".repeat(32)}`,
      width,
      height: width,
      contentType: "image/webp" as const,
    });
    const coverRenditions = [candidate("thumb", 480), candidate("cover", 1080)];
    const card = workCard(
      work(1, {
        media: [still(1), { ...still(2), placeholderColor: "#4a4038" }],
        coverMediaId: itemId(2),
        coverSrc: croppedCover(2),
        coverRenditions,
      }),
    );
    expect(card.media).toEqual({
      id: itemId(2),
      src: croppedCover(2),
      width: 1080,
      height: 1080,
      renditions: coverRenditions,
      placeholderColor: "#4a4038",
    });
    // Candidates that do not contain `coverSrc` describe another image.
    const unrelated = workCard(
      work(1, {
        media: [still(1), still(2)],
        coverMediaId: itemId(2),
        coverSrc: still(2).src,
        coverRenditions,
      }),
    );
    expect(unrelated.media).toEqual({
      id: itemId(2),
      src: still(2).src,
      width: still(2).width,
      height: still(2).height,
    });
  });

  it("shows the work's text when the account reports no presentable cover", () => {
    const card = workCard(
      work(1, {
        title: "",
        text: "只有正文可展示",
        media: [live(2)],
        coverMediaId: itemId(2),
        coverSrc: null,
      }),
    );
    expect(card.media).toBeNull();
    // Nothing claims a Live cover that is not shown.
    expect(card.live).toBe(false);
    expect(card.excerpt).toBe("只有正文可展示");
  });

  it("gives an untitled work with media the body opening while its title stays empty", () => {
    const card = workCard(
      work(1, {
        title: "",
        text: "  正文开头，卡片用它做文字行  ",
        media: [still(1)],
        coverSrc: still(1).src,
      }),
    );
    expect(card.title).toBe("");
    expect(card.excerpt).toBe("正文开头，卡片用它做文字行");
    expect(card.media?.src).toBe(still(1).src);
  });

  it("falls back to the first media without a known cover, and a static cover is not Live", () => {
    for (const coverMediaId of [undefined, null, itemId(9)]) {
      const card = workCard(
        work(1, {
          media: [still(1), live(2)],
          ...(coverMediaId === undefined ? {} : { coverMediaId }),
        }),
      );
      expect(card.media?.id).toBe(itemId(1));
      expect(card.live).toBe(false);
    }
  });

  it("gives a text-only work its body opening instead of a cover", () => {
    const card = workCard(
      work(1, { title: "", text: "  \r\n第一行\r\n第二行  \n", media: [] }),
    );
    expect(card.media).toBeNull();
    expect(card.live).toBe(false);
    expect(card.title).toBe("");
    expect(card.excerpt).toBe("第一行\n第二行");
    expect("excerpt" in workCard(work(2, { text: " \n " }))).toBe(false);
  });

  it("cuts the excerpt at 160 code points with the shared rule and trims after cutting", () => {
    const astral = "𠀀".repeat(159);
    // 159 astral characters, a space, then more: the cut ends on the space.
    expect(workCardExcerpt(`${astral} 后面的文字`)).toBe(astral);
    const long = "字".repeat(200);
    const excerpt = workCardExcerpt(long);
    expect([...excerpt]).toHaveLength(160);
    expect(workCardExcerpt("短正文")).toBe("短正文");
  });

  it("renders the Works tab from the works themselves", async () => {
    works.mockResolvedValue({
      items: [
        work(1, {
          media: [still(1), live(2)],
          coverMediaId: itemId(2),
          coverSrc: croppedCover(2),
        }),
        work(2, { title: "", text: "只有正文", coverSrc: null }),
      ],
      page: 1,
      pageSize: 12,
      total: 2,
    });
    const node = await render({ authorId: OWNER, owner: false });
    expect(cards(node)).toEqual([work(1).id, work(2).id]);
    expect(cardItems.at(-2)).toMatchObject({
      target: { type: "work", id: work(1).id },
      live: true,
      media: { id: itemId(2), src: croppedCover(2) },
    });
    expect(cardItems.at(-1)).toMatchObject({
      target: { type: "work", id: work(2).id },
      title: "",
      excerpt: "只有正文",
      media: null,
    });
  });
});
