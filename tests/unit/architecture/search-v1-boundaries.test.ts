import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  repositoryRoot,
  clientBoundaryViolations,
  frontendBoundaryViolations,
} from "./workspace-scanner.js";

const read = (file: string) =>
  readFile(path.join(repositoryRoot, file), "utf8");
describe("formal Search V1 boundaries", () => {
  it("uses the existing ProductShell slots and the sole Detail navigation owner", async () => {
    const formal = await read("apps/web/app/page.tsx");
    const application = await read(
      "apps/web/features/product-application/product-application.tsx",
    );
    const search = await read("apps/web/features/search/catalog-search.tsx");
    // The Product application shell (Mission 2C) wraps the accepted preview;
    // the Formal page still owns the Search slots.
    expect(formal).toContain("ProductApplication");
    expect(application).toContain("T02pProductPreview");
    expect(formal).toContain(
      "navigationAction={<CatalogSearchNavigationAction",
    );
    expect(formal).toMatch(/productUtility=\{\s*<>\s*<CatalogSearch\s*\/>/u);
    expect(formal).toContain("<ProductAnalytics");
    expect(search).toContain("openCatalog(record.id, opener)");
    expect(search).not.toMatch(
      /history\.(?:pushState|replaceState)|localStorage|sessionStorage|indexedDB|\.sort\(/u,
    );
  });
  it("keeps formal search independent of QA data and backend implementations", async () => {
    const files = await readdir(
      path.join(repositoryRoot, "apps/web/features/search"),
    );
    for (const name of files.filter(
      (file) => /\.tsx?$/u.test(file) && !file.includes(".test."),
    )) {
      const source = await read(`apps/web/features/search/${name}`);
      expect(source).not.toMatch(
        /from ["'][^"']*(?:\/qa\/|search-scenarios|development-data|prototypes|catalog-postgres|backend-|data-access)/u,
      );
      expect(source).not.toMatch(
        /qaRecentSearches|qaSuggestedSearches|qaTypingSuggestions/u,
      );
    }
    const wrapper = await read("apps/web/features/qa/t02p-qa-search.tsx");
    expect(wrapper).toContain("SearchPresentation");
    expect(wrapper).toContain("qaSuggestedSearches");
  });
  it("leaves SQL and normalization behind the HTTP backend boundary", async () => {
    const files = [
      "apps/web/app/api/catalog-search/route.ts",
      "apps/web/lib/public-api/catalog-search-client.ts",
      "apps/web/lib/public-api/catalog-search.ts",
    ];
    for (const file of files) {
      const source = await read(file);
      expect(source).not.toMatch(
        /@moya\/(?:search|catalog-postgres|backend-|data-access)|\bSELECT\b|\bILIKE\b|OpenCC|opencc/u,
      );
      expect(source).not.toMatch(/console\.|process\.(?:stdout|stderr)/u);
    }
  });
  it("allows only the named Search transport seam and still denies other clients or server imports", () => {
    const component = path.join(
      repositoryRoot,
      "apps/web/features/search/catalog-search.tsx",
    );
    const route = path.join(
      repositoryRoot,
      "apps/web/app/api/catalog-search/route.ts",
    );
    const client = `"use client"; import { fetchSameOriginCatalogSearchPage, parseCatalogSearchPage, parseCatalogSearchQuery } from "../../lib/public-api/catalog-search-client";`;
    expect(clientBoundaryViolations(component, client)).toEqual([]);
    expect(
      clientBoundaryViolations(
        component.replace("catalog-search.tsx", "other.tsx"),
        client,
      ),
    ).not.toEqual([]);
    expect(
      clientBoundaryViolations(
        component,
        client.replace("parseCatalogSearchQuery", "unapprovedFunction"),
      ),
    ).not.toEqual([]);
    expect(
      clientBoundaryViolations(
        component,
        `"use client"; import { fetchServerCatalogSearchPage } from "../../lib/public-api/server";`,
      ),
    ).not.toEqual([]);
    const bridge = `import { fetchServerCatalogSearchPage } from "../../../lib/public-api/server";`;
    expect(frontendBoundaryViolations(route, bridge)).toEqual([]);
    expect(
      frontendBoundaryViolations(
        route,
        bridge.replace(
          "fetchServerCatalogSearchPage",
          "fetchServerCatalogDetail",
        ),
      ),
    ).not.toEqual([]);
    expect(
      frontendBoundaryViolations(
        route.replace("catalog-search", "unapproved"),
        bridge,
      ),
    ).not.toEqual([]);
    expect(
      frontendBoundaryViolations(route, `"use client"; ${bridge}`),
    ).not.toEqual([]);
  });
});
