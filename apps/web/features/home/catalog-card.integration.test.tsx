// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CatalogCard } from "./catalog-card";
import { MEDIA_SIZES } from "../media/responsive-media";

import type { Root } from "react-dom/client";
import type {
  CatalogId,
  CatalogSummary,
  MediaId,
  PublicMedia,
} from "@moya/contracts";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const media = {
  alt: "横幅图像",
  height: 300,
  id: "media-failed" as MediaId,
  kind: "image",
  src: "/failed-media.svg",
  width: 900,
} as PublicMedia;
const item = {
  aliases: [],
  id: "catalog-failed-media" as CatalogId,
  kind: "inscription",
  representativeMedia: media,
  title: "失败媒体条目",
} as CatalogSummary;

const renderCard = (variant: "feed" | "inscription") => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<CatalogCard item={item} variant={variant} />));
  act(() =>
    container
      .querySelector("img")
      ?.dispatchEvent(new Event("error", { bubbles: true })),
  );
  return container.querySelector<HTMLElement>(
    '[data-catalog-media-state="failed"]',
  )!;
};

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe("CatalogCard failed media geometry", () => {
  it("bounds failed panorama covers to the same cropped feed footprint", () => {
    expect(
      renderCard("feed").style.getPropertyValue("--feed-media-ratio"),
    ).toBe("1.5");
  });

  it("does not override the deferred Inscriptions fallback geometry", () => {
    expect(renderCard("inscription").style.aspectRatio).toBe("");
  });
});

describe("CatalogCard unchanged activation without quick actions", () => {
  const renderButton = () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    let opened = 0;
    act(() =>
      root.render(
        <CatalogCard
          item={item}
          variant="feed"
          onOpenCatalog={() => {
            opened += 1;
          }}
        />,
      ),
    );
    return { button: container.querySelector("button")!, count: () => opened };
  };
  const send = (button: HTMLButtonElement, name: string, x = 0, y = 0) => {
    const event = new MouseEvent(name, {
      bubbles: true,
      clientX: x,
      clientY: y,
    });
    act(() => button.dispatchEvent(event));
  };
  it("keeps the 8px vertical guard and leaves horizontal-only clicks unchanged", () => {
    const view = renderButton();
    send(view.button, "pointerdown");
    send(view.button, "pointermove", 0, 9);
    send(view.button, "pointerup", 0, 9);
    act(() => view.button.click());
    expect(view.count()).toBe(0);
    send(view.button, "pointerdown");
    send(view.button, "pointermove", 40, 0);
    send(view.button, "pointerup", 40, 0);
    act(() => view.button.click());
    expect(view.count()).toBe(1);
    expect(view.button.hasAttribute("data-quick-actions")).toBe(false);
  });
});

/*
 * unified-media-pipeline-v1 (CW4/CW8/CW13): a card offers its card
 * candidates up to the anchor, which stays its `src`; the covered box shows
 * the asset colour until the image paints.
 */
