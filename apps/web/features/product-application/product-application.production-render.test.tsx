import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CatalogSearchProvider } from "../search/catalog-search";
import { ProductApplication } from "./product-application";

import type { T02pDevelopmentCatalogDestinationStates } from "../product-preview/catalog-scenarios";
import type { WideScreenBrowseOnlyHint } from "../shell/browse-only";

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

describe("ProductApplication wide-screen browse-only server rendering (pc-browse-only-v1)", () => {
  const render = (
    initialPlatform: "phone" | "tablet" | "pc",
    wideScreenBrowseOnly?: WideScreenBrowseOnlyHint,
  ) =>
    renderToStaticMarkup(
      <CatalogSearchProvider>
        <ProductApplication
          comments={{ signInHref: "/login" }}
          authorCommunity
          liveNotifications
          articleAuthoring
          initialPlatform={initialPlatform}
          states={states}
          {...(wideScreenBrowseOnly === undefined
            ? {}
            : { wideScreenBrowseOnly })}
        />
      </CatalogSearchProvider>,
    );
  // The opening tag that carries the marker (React escapes ">" in values).
  const openingTag = (markup: string, marker: string) => {
    const tag = markup.match(
      new RegExp(`<[a-z][a-z0-9]*\\s[^>]*${marker}[^>]*>`, "u"),
    )?.[0];
    expect(tag, marker).toBeDefined();
    return tag ?? "";
  };
  const shellTag = (markup: string) =>
    openingTag(markup, 'data-product-shell=""');
  const navigationTag = (markup: string) =>
    openingTag(markup, 'data-primary-navigation-layer=""');

  it.each(["pc", "tablet"] as const)(
    "renders %s browse-only for a visitor without an account",
    (initialPlatform) => {
      const markup = render(initialPlatform, { sessionHint: false });
      expect(shellTag(markup)).toContain('data-browse-only="true"');
      expect(navigationTag(markup)).toContain('hidden=""');
      expect(markup).not.toContain("data-create-work-action");
      expect(markup).toContain('data-search-trigger-placement="header"');
      expect(markup).toContain("豫ICP备");
    },
  );

  it("renders pc browse-only while a session cookie waits for /me", () => {
    const markup = render("pc", { sessionHint: true });
    expect(shellTag(markup)).toContain('data-browse-only="true"');
    expect(navigationTag(markup)).toContain('hidden=""');
  });

  it.each([{ sessionHint: false }, { sessionHint: true }])(
    "keeps the phone composition unchanged with %j",
    (hint) => {
      const markup = render("phone", hint);
      expect(shellTag(markup)).toContain('data-browse-only="false"');
      expect(navigationTag(markup)).not.toContain("hidden");
      expect(markup).toContain('data-create-work-action=""');
      expect(markup).toBe(render("phone"));
    },
  );

  it.each(["phone", "tablet", "pc"] as const)(
    "keeps %s unchanged without the policy",
    (initialPlatform) => {
      const markup = render(initialPlatform);
      expect(shellTag(markup)).toContain('data-browse-only="false"');
      expect(navigationTag(markup)).not.toContain("hidden");
      expect(markup).toContain('data-create-work-action=""');
    },
  );
});
