// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { ProfileCoverPreview } from "./profile-cover-preview";
import presentation from "../user/user-presentation.module.css";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const render = async (src: string | null) => {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <ProfileCoverPreview
        src={src}
        header={{ width: 390, height: 544, identityTop: 330 }}
        device="phone"
        identity={{ name: "作者", avatarSrc: "/avatar.png" }}
      />,
    ),
  );
};
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

it("renders the image through the live cover class at the header's shape", async () => {
  await render("/api/community/media/cover");
  const preview = document.querySelector<HTMLElement>(
    '[data-cover-preview="phone"]',
  )!;
  expect(preview.style.aspectRatio).toBe("390 / 544");
  const cover = preview.querySelector(`.${presentation.profileCover}`)!;
  expect(cover.querySelector("img")!.getAttribute("src")).toBe(
    "/api/community/media/cover",
  );
  // The live class already fades the image; no second fade is drawn.
  expect(preview.querySelector(`.${presentation.coverFade}`)).toBeNull();
  expect(preview.querySelectorAll("img")[1]!.getAttribute("src")).toBe(
    "/avatar.png",
  );
  expect(preview.textContent).toContain("作者");
});

it("shows a blank cover without an image", async () => {
  await render(null);
  expect(
    document.querySelector(`.${presentation.profileCover} img`),
  ).toBeNull();
});
