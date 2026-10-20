// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { people, command, openProfile, author, accountEpoch, forgetAuthor } =
  vi.hoisted(() => ({
    people: vi.fn(),
    command: vi.fn(),
    openProfile: vi.fn(),
    accountEpoch: vi.fn(() => 0),
    forgetAuthor: vi.fn(),
    author: {
      viewer: { id: "author" } as { id: string } | null,
      checking: false,
      sessionError: false,
      mutate: vi.fn(),
    },
  }));
vi.mock("./author-data", async (original) => ({
  ...(await original<typeof import("./author-data")>()),
  authorClient: { people, command, accountEpoch },
}));
vi.mock("./author-context", () => ({ useAuthors: () => author }));
vi.mock("./work-snapshots", () => ({
  forgetAuthorWorkSnapshots: forgetAuthor,
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({ openProfile }),
}));
import { AuthorRequestError } from "./author-data";
import { PeopleList } from "./people-list";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
const person = (name: string) => ({
  id: `user-${name}`,
  displayName: name,
  handle: name,
  avatar: null,
});
const page = (name: string, number = 1, total = 1) => ({
  items: [person(name)],
  page: number,
  pageSize: 1,
  total,
});
const onClose = vi.fn();
const render = async (
  list: "following" | "followers",
  revision = 0,
  owner = true,
) => {
  if (!root) {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
  }
  await act(async () =>
    root!.render(
      <PeopleList
        id="author"
        list={list}
        revision={revision}
        owner={owner}
        onClose={onClose}
      />,
    ),
  );
};
const button = (text: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent === text,
  )!;
