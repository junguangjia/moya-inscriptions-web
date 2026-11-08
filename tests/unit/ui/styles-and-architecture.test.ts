import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const uiRoot = new URL("../../../packages/ui/src/", import.meta.url);

const collectSource = async (directory: URL): Promise<string> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const contents: string[] = [];
  for (const entry of entries) {
    if (entry.name === "assets") continue;
    const url = new URL(
      entry.name + (entry.isDirectory() ? "/" : ""),
      directory,
    );
    if (entry.isDirectory()) contents.push(await collectSource(url));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) {
      contents.push(await readFile(url, "utf8"));
    }
  }
  return contents.join("\n");
};

describe("UI styles and architecture", () => {
  it("includes responsive, safe-area, theme, and reduced-motion rules", async () => {
    const css = await readFile(new URL("styles.css", uiRoot), "utf8");
    expect(css).toContain("env(safe-area-inset-bottom)");
    expect(css).toContain("@media (min-width: 48rem)");
    expect(css).toContain("@media (min-width: 56rem)");
    expect(css).toContain("@media (min-width: 90rem)");
    expect(css).toContain("orientation: landscape");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(css).toContain("(prefers-contrast: more)");
    expect(css).toContain('[data-motion="reduced"]');
    expect(css).toContain("paper-dark-subtle.svg");
    expect(css).toContain("var(--yoyi-container-content)");
    expect(css).toContain("mask-image: var(--yoyi-label-image)");
    expect(css).toContain("-webkit-mask-image: var(--yoyi-label-image)");
    expect(css).toContain("background-color: currentcolor");
    expect(css).toContain(".yoyi-functional-glass");
    expect(css).toContain(
      "backdrop-filter: blur(var(--yoyi-blur-glass-regular))",
    );
    expect(css).toContain("var(--yoyi-material-glass-fallback-background)");
    expect(css).toContain(".yoyi-mobile-bottom-navigation.is-minimized");
    expect(css).toContain(
      ".yoyi-mobile-bottom-navigation.yoyi-functional-glass.is-minimized",
    );
    expect(css).toContain("min-height: 44px");
    expect(css).toContain(".yoyi-nav-bubble");
    expect(css).toContain("touch-action: none");
    expect(css).not.toMatch(
      /\.is-minimized \.yoyi-nav-bubble,\s*\.yoyi-mobile-bottom-navigation\.is-minimized \.yoyi-navigation-entry \{\s*opacity:\s*0/,
    );
    expect(css).not.toMatch(
      /html\[data-platform="pc"\]\s*\.yoyi-mobile-bottom-navigation\.yoyi-functional-glass\s*\{[^}]*backdrop-filter:\s*none/s,
    );
    expect(css).not.toContain("opacity: 0.68");
    const brand = await readFile(new URL("brand.css", uiRoot), "utf8");
    expect(brand).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(brand).not.toContain("system-orange");
    expect(brand).toContain("@media (forced-colors: active)");
    expect(brand).toContain("background-color: CanvasText");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("offers a blur scrim whose tint, blur and fallbacks stay in the shared UI", async () => {
    const css = await readFile(new URL("styles.css", uiRoot), "utf8");
    expect(css).toMatch(/\.yoyi-blur-scrim \{\s*isolation: isolate;\s*\}/u);
    // Its own tint layer, so a host's base background never undoes it;
    // doubled until the browser is known to blur backdrops.
    expect(css).toMatch(
      /\.yoyi-blur-scrim::before \{[^}]*position: absolute;[^}]*z-index: -1;[^}]*inset: 0;[^}]*background-color: var\(--yoyi-color-overlay\);[^}]*background-image: linear-gradient\(\s*var\(--yoyi-color-overlay\),\s*var\(--yoyi-color-overlay\)\s*\);/u,
    );
    // Where backdrops blur: the prominent blur, prefixed, over one tint.
    const blurred =
      /@supports \(\s*\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\s*\) \{\s*\.yoyi-blur-scrim \{([^}]*)\}\s*\.yoyi-blur-scrim::before \{([^}]*)\}/u.exec(
        css,
      );
    expect(blurred).not.toBeNull();
    expect(blurred![1]).toContain(
      "-webkit-backdrop-filter: blur(var(--yoyi-blur-glass-prominent));",
    );
    expect(blurred![1]).toMatch(
      /[^-]backdrop-filter: blur\(var\(--yoyi-blur-glass-prominent\)\);/u,
    );
    expect(blurred![2]).toContain("background-image: none;");
    // Reduced transparency and more contrast: no blur, the doubled dim, as
    // Functional Glass falls back.
    const plain =
      /@media \(prefers-reduced-transparency: reduce\), \(prefers-contrast: more\) \{([\s\S]*)\}\s*$/u.exec(
        css,
      )![1]!;
    expect(plain).toMatch(
      /\.yoyi-blur-scrim \{\s*-webkit-backdrop-filter: none;\s*backdrop-filter: none;\s*\}/u,
    );
    expect(plain).toMatch(
      /\.yoyi-blur-scrim::before \{\s*background-image: linear-gradient\(\s*var\(--yoyi-color-overlay\),\s*var\(--yoyi-color-overlay\)\s*\);/u,
    );
  });

  it("offers a frosted-paper veil for the scrim, with the same fallbacks", async () => {
    const css = await readFile(new URL("styles.css", uiRoot), "utf8");
    // Whitespace as the formatter breaks it does not matter.
    const flat = (text: string) =>
      text
        .replace(/\s+/gu, " ")
        .replace(/\(\s+/gu, "(")
        .replace(/\s+\)/gu, ")");
    const veil =
      "color-mix(in srgb, var(--yoyi-color-background-page) 76%, transparent)";
    const paper =
      /\n\.yoyi-blur-scrim\.yoyi-blur-scrim-paper::before \{([^}]*)\}/u.exec(
        css,
      );
    expect(paper).not.toBeNull();
    // The page's own paper, light or dark with the theme, doubled until the
    // browser is known to blur backdrops.
    expect(flat(paper![1]!)).toContain(`background-color: ${veil};`);
    expect(flat(paper![1]!)).toContain(
      `background-image: linear-gradient(${veil}, ${veil});`,
    );
    // Its base rule comes before the blur's, which leaves one veil.
    const blurred = css.search(
      /@supports \(\s*\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\s*\) \{\s*\.yoyi-blur-scrim \{/u,
    );
    expect(blurred).toBeGreaterThan(0);
    expect(css.indexOf(paper![0])).toBeLessThan(blurred);
    // Inside that @supports block, not after it.
    const supports =
      /@supports \(\s*\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\s*\) \{\s*\.yoyi-blur-scrim \{[^}]*\}\s*\.yoyi-blur-scrim::before \{[^}]*\}\s*\.yoyi-blur-scrim\.yoyi-blur-scrim-paper::before \{([^}]*)\}\s*\}/u.exec(
        css,
      );
    expect(supports).not.toBeNull();
    expect(supports![1]!.trim()).toBe("background-image: none;");
    // Reduced transparency and more contrast: the doubled paper.
    const plain =
      /@media \(prefers-reduced-transparency: reduce\), \(prefers-contrast: more\) \{([\s\S]*)\}\s*$/u.exec(
        css,
      )![1]!;
    expect(flat(plain)).toContain(
      `.yoyi-blur-scrim.yoyi-blur-scrim-paper::before { background-image: linear-gradient(${veil}, ${veil}); }`,
    );
  });

  it("has no API, database, or formal contract dependency", async () => {
    const source = await collectSource(uiRoot);
    expect(source).not.toMatch(
      /\bfetch\s*\(|axios|postgres|from\s+["']pg["']/i,
    );
    expect(source).not.toContain("@moya/contracts");
    expect(source).not.toContain("apps/web");
  });

  it("does not own application routing, storage, repositories, or mock data", async () => {
    const source = await collectSource(uiRoot);
    expect(source).not.toMatch(/localStorage|sessionStorage|\bhistory\b/);
    expect(source).not.toMatch(/Repository|mock(?:Data|Repository)/i);
    expect(source).not.toMatch(/next\/(?:router|navigation)/);
  });
});
