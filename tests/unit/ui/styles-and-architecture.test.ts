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