const click = async (text: string) => {
  await act(async () => button(text).click());
};
beforeEach(() => {
  vi.clearAllMocks();
  author.viewer = { id: "author" };
  author.checking = false;
  author.sessionError = false;
  accountEpoch.mockReturnValue(0);
  command.mockResolvedValue({});
  vi.spyOn(window, "confirm").mockReturnValue(true);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value() {
      this.open = false;
    },
  });
  window.history.replaceState({ source: "profile" }, "", "/#profile");
});
afterEach(async () => {
  window.history.replaceState({ source: "profile" }, "", "/#profile");
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  people.mockReset();
  command.mockReset();
  vi.restoreAllMocks();
});
it("clears loaded identities when a fresh read denies privacy", async () => {
  people.mockResolvedValueOnce(page("formerly-public"));
  await render("following");
  expect(document.body.textContent).toContain("formerly-public");
  people.mockRejectedValueOnce(new AuthorRequestError(404, "private"));
  await render("following", 1);
  expect(document.body.textContent).not.toContain("formerly-public");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "private",
  );
});
it("ignores the old Following response after Followers has loaded", async () => {
  let resolve!: (value: ReturnType<typeof page>) => void;
  people.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await render("following");
  people.mockResolvedValueOnce(page("current-follower"));
  await render("followers");
  await act(async () => resolve(page("stale-following")));
  expect(document.body.textContent).toContain("current-follower");
  expect(document.body.textContent).not.toContain("stale-following");
});
it("retains prior public rows on transient error and offers retry", async () => {
  people.mockResolvedValueOnce(page("retained"));
  await render("following");
  people.mockRejectedValueOnce(new AuthorRequestError(503, "unavailable"));
  await render("following", 1);
  expect(document.body.textContent).toContain("retained");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "重试",
  );
});
it("opens a full-page dialog, reads every page before all-select and never navigates when selecting", async () => {
  let resolve!: (value: ReturnType<typeof page>) => void;
  people
    .mockResolvedValueOnce(page("first", 1, 2))
    .mockResolvedValueOnce(page("first", 1, 2))
    .mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
  await render("following");
  expect(document.querySelector("dialog")?.open).toBe(true);
  await click("全选");
  expect(document.body.textContent).toContain("全选将在读取完成后生效");
  expect(button("取关所选（0）").disabled).toBe(true);
  await act(async () => resolve(page("second", 2, 2)));
  expect(document.querySelectorAll("input:checked")).toHaveLength(2);
  expect(people).toHaveBeenCalledWith("author", "following", 2);
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  expect(openProfile).not.toHaveBeenCalled();
  expect(button("取关所选（1）").disabled).toBe(false);
});
it("records per-user results and keeps failed selections for retry", async () => {
  people.mockResolvedValue({
    items: [person("first"), person("second")],
    page: 1,
    pageSize: 20,
    total: 2,
  });
  await render("following");
  await click("全选");
  command.mockResolvedValueOnce({}).mockRejectedValueOnce(Error("网络中断"));
  await click("取关所选（2）");
  expect(command).toHaveBeenNthCalledWith(1, "relationships/follow", {
    requestId: expect.any(String),
    targetId: "user-first",
    enabled: false,
  });
  expect(command).toHaveBeenNthCalledWith(2, "relationships/follow", {
    requestId: expect.any(String),
    targetId: "user-second",
    enabled: false,
  });
  expect(
    document.querySelector('[aria-label="操作结果"]')?.textContent,
  ).toContain("first：已取关");
  expect(
    document.querySelector('[aria-label="操作结果"]')?.textContent,
  ).toContain("second：网络中断");
  expect(document.querySelectorAll("input:checked")).toHaveLength(1);
  expect(author.mutate).toHaveBeenCalledOnce();
  // Unfollowing keeps the author's held works.
  expect(forgetAuthor).not.toHaveBeenCalled();
});
it("blocks an owner follower with its row action and never exposes mutations on another profile", async () => {
  people.mockResolvedValue(page("follower"));
  await render("followers");
  await click("拉黑");
  expect(command).toHaveBeenCalledWith("relationships/block", {
    requestId: expect.any(String),
    targetId: "user-follower",
    enabled: true,
  });
  expect(forgetAuthor).toHaveBeenCalledExactlyOnceWith("user-follower");
  author.viewer = { id: "visitor" };
  await render("followers", 1, false);
  expect(button("拉黑")).toBeUndefined();
  expect(document.querySelector('input[type="checkbox"]')).toBeNull();
});
it("stops a batch if the account changes while the first command is pending", async () => {
  people.mockResolvedValue({
    items: [person("first"), person("second")],
    page: 1,
    pageSize: 20,
    total: 2,
  });
  let resolve!: () => void;
  command.mockReturnValueOnce(
    new Promise<void>((done) => {
      resolve = done;
    }),
  );
  await render("following");
  await click("全选");
  await click("取关所选（2）");
  accountEpoch.mockReturnValue(1);
  await act(async () => resolve());
  expect(command).toHaveBeenCalledTimes(1);
  expect(author.mutate).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "未继续处理剩余用户",
  );
});
it("does not claim all-selection when a later page fails", async () => {
  people
    .mockResolvedValueOnce(page("first", 1, 2))
    .mockResolvedValueOnce(page("first", 1, 2))
    .mockRejectedValueOnce(Error("读取失败"));
  await render("following");
  await click("全选");
  expect(document.querySelectorAll("input:checked")).toHaveLength(0);
  expect(button("取关所选（0）").disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "读取失败",
  );
});
it("consumes the list history entry before navigating to a selected profile", async () => {
  people.mockResolvedValue(page("friend"));
  await render("following");
  const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(".phase4-person-identity")!
      .click(),
  );
  expect(back).toHaveBeenCalledOnce();
  expect(openProfile).not.toHaveBeenCalled();
  await act(async () =>
    window.dispatchEvent(
      new PopStateEvent("popstate", { state: { source: "profile" } }),
    ),
  );
  expect(onClose).toHaveBeenCalledOnce();
  expect(openProfile).toHaveBeenCalledWith(
    "user-friend",
    expect.any(HTMLButtonElement),
  );
});
// profile-media-renditions-v1: 48 px rows load `avatar-128`, never `avatar-512`.
it("draws each 48 px avatar from its smallest rendition, else the original", async () => {
  const src = (n: number) =>
    `/api/community/media/user-media-${String(n).repeat(32)}`;
  people.mockResolvedValueOnce({
    items: [
      {
        ...person("rendered"),
        avatar: {
          id: `user-media-${"1".repeat(32)}`,
          src: src(1),
          width: 512,
          height: 512,
          renditions: [
            { src: `${src(1)}/avatar-128`, width: 128, height: 128 },
            { src: `${src(1)}/avatar-512`, width: 512, height: 512 },
          ],
        },
      },
      {
        ...person("pending"),
        avatar: {
          id: `user-media-${"2".repeat(32)}`,
          src: src(2),
          width: 512,
          height: 512,
        },
      },
    ],
    page: 1,
    pageSize: 2,
    total: 2,
  });
  await render("following");
  const images = [...document.querySelectorAll(".phase4-person-avatar img")];
  expect(images.map((image) => image.getAttribute("src"))).toEqual([
    `${src(1)}/avatar-128`,
    src(2),
  ]);
  expect(images.every((image) => !image.hasAttribute("srcset"))).toBe(true);
  expect(images[0]?.getAttribute("loading")).toBe("lazy");
});