describe("CatalogCard responsive media", () => {
  const origin = "https://media.example.invalid/catalog";
  const candidate = (width: number, height: number) => ({
    src: `${origin}/${width}.webp`,
    width,
    height,
    contentType: "image/webp" as const,
  });
  const responsive = {
    alt: "碑刻代表图",
    height: 1600,
    id: "media-responsive" as MediaId,
    kind: "image",
    src: candidate(1200, 1600).src,
    width: 1200,
    placeholderColor: "#655044",
    renditions: [
      candidate(360, 480),
      candidate(810, 1080),
      candidate(1200, 1600),
    ],
  } as PublicMedia;
  const render = (
    representativeMedia: PublicMedia,
    variant: "feed" | "inscription",
    priority?: "high" | "eager",
  ) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() =>
      root.render(
        <CatalogCard
          item={{ ...item, representativeMedia }}
          {...(priority === undefined ? {} : { priority })}
          variant={variant}
        />,
      ),
    );
    return container;
  };
  afterEach(() => vi.unstubAllEnvs());

  it("keeps src as the anchor and offers the card candidates", () => {
    const image = render(responsive, "feed").querySelector("img")!;
    expect(image.getAttribute("src")).toBe(responsive.src);
    expect(image.getAttribute("srcset")).toBe(
      `${origin}/360.webp 360w, ${origin}/810.webp 810w, ${origin}/1200.webp 1200w`,
    );
    expect(image.getAttribute("sizes")).toBe(MEDIA_SIZES.feedCard(responsive));
    expect(image.getAttribute("width")).toBe("1200");
    expect(image.getAttribute("height")).toBe("1600");
    const inscription = render(responsive, "inscription").querySelector("img")!;
    expect(inscription.getAttribute("sizes")).toBe(
      MEDIA_SIZES.inscriptionCard(responsive),
    );
  });

  it("paints the placeholder colour behind the covering image only", () => {
    for (const variant of ["feed", "inscription"] as const) {
      const box = render(responsive, variant).querySelector<HTMLElement>(
        '[data-catalog-media-state="valid"]',
      )!;
      expect(box.querySelector("img")?.style.backgroundColor).toBe(
        "rgb(101, 80, 68)",
      );
      // The box keeps its own background: an inscription box can grow
      // taller than its image, and that strip must never stay tinted.
      expect(box.style.backgroundColor).toBe("");
    }
    expect(
      render(responsive, "feed")
        .querySelector<HTMLElement>('[data-catalog-media-state="valid"]')!
        .style.getPropertyValue("--feed-media-ratio"),
    ).toBe("0.75");
    // A legacy image carries no colour and no candidates.
    const legacy = render(media, "feed").querySelector("img")!;
    expect(legacy.style.backgroundColor).toBe("");
    expect(legacy.hasAttribute("srcset")).toBe(false);
    expect(legacy.hasAttribute("sizes")).toBe(false);
  });

  it("loads the first visible cards eagerly and the rest lazily", () => {
    const first = render(responsive, "feed", "high").querySelector("img")!;
    expect(first.getAttribute("loading")).toBe("eager");
    expect(first.getAttribute("fetchpriority")).toBe("high");
    const second = render(responsive, "feed", "eager").querySelector("img")!;
    expect(second.getAttribute("loading")).toBe("eager");
    expect(second.hasAttribute("fetchpriority")).toBe(false);
    const later = render(responsive, "inscription").querySelector("img")!;
    expect(later.getAttribute("loading")).toBe("lazy");
    expect(later.hasAttribute("fetchpriority")).toBe(false);
    expect(later.getAttribute("decoding")).toBe("async");
  });

  it("keeps the truthful failure state of a card with candidates", () => {
    const container = render(responsive, "feed");
    act(() =>
      container
        .querySelector("img")
        ?.dispatchEvent(new Event("error", { bubbles: true })),
    );
    expect(
      container.querySelector('[data-catalog-media-state="failed"]')
        ?.textContent,
    ).toContain("图像无法加载");
  });

  it("serves Development Catalog renditions through the Web origin", () => {
    vi.stubEnv("NODE_ENV", "development");
    const id = (hex: string) => `media-rendition-${hex.repeat(32)}`;
    const loopback = (hex: string) =>
      `http://127.0.0.1:3411/v1/development/catalog-renditions/${id(hex)}`;
    const image = render(
      {
        ...responsive,
        src: loopback("b"),
        renditions: [
          { ...candidate(360, 480), src: loopback("a") },
          { ...candidate(1200, 1600), src: loopback("b") },
        ],
      } as PublicMedia,
      "feed",
    ).querySelector("img")!;
    expect(image.getAttribute("src")).toBe(
      `/api/development/catalog-renditions/${id("b")}`,
    );
    expect(image.getAttribute("srcset")).toBe(
      `/api/development/catalog-renditions/${id("a")} 360w, ` +
        `/api/development/catalog-renditions/${id("b")} 1200w`,
    );
  });
});
