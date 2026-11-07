import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { repositoryRoot } from "./workspace-scanner.js";

const collectSourceFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await collectSourceFiles(target)));
    else if (
      /\.[cm]?[jt]sx?$/u.test(entry.name) &&
      !/\.test\./u.test(entry.name)
    ) {
      files.push(target);
    }
  }
  return files;
};

describe("T02 R03 architecture boundaries", () => {
  it("keeps Product Home, Topics, and source composition independent from Development QA", async () => {
    const roots = [
      path.join(repositoryRoot, "apps/web/features/home"),
      path.join(repositoryRoot, "apps/web/features/quick-actions"),
      path.join(repositoryRoot, "apps/web/features/topics"),
      path.join(repositoryRoot, "apps/web/features/product-shell"),
      path.join(repositoryRoot, "apps/web/features/product-preview"),
      path.join(repositoryRoot, "apps/web/features/product-application"),
      path.join(repositoryRoot, "apps/web/features/detail"),
      path.join(repositoryRoot, "apps/web/sources"),
    ];
    const violations: string[] = [];
    for (const root of roots) {
      for (const file of await collectSourceFiles(root)) {
        const source = await readFile(file, "utf8");
        if (
          /(?:^|[/])app\/dev|development-data|apps\/web\/qa|\.\.\/qa\/|features\/qa|docs\/prototypes/u.test(
            source,
          )
        ) {
          violations.push(path.relative(repositoryRoot, file));
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps quick actions independent of business services and persistent state", async () => {
    const files = await collectSourceFiles(
      path.join(repositoryRoot, "apps/web/features/quick-actions"),
    );
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source).not.toMatch(
        /localStorage|sessionStorage|indexedDB|navigator\.share|clipboard|\bfetch\s*\(|mock-content-action-store|qa-user/u,
      );
    }
  });

  it("keeps one bounded Content V1 Detail and the existing Viewer without Gallery", async () => {
    const preview = await readFile(
      path.join(
        repositoryRoot,
        "apps/web/features/product-preview/t02p-product-preview.tsx",
      ),
      "utf8",
    );
    expect(preview).toMatch(/CatalogDetail|renderDetailOverlay/u);
    expect(preview).not.toMatch(/Gallery/u);
    expect(preview).toContain("TopicDetail");

    const detailRoot = path.join(repositoryRoot, "apps/web/features/detail");
    const detailStyles = await readFile(
      path.join(detailRoot, "catalog-detail.module.css"),
      "utf8",
    );
    const violations: string[] = [];
    for (const file of await collectSourceFiles(detailRoot)) {
      const source = await readFile(file, "utf8");
      if (/gallery|\bonRetry\b|>重试</u.test(source)) {
        violations.push(path.relative(repositoryRoot, file));
      }
    }
    expect(violations).toEqual([]);
    const viewer = await readFile(
      path.join(detailRoot, "catalog-viewer.tsx"),
      "utf8",
    );
    expect(viewer).toMatch(/CatalogViewer|data-detail-viewer/u);
    expect(viewer).not.toMatch(/apps\/web\/qa|docs\/prototypes/u);
    expect(viewer).not.toMatch(
      /contributors|scriptStyle|transcription|historicalContext|scholarlyResearch/u,
    );
    const screen = await readFile(
      path.join(detailRoot, "catalog-detail-screen.tsx"),
      "utf8",
    );
    expect(screen).not.toContain("dangerouslySetInnerHTML");
    expect(detailStyles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.mediaTrack,[\s\S]*transition-duration: 1ms;/u,
    );
  });

  it("uses the accepted React preview at Formal root while preserving the Catalog redirect", async () => {
    const formal = await readFile(
      path.join(repositoryRoot, "apps/web/app/page.tsx"),
      "utf8",
    );
    const catalogRedirect = await readFile(
      path.join(repositoryRoot, "apps/web/app/catalog/[catalogId]/route.ts"),
      "utf8",
    );
    // The accepted preview reaches the Formal root through the Product
    // application shell (Mission 2C), which composes comments on the client.
    expect(formal).toContain("ProductApplication");
    expect(formal).not.toMatch(
      /readT02Document|t02-static-files|(?:^|[/])app\/dev|development-data|features\/qa|docs\/prototypes/u,
    );
    const application = await readFile(
      path.join(
        repositoryRoot,
        "apps/web/features/product-application/product-application.tsx",
      ),
      "utf8",
    );
    expect(application).toContain("T02pProductPreview");
    expect(application).not.toMatch(
      /readT02Document|t02-static-files|(?:^|[/])app\/dev|development-data|features\/qa|docs\/prototypes|useQaCommentStore|comment-scenarios/u,
    );
    expect(catalogRedirect).not.toMatch(
      /T02pProductPreview|HomeScreen|TopicDetail|apps\/web\/qa|features\/qa/u,
    );
    expect(catalogRedirect).toContain("redirect");
    expect(catalogRedirect).toContain("307");
  });

  it("contains no committed machine-specific IPv4 origin in R03 runtime composition", async () => {
    const roots = [
      path.join(repositoryRoot, "apps/web/features/home"),
      path.join(repositoryRoot, "apps/web/features/topics"),
      path.join(repositoryRoot, "apps/web/sources"),
      path.join(repositoryRoot, "apps/web/qa/home"),
    ];
    const violations: string[] = [];
    for (const root of roots) {
      for (const file of await collectSourceFiles(root)) {
        const source = await readFile(file, "utf8");
        if (
          /https?:\/\/(?!127\.0\.0\.1)(?:\d{1,3}\.){3}\d{1,3}/u.test(source)
        ) {
          violations.push(path.relative(repositoryRoot, file));
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps progressive Catalog paging same-origin, explicit, and feature-local", async () => {
    const route = await readFile(
      path.join(repositoryRoot, "apps/web/app/api/catalog/route.ts"),
      "utf8",
    );
    const browserClient = await readFile(
      path.join(
        repositoryRoot,
        "apps/web/lib/public-api/catalog-list-client.ts",
      ),
      "utf8",
    );
    const home = await readFile(
      path.join(repositoryRoot, "apps/web/features/home/home-screen.tsx"),
      "utf8",
    );
    const pagingRoot = path.join(
      repositoryRoot,
      "apps/web/features/catalog-paging",
    );
    const pagingSources = await Promise.all(
      (await collectSourceFiles(pagingRoot)).map((file) =>
        readFile(file, "utf8"),
      ),
    );
    const paging = pagingSources.join("\n");

    expect(route).toContain("fetchServerCatalogPage");
    expect(route).not.toMatch(
      /development-data|apps\/web\/qa|features\/qa|docs\/prototypes|database|storage/u,
    );
    expect(browserClient).toContain('"/api/catalog"');
    expect(browserClient).not.toMatch(
      /MOYA_PUBLIC_API_BASE_URL|\/v1\/catalog|development-data|apps\/web\/qa|features\/qa/u,
    );
    expect(home).not.toMatch(/catalog-paging|CatalogPaging/u);
    expect(paging).not.toMatch(
      /IntersectionObserver|sessionStorage|localStorage|indexedDB|history\.state|ProductHistory|createContext/u,
    );
  });

  it("keeps local category touch paging independent from Primary gesture machinery", async () => {
    const homeAdapter = await readFile(
      path.join(repositoryRoot, "apps/web/features/home/home-feed-pager.tsx"),
      "utf8",
    );
    const pager = await readFile(
      path.join(repositoryRoot, "apps/web/features/shell/horizontal-pager.tsx"),
      "utf8",
    );
    const styles = await readFile(
      path.join(
        repositoryRoot,
        "apps/web/features/shell/horizontal-pager.module.css",
      ),
      "utf8",
    );
    const home = await readFile(
      path.join(repositoryRoot, "apps/web/features/home/home-screen.tsx"),
      "utf8",
    );
    const productShell = await readFile(
      path.join(
        repositoryRoot,
        "apps/web/features/product-shell/product-shell.tsx",
      ),
      "utf8",
    );
    const productStyles = await readFile(
      path.join(
        repositoryRoot,
        "apps/web/features/product-shell/product-shell.module.css",
      ),
      "utf8",
    );

    expect(homeAdapter).toContain(
      'import { HorizontalPager } from "../shell/horizontal-pager"',
    );
    expect(homeAdapter).toContain("keys={homeFeeds}");
    expect(pager).not.toMatch(
      /home-feed|discover|nearby|timeline|topics|user-scenarios/u,
    );
    // Category hosts retain state/scroll ownership; the approved core owns
    // touch motion, without a second direction or animation implementation.
    const engine = await readFile(
      path.join(
        repositoryRoot,
        "apps/web/features/shell/category-pager-engine.ts",
      ),
      "utf8",
    );
    expect(pager).toContain("createCategoryPagerEngine(frame, {");
    expect(pager).toContain("engine.destroy()");
    expect(pager).not.toMatch(
      /resolvePagerDirection|setPointerCapture|pagerSettleProgress/u,
    );
    expect(engine).toContain('from "embla-carousel"');
    expect(engine).toContain("api.destroy()");
    expect(engine).not.toContain("internalEngine");
    expect(pager).not.toMatch(/translate3d|spring|resistance/u);
    expect(styles).toContain("touch-action: pan-y pinch-zoom;");
    expect(pager).not.toMatch(
      /HORIZONTAL_PAGER_SCROLL_IDLE_MS|setTimeout\([^)]*settle/u,
    );
    expect(pager).not.toMatch(/clientWidth\s*\*\s*(?:index|targetIndex)/u);
    expect(pager).toContain('"onscrollend" in frame');
    expect(pager).toContain("panel.offsetLeft");
    expect(pager).toContain("internalCommitIndexRef");
    expect(pager).toContain("generationRef");
    expect(pager).toContain("HORIZONTAL_PAGER_FALLBACK_STABLE_FRAMES");
    expect(pager).not.toMatch(/primary-navigation|PrimaryNavigationPager/u);
    expect(home).not.toMatch(/history|popstate/u);
    expect(productShell).toContain("registerActiveHomeScrollElement");
    expect(productShell).toContain('addEventListener("popstate"');
    expect(styles).toMatch(
      /\.frame \{[^}]*overflow-x: auto;[^}]*scroll-snap-type: x mandatory;[^}]*touch-action: pan-x pan-y pinch-zoom;/su,
    );
    expect(styles).toMatch(
      /\.panel \{[^}]*scroll-snap-align: start;[^}]*scroll-snap-stop: always;/su,
    );
    expect(styles).toMatch(/\.track \{[^}]*gap: 0;[^}]*padding: 0;/su);
    expect(styles).toMatch(
      /data-horizontal-pager-scroll-owner="panel"\] \.panel \{[^}]*height: 100%;/u,
    );
    expect(styles).toMatch(
      /data-horizontal-pager-scroll-owner="panel"\] \.panel \{[^}]*overflow-y: auto;[^}]*overscroll-behavior-y: contain;[^}]*-webkit-overflow-scrolling: touch;/u,
    );
    expect(styles.match(/(?:^|\n)\.panel \{[^}]*\}/u)?.[0]).not.toContain(
      "overflow-y: auto",
    );
    expect(productStyles).toMatch(
      /data-primary-destination="home"\][\s\S]*overflow: hidden;/u,
    );
  });

  it("scopes the new PC card treatment to R03 masonry and preserves deferred browse spacing", async () => {
    const styles = await readFile(
      path.join(
        repositoryRoot,
        "apps/web/features/home/home-screen.module.css",
      ),
      "utf8",
    );
    expect(styles).not.toContain(
      ':global([data-primary-shell][data-platform="pc"]) .feedCard {',
    );
    expect(styles).toContain(
      ':global([data-primary-shell][data-platform="pc"]) .masonry .feedCard {',
    );
    expect(styles).toMatch(
      /data-platform="tablet"\]\) \.feed \{\s+column-gap: var\(--yoyi-space-5\);/u,
    );
    expect(styles).toMatch(
      /data-platform="pc"\]\) \.feed \.feedCard \{\s+margin-bottom: var\(--yoyi-space-5\);/u,
    );
    expect(styles).toMatch(/\.screenHeader h2 \{[^}]*line-height: 1\.3;/u);
    expect(styles).toMatch(
      /:global\(html\[data-home-layout="single"\]\) \.feed \{\s+column-count: 1;/u,
    );
  });
});
