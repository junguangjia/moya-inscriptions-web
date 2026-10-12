// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";

import { ArticleCoverPreview } from "./article-cover-preview";
// @ts-expect-error -- Vite serves the stylesheet's own text for a ?raw import.
import coverCss from "./article-cover-preview.module.css?raw";

import type { Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const render = async (children: React.ReactNode) => {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(<ArticleCoverPreview>{children}</ArticleCoverPreview>),
  );
};
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

it("shows the chosen cover in the square and the 16:10 card boxes with the card's framing", async () => {
  await render(<img alt="" src="blob:cover" />);
  const boxes = [...document.querySelectorAll("[data-article-cover-box]")];
  expect(boxes.map((box) => box.getAttribute("data-shape"))).toEqual([
    "square",
    "large",
  ]);
  expect(
    document.querySelectorAll("[data-article-cover-box] img"),
  ).toHaveLength(2);
  expect(document.body.textContent).toContain("资讯卡片");
  expect(document.body.textContent).toContain("大图卡片");
  expect(document.body.textContent).toContain("正文页显示完整图片");
  expect(coverCss).toMatch(
    /data-shape="square"\]\s*\{[^}]*aspect-ratio:\s*1\b/,
  );
  expect(coverCss).toMatch(
    /data-shape="large"\]\s*\{[^}]*aspect-ratio:\s*16 \/ 10/,
  );
  expect(coverCss).toMatch(/\.coverFrame img\s*\{[^}]*object-fit:\s*cover/);
});

it("renders nothing when no cover is chosen", async () => {
  await render(null);
  expect(document.querySelector("[data-article-cover-preview]")).toBe(null);
});
