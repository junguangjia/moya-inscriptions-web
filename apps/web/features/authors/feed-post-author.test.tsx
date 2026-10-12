// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const { authors, client, shell } = vi.hoisted(() => ({
  authors: {
    viewer: null as { id: string } | null,
    checking: false,
    sessionError: false,
    revision: 0,
    avatarSrc: null as string | null,
    mutate: vi.fn(),
    notify: vi.fn(),
  },
  client: { profile: vi.fn(), command: vi.fn() },
  shell: { openProfile: vi.fn() },
}));
vi.mock("./author-context", () => ({ useAuthors: () => authors }));
vi.mock("./author-data", () => ({ authorClient: client }));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => shell,
}));
vi.mock("../shell/request-identity", () => ({
  requestIdentity: () => "request-1",
}));

import { FeedPostAuthor } from "./feed-post-author";

import type { Root } from "react-dom/client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const user = (n: number) => `user-${String(n).repeat(32)}`;
const profile = (overrides: Record<string, unknown> = {}) => ({
  displayName: "墨池拾遗",
  avatar: null,
  isOwner: false,
  following: false,
  ...overrides,
});

const roots: Root[] = [];
const render = async (...authorIds: string[]) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <>
        {authorIds.map((id, index) => (
          <FeedPostAuthor key={index} authorId={id} />
        ))}
      </>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
};

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("FeedPostAuthor", () => {
  it("reads each distinct author once for every post of that author", async () => {
    authors.viewer = { id: user(1) };
    client.profile.mockResolvedValue(profile());
    const container = await render(user(2), user(2));
    expect(client.profile).toHaveBeenCalledTimes(1);
    expect(client.profile).toHaveBeenCalledWith(user(2));
    const names = [...container.querySelectorAll("[data-feed-post-author]")];
    expect(names.map((n) => n.textContent)).toEqual([
      "墨墨池拾遗关注",
      "墨墨池拾遗关注",
    ]);
  });

  it("opens the author's profile from the avatar and name", async () => {
    authors.viewer = { id: user(3) };
    client.profile.mockResolvedValue(profile());
    const container = await render(user(4));
    const open = container.querySelector<HTMLButtonElement>(
      'button[aria-label="查看 墨池拾遗 的主页"]',
    )!;
    act(() => open.click());
    expect(shell.openProfile).toHaveBeenCalledWith(user(4), open);
  });

  it("follows in place and updates every post of that author", async () => {
    authors.viewer = { id: user(5) };
    client.profile.mockResolvedValue(profile());
    client.command.mockResolvedValue({ saved: true });
    const container = await render(user(6), user(6));
    const follow = container.querySelector<HTMLButtonElement>(
      "[data-feed-post-follow]",
    )!;
    await act(async () => {
      follow.click();
      await Promise.resolve();
    });
    expect(client.command).toHaveBeenCalledWith("relationships/follow", {
      requestId: "request-1",
      targetId: user(6),
      enabled: true,
    });
    expect(authors.mutate).toHaveBeenCalledTimes(1);
    expect(
      [...container.querySelectorAll("[data-feed-post-follow]")].map((b) => [
        b.textContent,
        b.getAttribute("aria-pressed"),
      ]),
    ).toEqual([
      ["已关注", "true"],
      ["已关注", "true"],
    ]);
  });

  it("never lets a profile read from before a follow overwrite it", async () => {
    authors.viewer = { id: user(4) };
    client.profile.mockResolvedValueOnce(profile());
    const container = await render(user(5));
    // A like bumps the revision: a refetch starts and is still in flight.
    let resolveStale: (value: unknown) => void = () => undefined;
    client.profile.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStale = resolve;
      }),
    );
    authors.revision = 1;
    await act(async () => {
      roots[0]!.render(<FeedPostAuthor authorId={user(5)} />);
    });
    client.command.mockResolvedValue({ saved: true });
    client.profile.mockReturnValue(new Promise(() => undefined));
    const follow = container.querySelector<HTMLButtonElement>(
      "[data-feed-post-follow]",
    )!;
    await act(async () => {
      follow.click();
      await Promise.resolve();
    });
    expect(follow.textContent).toBe("已关注");
    // The read issued before the follow lands late with following=false.
    await act(async () => {
      resolveStale(profile({ following: false }));
      await Promise.resolve();
    });
    expect(follow.textContent).toBe("已关注");
    authors.revision = 0;
    client.profile.mockReset();
  });

  it("keeps the follow state and reports a failed follow", async () => {
    authors.viewer = { id: user(7) };
    client.profile.mockResolvedValue(profile());
    client.command.mockRejectedValue(new Error("关注未完成"));
    const container = await render(user(8));
    const follow = container.querySelector<HTMLButtonElement>(
      "[data-feed-post-follow]",
    )!;
    await act(async () => {
      follow.click();
      await Promise.resolve();
    });
    expect(authors.notify).toHaveBeenCalledWith("关注未完成");
    expect(authors.mutate).not.toHaveBeenCalled();
    expect(follow.textContent).toBe("关注");
  });

  it("offers no follow on the viewer's own posts", async () => {
    authors.viewer = { id: user(9) };
    authors.avatarSrc = "/api/community/media/own-avatar";
    client.profile.mockResolvedValue(profile({ isOwner: true }));
    const container = await render(user(9));
    expect(container.querySelector("[data-feed-post-follow]")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/api/community/media/own-avatar",
    );
    authors.avatarSrc = null;
  });

  it("offers no follow to a guest", async () => {
    authors.viewer = null;
    client.profile.mockResolvedValue(profile());
    const container = await render(user(2));
    expect(container.textContent).toContain("墨池拾遗");
    expect(container.querySelector("[data-feed-post-follow]")).toBeNull();
  });

  it("keeps a bare header when the author cannot be read", async () => {
    authors.viewer = { id: user(1) };
    client.profile.mockRejectedValue(new Error("unavailable"));
    const container = await render(user(3));
    const header = container.querySelector("[data-feed-post-author]")!;
    expect(header.hasAttribute("data-author-state")).toBe(false);
    expect(
      header.querySelector('button[aria-label="查看作者"]'),
    ).not.toBeNull();
    expect(container.querySelector("[data-feed-post-follow]")).toBeNull();
  });
});
