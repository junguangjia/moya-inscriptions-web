import { describe, expect, it } from "vitest";

// @ts-expect-error -- Vite serves the stylesheet's own text for a ?raw import.
import academicReaderCss from "./academic-reader.module.css?raw";

/*
 * Regression guard (8a25e0df, unified-media-pipeline-v1): the academic figure
 * rule styles only an image that is the figure's own child. A managed Article
 * cover or body image (ArticleImage) sits deeper inside a figure and places
 * its image by crop geometry; a descendant rule would size, clamp or letterbox
 * it and break that framing.
 */
const selectors = (css: string): string[] =>
  [...css.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/([^{}]+)\{/gu)]
    .map((match) => match[1]!.trim())
    .filter((prelude) => !prelude.startsWith("@"))
    .flatMap((prelude) => prelude.split(","))
    .map((selector) =>
      selector
        .replace(/\s*>\s*/gu, " > ")
        .replace(/\s+/gu, " ")
        .trim(),
    );
const figureImageSelectors = (css: string): string[] =>
  selectors(css).filter((selector) => /\.figure\b.*\bimg\b/u.test(selector));

describe("academic reader figure CSS", () => {
  const css = String(academicReaderCss);

  it("styles the figure image through the child combinator", () => {
    expect(css).toContain(".figure > img");
    expect(figureImageSelectors(css)).toContain(".figure > img");
  });

  it("has no descendant figure image rule", () => {
    expect(
      figureImageSelectors(css).filter(
        (selector) => selector !== ".figure > img",
      ),
    ).toEqual([]);
    // The guard itself recognises the descendant forms it forbids.
    expect(
      figureImageSelectors(
        ".figure img {} .figure > div img {} @media (x) { .a, .figure .b img {} }",
      ),
    ).toEqual([".figure img", ".figure > div img", ".figure .b img"]);
  });
});
