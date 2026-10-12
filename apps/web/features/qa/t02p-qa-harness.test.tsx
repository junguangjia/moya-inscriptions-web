// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

import { loadQaScenarios } from "../../app/dev/t02p/development-data";
import { T02pQaHarness } from "./t02p-qa-harness";

import type { T02pQaHarnessProps } from "./t02p-qa-harness";

let properties: T02pQaHarnessProps;

const renderHarness = (qaChrome?: "visible" | "hidden") => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <T02pQaHarness
      {...properties}
      {...(qaChrome === undefined ? {} : { qaChrome })}
    />,
  );
  return container;
};

describe("T02pQaHarness QA chrome", () => {
  beforeAll(async () => {
    const scenarios = await loadQaScenarios("http://192.0.2.44:3102");
    properties = {
      catalogScenarios: scenarios.catalog,
      detailRecords: scenarios.detail,
      homeScenarios: scenarios.home,
      initialPlatform: "phone",
    };
  });

  it("enables Discover, Calligraphy and Discussion Topic cards with either chrome setting", () => {
    for (const chrome of ["visible", "hidden"] as const) {
      const container = renderHarness(chrome);
      // A phone single-column Discover shows posts with an action row in
      // place of the long-press layer; other feeds keep the layer.
      const posts =
        container.querySelector(
          '[data-product-shell][data-platform="phone"][data-feed-layout="single"]',
        ) !== null;
      for (const [selector, actions] of [
        [
          '[data-home-feed-panel="discover"]',
          posts
            ? "[data-feed-post] [data-feed-post-actions]"
            : '[data-quick-actions="enabled"]',
        ],
        [
          '[data-home-feed-panel="calligraphy"]',
          '[data-quick-actions="enabled"]',
        ],
        ['[data-product-panel="discussion"]', '[data-quick-actions="enabled"]'],
      ] as const) {
        expect(
          container.querySelectorAll(`${selector} ${actions}`).length,
        ).toBeGreaterThan(0);
      }
      expect(
        container.querySelector(
          '[data-product-panel="inscriptions"] [data-quick-actions]',
        ),
      ).toBeNull();
      expect(container.querySelector("[data-quick-action-menu]")).toBeNull();
      expect(
        container.querySelector("[data-quick-action-feedback]"),
      ).toBeNull();
    }
  });

  it("keeps the live 话题 feed over its author and publishing providers", () => {
    const threads = renderHarness().querySelector("#discussion-panel-threads");
    expect(
      threads?.querySelector('[data-threads-state="loading"]'),
    ).not.toBeNull();
  });

  it("keeps all scenario and platform controls visible by default", () => {
    const container = renderHarness();
    const harness = container.querySelector("[data-t02p-qa-harness]");
    const controls = container.querySelector("[data-qa-controls]");

    expect(harness?.getAttribute("data-qa-chrome")).toBe("visible");
    expect(controls?.parentElement).toBe(harness);
    expect(controls?.querySelector("h1")?.textContent).toBe("T02P QA Harness");
    expect(controls?.querySelectorAll("select")).toHaveLength(6);
    expect(
      controls?.querySelector('[value="unexpected-error"]'),
    ).not.toBeNull();
    expect(controls?.querySelector('[value="empty"]')).not.toBeNull();
    expect(controls?.querySelector('[value="search-empty"]')).not.toBeNull();
    expect(
      container.querySelectorAll("[data-development-primary-pager]"),
    ).toHaveLength(1);
  });

  it("omits only controls without a hidden focus target, placeholder or extra style", () => {
    const container = renderHarness("hidden");
    const harness = container.querySelector("[data-t02p-qa-harness]");

    expect(harness?.getAttribute("data-qa-chrome")).toBe("hidden");
    expect(container.querySelector("[data-qa-controls]")).toBeNull();
    expect(container.querySelector("#t02p-qa-platform")).toBeNull();
    expect(container.querySelector("#t02p-qa-search-scenario")).toBeNull();
    expect(container.querySelector("#t02p-qa-home-scenario")).toBeNull();
    expect(container.querySelector("#t02p-qa-user-scenario")).toBeNull();
    expect(container.querySelector("#t02p-qa-catalog-scenario")).toBeNull();
    expect(container.querySelector("#t02p-qa-comment-scenario")).toBeNull();
    expect(
      container.querySelector("[data-development-primary-pager]"),
    ).toBeNull();
    expect(container.querySelector("[data-primary-pager-action]")).toBeNull();
    expect(container.querySelector("style")).toBeNull();
    expect(harness?.children).toHaveLength(1);
    expect(
      harness?.firstElementChild?.hasAttribute("data-clean-product-preview"),
    ).toBe(true);
  });

  it("preserves single product composition and content apart from the two QA control groups", () => {
    const visible = renderHarness("visible");
    const hidden = renderHarness("hidden");

    for (const container of [visible, hidden]) {
      expect(container.querySelectorAll("[data-product-shell]")).toHaveLength(
        1,
      );
      expect(
        container.querySelectorAll("[data-primary-navigation]"),
      ).toHaveLength(1);
      expect(
        container.querySelectorAll("[data-primary-navigation-destination]"),
      ).toHaveLength(3);
      expect(container.querySelectorAll("[data-search-trigger]")).toHaveLength(
        1,
      );
      expect(container.querySelectorAll("[data-user-trigger]")).toHaveLength(1);
    }
    visible.querySelector("[data-qa-controls]")?.remove();
    visible.querySelector("[data-development-primary-pager]")?.remove();
    expect(
      hidden.querySelector("[data-clean-product-preview]")?.outerHTML,
    ).toBe(visible.querySelector("[data-clean-product-preview]")?.outerHTML);
    visible
      .querySelector("[data-t02p-qa-harness]")
      ?.setAttribute("data-qa-chrome", "hidden");
    expect(hidden.innerHTML).toBe(visible.innerHTML);
  });
});
