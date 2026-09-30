import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { lightTheme, darkTheme } from "@moya/design-tokens";
import { AdminLogo, AdminIcon } from "admin/branding";

describe("canonical admin branding", () => {
  it("uses the exact product name and centralized neutral material for both graphic slots", () => {
    for (const graphic of [<AdminLogo />, <AdminIcon />]) {
      const html = renderToStaticMarkup(graphic);
      expect(html).toContain('aria-label="由于艺"');
      expect(html).toContain(
        `--admin-brand-light-floor:${lightTheme["brand-recess-floor"]}`,
      );
      expect(html).toContain(
        `--admin-brand-dark-floor:${darkTheme["brand-recess-floor"]}`,
      );
      expect(html).toContain("yoyi-logo");
      expect(html).not.toContain("system-orange");
      expect(html).not.toContain("ArtVenn");
      expect(html).not.toContain("<svg");
    }
  });
  it("shares canonical geometry and switches only mark paint for the real theme", async () => {
    const css = await readFile(
      new URL(
        "../../../apps/admin/src/branding/brand.module.css",
        import.meta.url,
      ),
      "utf8",
    );
    const shared = await readFile(
      new URL("../../../packages/ui/src/brand.css", import.meta.url),
      "utf8",
    );
    expect(shared).toContain("aspect-ratio: 658 / 426");
    expect(shared).toContain('url("./assets/brand/yoyi-logo.svg")');
    expect(css).toContain('[data-theme="dark"] .mark');
    expect(css).toContain("var(--admin-brand-dark-floor)");
    expect(css).not.toContain("var(--theme-elevation-1000)");
  });
});
