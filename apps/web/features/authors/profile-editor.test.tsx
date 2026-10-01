// @vitest-environment jsdom
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthorProfile } from "@moya/contracts";
const { command, refresh } = vi.hoisted(() => ({
  command: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("./author-data", () => ({ authorClient: { command } }));
vi.mock("./author-context", () => ({
  useAuthors: () => ({ refresh, notify: vi.fn() }),
}));
vi.mock("./author-dialog", () => ({
  AuthorDialog: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
import { ProfileEditor } from "./profile-editor";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, node: HTMLDivElement;
const profile: AuthorProfile = {
  id: `user-${"1".repeat(32)}`,
  handle: "synthetic-studio-editor",
  displayName: "访碑者",
  bio: "",
  avatar: null,
  isOwner: true,
  following: false,
  nextAvatarChangeAt: null,
  privacy: {
    following: "public",
    followers: "public",
    favorites: "private",
    likes: "private",
  },
  totals: { works: 0, following: 0, followers: 0, favorites: 0, likes: 0 },
};
beforeEach(() => {
  command.mockReset().mockResolvedValue({});
  refresh.mockReset().mockResolvedValue(undefined);
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});
const render = async (extra: Partial<AuthorProfile> = {}) => {
  await act(async () =>
    root.render(
      <ProfileEditor
        profile={{ ...profile, ...extra }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    ),
  );
};
const field = (label: string) => {
  const element = [...node.querySelectorAll("label")]
    .find((item) => item.textContent?.trim() === label)
    ?.querySelector("input,textarea,select");
  if (!(
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ))
    throw Error(`Missing ${label}`);
  return element;
};
const fill = async (label: string, value: string) => {
  const element = field(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
};
const click = async (name: string) => {
  const button = [...node.querySelectorAll("button")].find(
    (item) => item.textContent === name,
  );
  if (!button) throw Error(`Missing ${name}`);
  await act(async () => button.click());
};
const save = () => click("保存");
it("adds and reopens a custom two-character suffix without guessing its split", async () => {
  await render({ studioName: "听雨书屋", studioNameSuffix: "书屋" });
  expect(field("名称").value).toBe("听雨");
  expect(field("自定义称谓").value).toBe("书屋");
  await fill("名称", "😀山水听雨");
  await save();
  expect(command).toHaveBeenCalledWith(
    "me/profile",
    expect.objectContaining({
      studioName: "😀山水听雨书屋",
      studioNameSuffix: "书屋",
    }),
  );
  expect(refresh).toHaveBeenCalledOnce();
});
it("preserves legacy text on unrelated changes, even after opening its editor", async () => {
  await render({ studioName: "旧有六字斋号" });
  await click("修改斋号");
  expect(
    [...node.querySelectorAll("button")].find(
      (item) => item.textContent === "保存",
    )?.disabled,
  ).toBe(true);
  await fill("简介", "新的介绍");
  await save();
  expect(command.mock.calls[0]![1]).not.toHaveProperty("studioName");
  expect(command.mock.calls[0]![1]).not.toHaveProperty("studioNameSuffix");
});
it("clears a legacy studio only through an explicit action", async () => {
  await render({ studioName: "旧有斋号" });
  await click("清除斋号");
  await save();
  expect(command.mock.calls[0]![1]).toMatchObject({
    studioName: "",
    studioNameSuffix: "",
  });
});
it("replaces a legacy value with a chosen suffix and clears a paired value", async () => {
  await render({ studioName: "旧有斋号" });
  await click("修改斋号");
  await fill("名称", "听雨");
  await fill("称谓斋堂室房庐其他", "堂");
  await save();
  expect(command.mock.calls[0]![1]).toMatchObject({
    studioName: "听雨堂",
    studioNameSuffix: "堂",
  });
  await fill("名称", "");
  await save();
  expect(command.mock.calls[1]![1]).toMatchObject({
    studioName: "",
    studioNameSuffix: "",
  });
});
it("does not submit a populated name with a blank custom suffix and associates the error", async () => {
  await render();
  await fill("名称", "听雨");
  await fill("称谓斋堂室房庐其他", "other");
  await save();
  expect(command).not.toHaveBeenCalled();
  const input = field("自定义称谓");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(input.getAttribute("aria-describedby")).toContain(
    node.querySelector('[role="alert"]')!.id,
  );
});
it("limits supplementary Unicode without splitting a surrogate pair", async () => {
  await render();
  await fill("名称", "😀😀😀😀😀😀");
  expect(field("名称").value).toBe("😀😀😀😀😀");
  await save();
  expect(command.mock.calls[0]![1]).toMatchObject({
    studioName: "😀😀😀😀😀斋",
    studioNameSuffix: "斋",
  });
});
it("permits an empty optional name even when the custom suffix is blank", async () => {
  await render();
  await fill("称谓斋堂室房庐其他", "other");
  await fill("简介", "仅修改简介");
  await save();
  expect(command.mock.calls[0]![1]).toMatchObject({
    studioName: "",
    studioNameSuffix: "",
  });
});
