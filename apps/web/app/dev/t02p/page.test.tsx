import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { headersMock, notFoundMock } = vi.hoisted(() => ({
  headersMock: vi.fn(),
  notFoundMock: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/headers", () => ({ headers: headersMock }));
vi.mock("next/navigation", () => ({ notFound: notFoundMock }));
vi.mock("./development-data", async (importOriginal) => {
  const original = await importOriginal<typeof developmentData>();
  return {
    ...original,
    loadCleanPreviewStates: vi.fn(original.loadCleanPreviewStates),
  };
});

import { loadCleanPreviewStates } from "./development-data";
import T02pDevelopmentPage from "./page";

import type * as developmentData from "./development-data";

describe("T02pDevelopmentPage", () => {
  beforeEach(() => {
    headersMock.mockResolvedValue(
      new Headers({
        host: "192.0.2.44:3102",
        "user-agent": "Mozilla/5.0 (iPhone) Mobile",
        "x-forwarded-proto": "http",
      }),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps the Development acceptance route unavailable in Production", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(T02pDevelopmentPage({})).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalledOnce();
    expect(headersMock).not.toHaveBeenCalled();
  });

  it("renders the clean product preview without QA controls in Development", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const markup = renderToStaticMarkup(await T02pDevelopmentPage({}));

    expect(markup).toContain("data-clean-product-preview");
    expect(markup).toContain("data-product-shell");
    expect(markup).toContain('data-platform="phone"');
    expect(markup).not.toContain("T02P QA Harness");
    expect(markup).not.toContain("data-quick-actions");
    expect(markup).not.toContain("data-quick-action-feedback");
    expect(markup).not.toContain("data-qa-controls");
    expect(markup).not.toContain("data-qa-platform-selector");
    expect(markup).not.toContain("data-qa-catalog-scenario-selector");
    expect(markup).not.toContain("data-development-primary-pager");
    expect(markup).not.toContain("data-inscription-filter");
    expect(markup).not.toContain("data-t02p-qa-search");
    expect(markup).not.toContain("data-open-settings");
    expect(markup).not.toContain("data-primary-navigation-action");
    const states = await vi.mocked(loadCleanPreviewStates).mock.results.at(-1)
      ?.value;
    const timeline = states.home.timeline;
    expect(timeline.state).toBe("populated");
    expect(
      timeline.items.some(
        (entry: { media: { src: string } | null }) =>
          entry.media?.src.startsWith(
            "http://192.0.2.44:3102/docs/design-system/assets/demo/",
          ) === true,
      ),
    ).toBe(true);
    expect(markup.match(/data-primary-destination=/g)).toHaveLength(3);
  });

  it("uses the approved tablet SSR fallback for an iPad request", async () => {
    vi.stubEnv("NODE_ENV", "development");
    headersMock.mockResolvedValue(
      new Headers({
        host: "192.0.2.44:3102",
        "user-agent": "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)",
      }),
    );

    const markup = renderToStaticMarkup(await T02pDevelopmentPage({}));

    expect(markup).toContain('data-platform="tablet"');
  });

  it("fails closed when the Development request has no unambiguous Host", async () => {
    vi.stubEnv("NODE_ENV", "development");
    headersMock.mockResolvedValue(new Headers());

    await expect(T02pDevelopmentPage({})).rejects.toThrow(
      "Missing Host header",
    );
  });
});
