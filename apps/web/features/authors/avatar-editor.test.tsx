// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { AuthorProfile } from "@moya/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
type CropProps = {
  cropShape: string;
  crop: { x: number; y: number };
  zoom: number;
  showGrid: boolean;
  maxZoom: number;
  onWheelRequest?: (event: WheelEvent) => boolean;
  cropperProps: { tabIndex: number };
  onTouchRequest: () => boolean;
  onCropChange: (value: { x: number; y: number }) => void;
  onZoomChange: (value: number) => void;
  onCropAreaChange: (
    unused: object,
    area: { x: number; y: number; width: number; height: number },
  ) => void;
};
const state = vi.hoisted(() => ({
  account: "user-00000000000000000000000000000001",
  checking: false,
  sessionError: false,
  refresh: vi.fn(),
  upload: vi.fn(),
  avatar: vi.fn(),
  profile: vi.fn(),
  mutate: vi.fn(),
  notify: vi.fn(),
  read: vi.fn(),
  export: vi.fn(),
  save: vi.fn(),
  crop: null as CropProps | null,
}));
vi.mock("./author-data", () => ({
  authorClient: {
    account: () => state.account,
    upload: state.upload,
    avatar: state.avatar,
    profile: state.profile,
  },
  AuthorRequestError: class extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("./author-context", () => ({
  useAuthors: () => ({
    viewer: { id: "user-00000000000000000000000000000001" },
    checking: state.checking,
    sessionError: state.sessionError,
    refresh: state.refresh,
    mutate: state.mutate,
    notify: state.notify,
    avatarSave: null,
    saveAvatar: state.save,
  }),
}));
vi.mock("./avatar-image", () => ({
  readAvatarImage: state.read,
  exportAvatarSnapshot: state.export,
}));
vi.mock("react-easy-crop", async () => {
  const { useEffect } = await import("react");
  return {
    default: (props: CropProps) => {
      state.crop = props;
      useEffect(
        () =>
          props.onCropAreaChange({}, { x: 100, y: 0, width: 600, height: 600 }),
        [],
      );
      return <div data-crop-shape={props.cropShape} />;
    },
  };
});
import { AvatarEditor, AvatarEntry } from "./avatar-editor";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const profile: AuthorProfile = {
  id: state.account,
  handle: "synthetic-avatar-owner",
  displayName: "头像测试",
  bio: "",
  avatar: null,
  isOwner: true,
  following: false,
  nextAvatarChangeAt: null,
  privacy: {
    following: "public",
    followers: "private",
    favorites: "private",
    likes: "private",
  },
  totals: { works: 0, following: 0, followers: 0, favorites: 0, likes: 0 },
};
let root: Root, node: HTMLDivElement;
const snapshot = "data:image/png;base64,c3ludGhldGlj";
const file = new File(["synthetic input"], "photo.jpg", { type: "image/jpeg" });
const close = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  state.account = profile.id;
  state.checking = false;
  state.sessionError = false;
  state.crop = null;
  state.upload.mockResolvedValue({ id: "media-synthetic-avatar" });
  state.avatar.mockResolvedValue({ nextChangeAt: "2099-01-01T05:00:00Z" });
  state.export.mockReturnValue(snapshot);
  state.save.mockImplementation(() => undefined);
  state.read.mockResolvedValue({
    pixels: {},
    url: "blob:synthetic-avatar",
    release: () => undefined,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
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
  window.history.replaceState({}, "", "/#profile");
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  window.history.replaceState({}, "", "/#profile");
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
const render = async (next: string | null = null) =>
  act(async () =>
    root.render(
      <AvatarEditor
        profile={{ ...profile, nextAvatarChangeAt: next }}
        file={file}
        onClose={close}
      />,
    ),
  );
const button = (name: string) =>
  Array.from(node.querySelectorAll("button")).find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent) === name,
  )!;
const click = async (name = "保存头像") =>
  act(async () => button(name).click());
it("opens the device picker before the editor and keeps other authors read-only", async () => {
  await act(async () =>
    root.render(
      <AvatarEntry profile={profile} className="avatar">
        <span>头</span>
      </AvatarEntry>,
    ),
  );
  expect(node.querySelector("dialog")).toBeNull();
  const input = node.querySelector("input")!;
  const picker = vi.spyOn(input, "click");
  await act(async () => node.querySelector("button")!.click());
  expect(picker).toHaveBeenCalledOnce();
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () =>
    input.dispatchEvent(new Event("change", { bubbles: true })),
  );
  expect(node.querySelector("dialog")).not.toBeNull();
  await act(async () =>
    root.render(
      <AvatarEntry profile={{ ...profile, isOwner: false }} className="avatar">
        头
      </AvatarEntry>,
    ),
  );
  expect(node.querySelector("button")).toBeNull();
});
it("shows a round mask, direct positioning and two-finger zoom without a slider", async () => {
  await render();
  // Owner decision (#171 r4): no zoom slider; pinch zooms the photo.
  expect(node.querySelectorAll('input[type="range"]')).toHaveLength(0);
  expect(node.querySelector('[data-crop-shape="round"]')).not.toBeNull();
  await act(async () => {
    state.crop!.onCropChange({ x: 20, y: -30 });
    state.crop!.onZoomChange(2);
  });
  expect(state.crop!.crop).toEqual({ x: 20, y: -30 });
  expect(state.crop!.zoom).toBe(2);
  expect(state.crop!.showGrid).toBe(false);
  expect(state.crop!.maxZoom).toBe(3);
  // Ordinary wheel scrolling is not taken as zoom; Ctrl + wheel is.
  expect(state.crop!.onWheelRequest!({ ctrlKey: false } as WheelEvent)).toBe(
    false,
  );
  expect(state.crop!.onWheelRequest!({ ctrlKey: true } as WheelEvent)).toBe(
    true,
  );
});
it("cancel before saving never uploads or binds", async () => {
  await render();
  // Owner acceptance (2026-09-26): Back with a chosen photo just closes, with
  // no discard prompt and no leave-page warning.
  const confirm = vi.spyOn(window, "confirm");
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(false);
  window.history.replaceState({}, "", "/#profile");
  await click("返回");
  expect(confirm).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
  expect(state.upload).not.toHaveBeenCalled();
  expect(state.avatar).not.toHaveBeenCalled();
});
it("commits the exact crop synchronously, closes and never treats accepted Save as dirty", async () => {
  await render();
  await act(async () => {
    state.crop!.onCropChange({ x: 32, y: 21 });
    // The editor keeps the percent area: the cropper shows a bounded display
    // copy, so pixel coordinates would not match the exported pixels (#237).
    state.crop!.onCropAreaChange(
      { x: 12.3, y: 4, width: 40, height: 53.3 },
      { x: 123, y: 40, width: 400, height: 400 },
    );
  });
  await click();
  expect(state.export).toHaveBeenCalledWith(
    {},
    { x: 12.3, y: 4, width: 40, height: 53.3 },
  );
  expect(state.save).toHaveBeenCalledWith(snapshot);
  expect(close).toHaveBeenCalledOnce();
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(false);
  expect(button("返回").disabled).toBe(false);
});
it("storage failure keeps crop and the editor available without claiming success", async () => {
  state.save.mockImplementation(() => {
    throw Error("本机存储不可用");
  });
  await render();
  await act(async () => state.crop!.onCropChange({ x: 32, y: 21 }));
  await click();
  expect(node.querySelector('[role="alert"]')?.textContent).toBe(
    "本机存储不可用",
  );
  expect(state.crop!.crop).toEqual({ x: 32, y: 21 });
  expect(close).not.toHaveBeenCalled();
  state.save.mockImplementation(() => undefined);
  await click();
  expect(close).toHaveBeenCalledOnce();
});
it("does not enqueue a second save from a duplicate click", async () => {
  await render();
  await act(async () => {
    button("保存头像").click();
    button("保存头像").click();
  });
  expect(state.save).toHaveBeenCalledOnce();
});
it("shows future cooldown in New York time, but permits an expired cooldown", async () => {
  await render("2099-01-02T05:00:00Z");
  expect(button("保存头像").disabled).toBe(true);
  expect(node.textContent).toContain("2099年1月2日");
  expect(node.textContent).toContain("00:00");
  expect(node.textContent).toContain("美国纽约时间");
});
it("does not treat a past next-change timestamp as a limit", async () => {
  await render("2020-01-01T05:00:00Z");
  expect(button("保存头像").disabled).toBe(false);
  await click();
  expect(state.save).toHaveBeenCalledOnce();
});
it("keeps the crop and waits for account confirmation before saving", async () => {
  state.checking = true;
  await render();
  expect(node.querySelector("[data-avatar-crop]")).not.toBeNull();
  expect(button("保存头像").disabled).toBe(true);
  expect(node.textContent).toContain("正在确认账户");
  await click();
  expect(state.upload).not.toHaveBeenCalled();
  state.checking = false;
  await render();
  await click();
  expect(state.save).toHaveBeenCalledOnce();
});
it("blocks save and offers explicit refresh after a failed account check", async () => {
  state.sessionError = true;
  await render();
  expect(button("保存头像").disabled).toBe(true);
  expect(node.querySelector("[data-avatar-crop]")).not.toBeNull();
  await click("重新确认账户");
  expect(state.refresh).toHaveBeenCalledOnce();
});
it("retains the crop when replacement decoding fails before Save", async () => {
  await render();
  await act(async () => state.crop!.onCropChange({ x: 23, y: 18 }));
  state.read.mockRejectedValueOnce(Error("replacement invalid"));
  const input = node.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    value: [new File(["bad"], "bad.jpg", { type: "image/jpeg" })],
  });
  await act(async () =>
    input.dispatchEvent(new Event("change", { bubbles: true })),
  );
  expect(state.crop!.crop).toEqual({ x: 23, y: 18 });
  expect(node.querySelector('[role="alert"]')?.textContent).toBe(
    "replacement invalid",
  );
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  await click();
  expect(state.save).toHaveBeenCalledWith(snapshot);
});
