import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AnimatedCategoryIcon } from "@moya/ui";

const canonicalArtwork = (name: string) =>
  readFile(
    new URL(
      `../../../packages/ui/src/assets/icons/${name}.svg`,
      import.meta.url,
    ),
    "utf8",
  );
const attributes = (markup: string, tag: "svg" | "path") => {
  const element = markup.match(new RegExp(`<${tag}\\b[^>]*>`))?.[0];
  if (!element) throw new Error(`Missing ${tag}`);
  return new Map(
    [...element.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
};
const elements = (markup: string, tag: "path" | "circle") =>
  [...markup.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "g"))].map(
    (match) => match[0],
  );

it.each(["inscriptions", "calligraphy"] as const)(
  "keeps %s animated vector identical to its canonical artwork",
  async (name) => {
    const source = await canonicalArtwork(name);
    const rendered = renderToStaticMarkup(
      createElement(AnimatedCategoryIcon, { name }),
    );
    const svg = attributes(rendered, "svg");
    expect(svg.get("viewBox")).toBe(attributes(source, "svg").get("viewBox"));
    expect(svg.get("preserveAspectRatio")).toBe("xMidYMid meet");
    expect(svg.get("aria-hidden")).toBe("true");
    expect(svg.get("focusable")).toBe("false");
    expect(svg.has("class")).toBe(false);
    const expectedPaths = elements(source, "path");
    const actualPaths = elements(rendered, "path");
    expect(expectedPaths).toHaveLength(name === "calligraphy" ? 2 : 1);
    expect(actualPaths).toHaveLength(expectedPaths.length);
    for (const [index, path] of expectedPaths.entries()) {
      const actual = attributes(actualPaths[index]!, "path");
      const expected = attributes(path, "path");
      for (const attribute of [
        "d",
        "fill",
        "stroke",
        "stroke-width",
        "stroke-linecap",
        "stroke-linejoin",
      ])
        expect(actual.get(attribute), attribute).toBe(expected.get(attribute));
    }
    expect(attributes(actualPaths.at(-1)!, "path").get("stroke")).toBe(
      "currentColor",
    );
    if (name === "calligraphy")
      expect(attributes(actualPaths[0]!, "path").get("fill")).toBe(
        "currentColor",
      );
  },
);

// The timeline glyph builds with its tab, so it renders the axis, each branch
// and each node apart. Together they must still draw the canonical artwork.
it("splits the timeline glyph into seven animated parts of its canonical artwork", async () => {
  const source = await canonicalArtwork("timeline");
  const rendered = renderToStaticMarkup(
    createElement(AnimatedCategoryIcon, { name: "timeline" }),
  );
  const svg = attributes(rendered, "svg");
  const canonical = attributes(source, "svg");
  const canonicalPath = attributes(source, "path");
  expect(svg.get("viewBox")).toBe(canonical.get("viewBox"));
  expect(svg.get("preserveAspectRatio")).toBe("xMidYMid meet");
  expect(svg.get("aria-hidden")).toBe("true");
  expect(svg.get("focusable")).toBe("false");
  expect(svg.has("class")).toBe(false);
  expect(svg.get("data-icon")).toBe("timeline");
  expect(svg.get("data-icon-renderer")).toBe("svg");
  for (const attribute of [
    "fill",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
  ])
    expect(svg.get(attribute), attribute).toBe(canonicalPath.get(attribute));

  expect(
    [...rendered.matchAll(/data-timeline-part="([^"]+)"/g)].map(
      (match) => match[1],
    ),
  ).toEqual([
    "axis",
    "branch-1",
    "node-1",
    "branch-2",
    "node-2",
    "branch-3",
    "node-3",
  ]);

  const paths = elements(rendered, "path").map((path) =>
    attributes(path, "path"),
  );
  expect(paths).toHaveLength(4);
  // One dash unit is the whole stroke of each part: the CSS draws in 0 to 1.
  for (const path of paths) expect(path.get("pathLength")).toBe("1");
  expect(paths.map((path) => path.get("d")).join("")).toBe(
    canonicalPath.get("d"),
  );

  const circle = (markup: string) => {
    const [cx, cy, r] = ["cx", "cy", "r"].map(
      (name) => markup.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1],
    );
    return { cx, cy, r };
  };
  expect(elements(rendered, "circle").map(circle)).toEqual(
    elements(source, "circle").map(circle),
  );
  expect(elements(source, "circle")).toHaveLength(3);
});
