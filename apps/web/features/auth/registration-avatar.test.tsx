// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AuthorProfile } from "@moya/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../authors/local-library", () => ({
  readGuestFavorites: async () => [],
  pendingGuestBatch: async () => null,
  hasOtherGuestBatch: async () => false,
  contentKey: vi.fn(),
  acknowledgeGuestBatch: vi.fn(),
  setGuestFavorite: vi.fn(),
}));
vi.mock("../product-shell/product-shell", () => ({
  useProductShell: () => ({ platform: "phone" }),
}));
vi.mock("../shell/horizontal-pager", () => ({ HorizontalPager: () => null }));
vi.mock("../authors/profile-list", () => ({ ProfileList: () => null }));
vi.mock("../authors/avatar-image", () => ({
  readAvatarImage: async () => ({
    image: {},
    url: "blob:synthetic-onboarding-avatar",
  }),
  exportAvatarSnapshot: () => "data:image/png;base64,c3ludGhldGlj",
}));
vi.mock("react-easy-crop", async () => {
  const { useEffect } = await import("react");
  return {
    default: ({
      onCropAreaChange,
    }: {
      onCropAreaChange: (area: object, pixels: object) => void;
    }) => {
      useEffect(
        () => onCropAreaChange({}, { x: 0, y: 0, width: 600, height: 600 }),
        [],
      );
      return <div data-existing-avatar-crop="" />;
    },
  };
});
import { RegistrationAvatar } from "./registration-avatar";
import { authorClient } from "../authors/author-data";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
// This suite uses only synthetic fixtures and a mocked delivery boundary.
const owner = {
  id: "user-00000000000000000000000000000001",
  handle: "synthetic-onboarding-owner",
  displayName: "甲",
};
const other = {
  id: "user-00000000000000000000000000000002",
  handle: "synthetic-onboarding-other",
  displayName: "乙",
};
const media = {
  id: "user-media-00000000000000000000000000000001",
  src: "/api/community/media/user-media-00000000000000000000000000000001",
  width: 512,
  height: 512,
};
const profile: AuthorProfile = {
  ...owner,
  bio: "",
  avatar: null,
  isOwner: true,
  following: false,
  nextAvatarChangeAt: null,
  privacy: {
    following: "private",
    followers: "private",
    favorites: "private",
    likes: "private",
  },
  totals: { works: 0, following: 0, followers: 0, favorites: 0, likes: 0 },
};
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const deferred = () => {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let node: HTMLDivElement, root: Root;
let me: () => Promise<Response>,
  readProfile: () => Promise<Response>,
  bound: boolean;
const complete = vi.fn();
const requests: { path: string; method: string }[] = [];
beforeEach(() => {
  complete.mockReset();
  requests.length = 0;
  bound = false;
  authorClient.setAccount(null);
  localStorage.clear();
  me = async () => reply(owner);
  readProfile = async () => reply({ ...profile, avatar: bound ? media : null });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      requests.push({ path, method: init.method ?? "GET" });
      if (path === "/api/community/me") return me();
      if (path.startsWith("/api/community/authors/")) return readProfile();
      if (path === "/api/community/media") return reply(media);
      if (path === "/api/community/me/avatar") {
        bound = true;
        return reply({ nextChangeAt: "2099-01-01T05:00:00Z" });
      }
      throw new Error("Unexpected synthetic request category");
    }),
  );
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  localStorage.clear();
  authorClient.setAccount(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const render = async () =>
  act(async () =>
    root.render(
      <RegistrationAvatar expectedAccountId={owner.id} onComplete={complete} />,
    ),
  );
const writes = () => requests.filter((request) => request.method === "POST");
const click = async (text: string) =>
  act(async () => {
    const button = [...node.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === text,
    );
    expect(button).toBeDefined();
    button!.click();
  });
it("waits for real identity confirmation and skips without uploading or re-registering", async () => {
  const loading = deferred();
  me = () => loading.promise;
  await render();
  expect(node.textContent).toContain("正在确认账户");
  expect(node.querySelector("input[type='file']")).toBeNull();
  expect(
    requests.filter((request) => request.path.includes("/authors/")),
  ).toHaveLength(0);
  await click("跳过");
  expect(complete).toHaveBeenCalledTimes(1);
  expect(writes()).toHaveLength(0);
  await act(async () => loading.resolve(reply(owner)));
});
it("never exposes a chooser or writes for a refused session or a different confirmed account", async () => {
  me = async () => reply(null, 401);
  await render();
  expect(node.textContent).toContain("请重新登录");
  expect(node.querySelector("input[type='file']")).toBeNull();
  await act(async () => root.unmount());
  root = createRoot(node);
  me = async () => reply(other);
  await render();
  expect(node.textContent).toContain("登录账户已变化");
  expect(node.querySelector("input[type='file']")).toBeNull();
  expect(
    requests.filter(
      (request) => request.path === `/api/community/authors/${owner.id}`,
    ),
  ).toHaveLength(0);
  expect(writes()).toHaveLength(0);
});
it("ignores a late original-owner profile after the confirmed session switches accounts", async () => {
  const loading = deferred();
  readProfile = () => loading.promise;
  await render();
  expect(node.querySelector("input[type='file']")).toBeNull();
  me = async () => reply(other);
  await act(async () => window.dispatchEvent(new Event("focus")));
  await act(async () => loading.resolve(reply(profile)));
  expect(node.textContent).toContain("登录账户已变化");
  expect(node.querySelector("input[type='file']")).toBeNull();
  expect(writes()).toHaveLength(0);
});
it("delegates explicit crop saving to the existing account-isolated avatar endpoints", async () => {
  await render();
  const picker = node.querySelector<HTMLInputElement>("input[type='file']")!;
  expect(picker).not.toBeNull();
  expect(writes()).toHaveLength(0);
  Object.defineProperty(picker, "files", {
    configurable: true,
    value: [
      new File(["synthetic jpg"], "synthetic-avatar.jpg", {
        type: "image/jpeg",
      }),
    ],
  });
  await act(async () =>
    picker.dispatchEvent(new Event("change", { bubbles: true })),
  );
  expect(node.querySelector("[data-existing-avatar-crop]")).not.toBeNull();
  expect(writes()).toHaveLength(0);
  await click("保存头像");
  expect(writes().map((request) => request.path)).toEqual([
    "/api/community/media",
    "/api/community/me/avatar",
  ]);
  expect(complete).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
  await click("完成");
  expect(complete).toHaveBeenCalledTimes(1);
});
