import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CatalogSearchProvider } from "../search/catalog-search";
import { ProductApplication } from "./product-application";

import type { T02pDevelopmentCatalogDestinationStates } from "../product-preview/catalog-scenarios";

// Keep the real shell, pager, discussion readers, and strict provider hooks.
// A mock of T02pProductPreview would hide a provider violation in a hidden panel.
const states: T02pDevelopmentCatalogDestinationStates = {
  inscriptions: { state: "unavailable" },
  calligraphy: {
    categories: {
      all: { state: "unavailable" },
      ink: { state: "classification-unavailable" },
      rubbing: { state: "classification-unavailable" },
    },
    classificationSource: "runtime-unclassified",
  },
  home: {
    discover: { state: "unavailable" },
    nearby: { state: "unavailable" },
    topics: { state: "unavailable" },
  },
};

describe("ProductApplication public server rendering", () => {
  it.each(["phone", "pc"] as const)(
    "renders normal %s navigation with unavailable live community providers",
    (initialPlatform) => {
      const markup = renderToStaticMarkup(
        <CatalogSearchProvider>
          <ProductApplication
            comments={null}
            authorCommunity={false}
            initialPlatform={initialPlatform}
            states={states}
          />
        </CatalogSearchProvider>,
      );
      expect(markup).toContain('data-product-shell=""');
      expect(markup).toContain('data-discussion-surface=""');
      expect(markup).toContain('data-threads-state="unavailable"');
      expect(markup).toContain("话题暂时不可用");
      expect(markup).not.toContain('data-threads-feed=""');
      expect(markup).not.toContain('data-article-authoring-host=""');
      expect(markup).not.toContain('data-create-work-action=""');
    },
  );
  it.each(["phone", "pc"] as const)(
    "renders the full %s business composition without provider errors",
    (initialPlatform) => {
      const markup = renderToStaticMarkup(
        <CatalogSearchProvider>
          <ProductApplication
            comments={{ signInHref: "/login" }}
            authorCommunity
            liveNotifications
            articleAuthoring
            initialPlatform={initialPlatform}
            states={states}
          />
        </CatalogSearchProvider>,
      );
      expect(markup).toContain('data-product-shell=""');
      expect(markup).toContain('data-threads-state="loading"');
      expect(markup).toContain('data-create-work-action=""');
      expect(markup).not.toContain('data-t02p-qa-harness=""');
      expect(markup).not.toContain('data-development-primary-pager=""');
    },
  );
});
