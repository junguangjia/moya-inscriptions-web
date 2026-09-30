// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { AuthorProfile } from "@moya/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const {
  upload,
  background,
  accountEpoch,
  account,
  readImage,
  exportCover,
  profileRead,
  author,
  RequestError,
} = vi.hoisted(() => ({
  upload: vi.fn(),
  background: vi.fn(),
  accountEpoch: vi.fn(() => 0),
  account: vi.fn((): string | null => "author"),
  readImage: vi.fn(),
  exportCover: vi.fn(),
  profileRead: vi.fn(),
  author: {
    viewer: { id: "author" } as { id: string } | null,
    checking: false,
    sessionError: false,
    mutate: vi.fn(),
    notify: vi.fn(),
    refresh: vi.fn(),
  },
  RequestError: class extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("./author-context", () => ({ useAuthors: () => author }));
vi.mock("./author-data", () => ({
  authorClient: {
    upload,
    background,
    accountEpoch,
    account,
    profile: profileRead,
  },
  AuthorRequestError: RequestError,
}));
vi.mock("./profile-cover", async (original) => ({
  ...(await original<typeof import("./profile-cover")>()),
  readProfileCoverImage: readImage,
  exportProfileCover: exportCover,
}));
vi.mock("react-easy-crop", () => ({
  default: ({
    onCropAreaChange,
  }: {
    onCropAreaChange: (
      a: { x: number; y: number; width: number; height: number },
      b: unknown,
    ) => void;
  }) => (
    <>
      <button
        type="button"
        onClick={() =>
          onCropAreaChange({ x: 0, y: 0, width: 100, height: 100 }, null)
        }
      >
        完成裁剪
      </button>
      <button
        type="button"
        onClick={() =>
          onCropAreaChange({ x: 0.001, y: 0, width: 99.999, height: 100 }, null)
        }
      >
        重新布局
      </button>
      <button
        type="button"
        onClick={() =>
          onCropAreaChange({ x: 10, y: 5, width: 50, height: 50 }, null)
        }
      >
        改变裁剪
      </button>
    </>
  ),
}));
import { ProfileBackgroundEditor } from "./profile-background-editor";
import presentation from "../user/user-presentation.module.css";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const base: AuthorProfile = {
  id: "author",
  handle: "owner",
  displayName: "作者",
  bio: "",
  avatar: null,
  background: {
    id: "user-media-old",
    src: "/old.png",
    width: 1280,
    height: 720,
  },
  isOwner: true,
  following: false,
  privacy: {
    following: "public",
    followers: "public",
    favorites: "public",
    likes: "public",
  },
  totals: { works: 0, following: 0, followers: 0, favorites: 0, likes: 0 },
  nextAvatarChangeAt: null,
};
let root: Root | null = null;
let profile = base;
const header = createRef<HTMLElement>();
const onSaved = vi.fn(),
  onClose = vi.fn();
const source = () => ({
  display: { url: "blob:display", width: 2048, height: 1536 },
  width: 4032,
  height: 3024,
  pixels: { width: 4032, height: 3024 },
  opaque: true,
  release: vi.fn(),
});
const exported = { blob: new Blob(["png"]), width: 1600, height: 1200 };
const view = () => (
  <>
    <section ref={header}>
      <div className={presentation.profileCover}>
        {profile.background && <img src={profile.background.src} alt="" />}
      </div>
    </section>
    <ProfileBackgroundEditor
      profile={profile}
      header={header}
      onSaved={onSaved}
      onClose={onClose}
    />
  </>
);
const render = async () => {
  if (!root) {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
  }
  await act(async () => root!.render(view()));
};
const find = (text: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent === text,
  );
const click = async (text: string) => {
  const control = find(text);
  if (!control) throw Error(`no button ${text}`);
  await act(async () => control.click());
};
/** Header Back or a swipe: the browser pops the crop step's history entry. */
const back = async () => {
  await act(async () =>
    window.dispatchEvent(
      new PopStateEvent("popstate", {
        state: { ...window.history.state, phase4DialogDepth: 0 },
      }),
    ),
  );
};
const choose = async (name = "cover.jpg") => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["image"], name, { type: "image/jpeg" })],
  });
  await act(async () =>
    input.dispatchEvent(new Event("change", { bubbles: true })),
  );
};
const selectImage = async () => {
  await choose();
  await click("完成裁剪");
};
/** The profile read-back after a save, and the header image finishing. */
const readBack = async (next: AuthorProfile["background"]) => {
  profile = { ...profile, background: next };
  await render();
  const image = header.current!.querySelector("img");
  if (image) await act(async () => image.dispatchEvent(new Event("load")));
};
const alert = () => document.querySelector('[role="alert"]')?.textContent ?? "";
let go: ReturnType<typeof vi.spyOn>;
let confirm: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  profile = base;
  author.viewer = { id: "author" };
  author.checking = false;
  author.sessionError = false;
  accountEpoch.mockReturnValue(0);
  account.mockReturnValue("author");
  upload.mockResolvedValue({ id: "user-media-new" });
  background.mockResolvedValue(undefined);
  readImage.mockImplementation(async () => source());
  exportCover.mockImplementation(async () => ({ ...exported }));
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
  vi.spyOn(window.history, "back").mockImplementation(() => {});
  go = vi.spyOn(window.history, "go").mockImplementation(() => {});
  confirm = vi.spyOn(window, "confirm");
  window.history.replaceState({ source: "profile" }, "", "/#profile");
});
afterEach(async () => {
  vi.useRealTimers();
  window.history.replaceState({ source: "profile" }, "", "/#profile");
  await act(async () => root?.unmount());
  root = null;
  // A dialog unmounted mid-test leaves AuthorDialog's one-shot listener for
  // the browser's Back (history.back is mocked here): consume it now, while
  // nothing is mounted, so it cannot swallow the next test's Back.
  await Promise.resolve();
  window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("opens on the current background with explicit change and remove actions", async () => {
  await render();
  expect(document.querySelector('[aria-label="主页背景"]')).not.toBeNull();
  const preview = document.querySelector("[data-cover-preview]")!;
  expect(
    preview
      .querySelector(`.${presentation.profileCover} img`)!
      .getAttribute("src"),
  ).toBe("/old.png");
  expect(find("更换照片")).toBeDefined();
  expect(find("移除背景")).toBeDefined();
});

it("enters the crop state right after a photo is chosen, without any request", async () => {
  await render();
  await choose();
  expect(document.querySelector('[data-cover-editor="crop"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="调整背景"]')).not.toBeNull();
  expect(find("保存")!.disabled).toBe(true);
  await click("完成裁剪");
  expect(find("保存")!.disabled).toBe(false);
  expect(upload).not.toHaveBeenCalled();
  expect(background).not.toHaveBeenCalled();
});

it("uploads the exported PNG, saves its media id and closes only after the header shows it", async () => {
  await render();
  await selectImage();
  await click("保存");
  expect(exportCover).toHaveBeenCalledWith(expect.anything(), {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
  expect(upload).toHaveBeenCalledWith(exported.blob, expect.any(String));
  expect(background).toHaveBeenCalledWith({
    requestId: expect.any(String),
    mediaId: "user-media-new",
  });
  expect(onSaved).toHaveBeenCalledOnce();
  expect(author.mutate).toHaveBeenCalledOnce();
  // Still refreshing: no success claim over the previous background.
  expect(document.body.textContent).toContain("正在更新主页");
  expect(author.notify).not.toHaveBeenCalled();
  expect(go).not.toHaveBeenCalled();
  await readBack({
    id: "user-media-new",
    src: "/api/community/media/user-media-new",
    width: 1600,
    height: 1200,
  });
  expect(author.notify).toHaveBeenCalledWith("主页背景已更新");
  expect(go).toHaveBeenCalledWith(-2);
  expect(confirm).not.toHaveBeenCalled();
});

it("uploads once for a double tap", async () => {
  let resolve!: (value: { id: string }) => void;
  upload.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await render();
  await selectImage();
  const save = find("保存")!;
  await act(async () => {
    save.click();
    save.click();
  });
  await act(async () => resolve({ id: "user-media-new" }));
  expect(exportCover).toHaveBeenCalledOnce();
  expect(upload).toHaveBeenCalledOnce();
  expect(background).toHaveBeenCalledOnce();
});

it("retries a failed save with the same ids and bytes, without exporting again", async () => {
  background.mockRejectedValueOnce(new TypeError("Load failed"));
  await render();
  await selectImage();
  await click("保存");
  expect(alert()).toContain("无法确认是否已保存");
  expect(alert()).toContain("照片和裁剪已保留");
  expect(alert()).not.toContain("Load failed");
  // A layout re-report within a source pixel is not a new crop.
  await click("重新布局");
  const first = background.mock.calls[0];
  await click("重试保存");
  expect(exportCover).toHaveBeenCalledOnce();
  expect(upload).toHaveBeenCalledOnce();
  expect(background.mock.calls[1]).toEqual(first);
});

it("uploads again only when the crop itself changed after a failure", async () => {
  background.mockRejectedValueOnce(new RequestError(503, "x"));
  await render();
  await selectImage();
  await click("保存");
  await click("改变裁剪");
  await click("重试保存");
  expect(exportCover).toHaveBeenCalledTimes(2);
  expect(upload).toHaveBeenCalledTimes(2);
  expect(upload.mock.calls[0]![1]).not.toBe(upload.mock.calls[1]![1]);
});

it("starts fresh ids when the server refuses the save identity", async () => {
  background.mockRejectedValueOnce(
    new RequestError(409, "Request identity reused"),
  );
  await render();
  await selectImage();
  await click("保存");
  expect(alert()).not.toContain("Request identity");
  const first = background.mock.calls[0]![0].requestId;
  await click("重试保存");
  expect(upload).toHaveBeenCalledTimes(2);
  expect(background.mock.calls[1]![0].requestId).not.toBe(first);
});

it("maps an upload failure to copy that says nothing changed", async () => {
  upload.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await render();
  await selectImage();
  await click("保存");
  expect(alert()).toContain("网络连接失败，背景尚未更改");
  expect(background).not.toHaveBeenCalled();
});

it("does not attach an upload after the account switches", async () => {
  // The real client refuses a response that arrives after an account change.
  upload.mockImplementationOnce(async () => {
    accountEpoch.mockReturnValue(1);
    account.mockReturnValue("different");
    throw new RequestError(401, "账户状态已变化，请重试读取");
  });
  await render();
  await selectImage();
  await click("保存");
  expect(background).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
  expect(alert()).toContain("账户已切换，背景尚未更改");
});

it("keeps the save identity when the account changes during the bind", async () => {
  background.mockImplementationOnce(async () => {
    accountEpoch.mockReturnValue(1);
    throw new RequestError(401, "账户状态已变化，请重试读取");
  });
  await render();
  await selectImage();
  await click("保存");
  // The server may have committed: say so and retry with the same ids (a
  // committed save is replayed, never repeated). No page reload from here.
  expect(alert()).toContain("无法确认是否已保存");
  expect(onSaved).not.toHaveBeenCalled();
  const first = background.mock.calls[0];
  await click("重试保存");
  expect(upload).toHaveBeenCalledOnce();
  expect(background.mock.calls[1]).toEqual(first);
});

it("keeps saving through a session revalidation of the same account", async () => {
  let resolve!: (value: { id: string }) => void;
  upload.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await render();
  await selectImage();
  await click("保存");
  author.checking = true;
  await render();
  await act(async () => resolve({ id: "user-media-new" }));
  expect(background).toHaveBeenCalledOnce();
  expect(onSaved).toHaveBeenCalledOnce();
});

it("ignores an upload that finishes after the editor unmounts", async () => {
  let resolve!: (value: { id: string }) => void;
  upload.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await render();
  await selectImage();
  await click("保存");
  await act(async () => root!.unmount());
  root = null;
  await act(async () => resolve({ id: "late-media" }));
  expect(background).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
});

it("cancels back to the overview without sending or prompting", async () => {
  await render();
  await selectImage();
  const chosen = readImage.mock.results[0]!.value as Promise<{
    release: ReturnType<typeof vi.fn>;
  }>;
  // Crop has no 取消: Back returns to the overview (as in the publishing crop).
  expect(find("取消")).toBeUndefined();
  await back();
  expect(
    document.querySelector('[data-cover-editor="overview"]'),
  ).not.toBeNull();
  expect((await chosen).release).toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
  expect(background).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
});

it("keeps the current photo and crop when a reselected photo cannot be used", async () => {
  await render();
  await selectImage();
  const { CoverError } = await import("./profile-cover");
  readImage.mockRejectedValueOnce(new CoverError("heic"));
  await choose("IMG_1.HEIC");
  expect(alert()).toContain("暂不支持 HEIC");
  expect(document.querySelector("[data-cover-stage]")).not.toBeNull();
  expect(find("保存")!.disabled).toBe(false);
});

it("ignores a slower earlier decode after a newer choice", async () => {
  let first!: (value: ReturnType<typeof source>) => void;
  const stale = source();
  readImage.mockReturnValueOnce(
    new Promise((done) => {
      first = done;
    }),
  );
  await render();
  await choose("a.jpg");
  await choose("b.jpg");
  await act(async () => first(stale));
  expect(stale.release).toHaveBeenCalled();
  expect(document.querySelector("[data-cover-stage]")).not.toBeNull();
});

it("removes the background only after an explicit confirmation", async () => {
  await render();
  await click("移除背景");
  expect(document.querySelector('[data-cover-editor="remove"]')).not.toBeNull();
  expect(background).not.toHaveBeenCalled();
  await click("确认移除");
  expect(background).toHaveBeenCalledWith({
    requestId: expect.any(String),
    mediaId: null,
  });
  expect(upload).not.toHaveBeenCalled();
  expect(author.notify).not.toHaveBeenCalled();
  await readBack(null);
  expect(author.notify).toHaveBeenCalledWith("主页背景已移除");
});

it("closes with an honest notice when the header does not catch up", async () => {
  vi.useFakeTimers();
  await render();
  await selectImage();
  await click("保存");
  expect(author.notify).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(15_000));
  expect(author.notify).toHaveBeenCalledWith("主页背景已保存，刷新后显示");
  expect(go).toHaveBeenCalled();
});

it("still reports a confirmed save when the editor closes before the read-back", async () => {
  await render();
  await selectImage();
  await click("保存");
  await act(async () => root!.unmount());
  root = null;
  expect(author.notify).toHaveBeenCalledWith("主页背景已保存");
});

it("keeps photo, crop and ids through an offline bind failure", async () => {
  background.mockRejectedValueOnce(new TypeError("Load failed"));
  await render();
  await selectImage();
  await click("保存");
  // The page is not reloaded (offline, that read would fail and close the
  // editor): the editor, the crop and the retry identity stay.
  expect(onSaved).not.toHaveBeenCalled();
  expect(profileRead).not.toHaveBeenCalled();
  expect(document.querySelector("[data-cover-stage]")).not.toBeNull();
  const first = background.mock.calls[0];
  await click("重试保存");
  expect(background.mock.calls[1]).toEqual(first);
  expect(upload).toHaveBeenCalledOnce();
});

it("checks an uncertain save when leaving the crop, quietly if still offline", async () => {
  background.mockRejectedValueOnce(new TypeError("Load failed"));
  profileRead.mockRejectedValueOnce(new TypeError("Load failed"));
  await render();
  await selectImage();
  await click("保存");
  await back();
  expect(profileRead).toHaveBeenCalledWith("author");
  expect(onSaved).not.toHaveBeenCalled();
  expect(
    document.querySelector('[data-cover-editor="overview"]'),
  ).not.toBeNull();
  // Later: the save had committed; leaving again refreshes the profile.
  background.mockRejectedValueOnce(new TypeError("Load failed"));
  profileRead.mockResolvedValueOnce({
    ...profile,
    background: {
      id: "user-media-new",
      src: "/new.png",
      width: 1600,
      height: 1200,
    },
  });
  await selectImage();
  await click("保存");
  await back();
  expect(onSaved).toHaveBeenCalledOnce();
  expect(author.notify).toHaveBeenCalledWith("主页背景已保存");
});

it("stops guarding page unload once the server has confirmed the save", async () => {
  let resolve!: () => void;
  background.mockReturnValueOnce(
    new Promise<void>((done) => {
      resolve = done;
    }),
  );
  await render();
  await selectImage();
  await click("保存");
  const during = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(during);
  expect(during.defaultPrevented).toBe(true);
  await act(async () => resolve());
  expect(document.body.textContent).toContain("正在更新主页");
  const after = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
});

it("reports a removal as removed when the header does not catch up", async () => {
  vi.useFakeTimers();
  await render();
  await click("移除背景");
  await click("确认移除");
  await act(async () => vi.advanceTimersByTime(15_000));
  expect(author.notify).toHaveBeenCalledWith("主页背景已移除");
});

it("moves focus with each step", async () => {
  await render();
  await click("移除背景");
  expect(document.activeElement?.textContent).toBe("取消");
  await click("取消");
  expect(document.activeElement?.textContent).toBe("更换照片");
  await selectImage();
  await back();
  expect(document.activeElement?.textContent).toBe("更换照片");
});
