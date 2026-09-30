import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendCalligraphyItems,
  appendDiscoverItems,
  appendInscriptionItems,
  readT02Document,
  sanitizeProductionT02Document,
  serveT02File,
  methodNotAllowed,
} from "./t02-static-files";

import type { BrowseItem } from "./t02-static-files";

const bodyText = async (response: Response) => response.text();

const runtimeItem = (
  title: string,
  kind: "inscription" | "calligraphy",
): BrowseItem => ({
  id: `runtime-${title}`,
  kind,
  title,
  aliases: [],
  summary: `${title}摘要`,
  periodLabel: "唐",
  representativeMedia: {
    id: `media-${title}`,
    kind: "image" as const,
    src: "https://example.com/runtime.jpg",
    alt: `${title}真实图像`,
    width: 1200,
    height: 1600,
  },
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("formal T02 file serving", () => {
  it("serves the imported brand stylesheet through the contained readonly boundary", async () => {
    const get = await serveT02File(
      { kind: "ui-styles", segments: ["brand.css"] },
      "GET",
    );
    expect(get.status).toBe(200);
    expect(get.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    expect(await get.text()).toContain(".yoyi-logo::before");
    const head = await serveT02File(
      { kind: "ui-styles", segments: ["brand.css"] },
      "HEAD",
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(methodNotAllowed().status).toBe(405);
    const traversal = await serveT02File(
      { kind: "prototype", segments: ["..", "brand.css"] },
      "GET",
    );
    expect(traversal.status).toBe(404);
  });

  it("appends real Discover cards without replacing canonical QA cards", async () => {
    const source = await (
      await serveT02File({ kind: "prototype", segments: ["index.html"] }, "GET")
    ).text();
    const result = appendDiscoverItems(source, [
      runtimeItem("真实第一条", "inscription"),
      runtimeItem("真实第二条", "inscription"),
    ]);

    expect(result).toContain("真实第一条");
    expect(result).toContain("真实第二条");
    expect(result).toContain('data-record-origin="runtime"');
    expect(result).toContain('data-content-id="discover-cliff-gate"');
    expect(result).toContain('data-title="山门北壁题记"');
    expect(result).toContain('data-content-id="discover-ink"');
    expect(result).toContain('data-title="纸上墨痕"');
    expect(result).toContain("../../design-system/assets/demo/cliff-gate.svg");
    expect(result).toContain("https://example.com/runtime.jpg");
  });

  it("appends real Inscription records while preserving every QA card identity", async () => {
    const source = await (
      await serveT02File({ kind: "prototype", segments: ["index.html"] }, "GET")
    ).text();
    const result = appendInscriptionItems(source, [
      runtimeItem("真实碑刻一", "inscription"),
      runtimeItem("真实碑刻二", "inscription"),
    ]);

    expect(result).toContain("真实碑刻一");
    expect(result).toContain("真实碑刻二");
    expect(result).toContain('data-content-id="runtime-真实碑刻一"');
    expect(result).toContain('data-content-id="inscription-yunfeng"');
    expect(result).toContain('data-title="云峰山题名"');
    expect(result).toContain('data-content-id="inscription-shimen"');
    expect(result).toContain('data-title="石门东侧残刻"');
    expect(result).toContain(
      "../../design-system/assets/demo/rubbing-fragment.svg",
    );
    expect(result).toContain("data-search-empty");
  });

  it("appends real Calligraphy records while preserving every QA card identity", async () => {
    const source = await (
      await serveT02File({ kind: "prototype", segments: ["index.html"] }, "GET")
    ).text();
    const result = appendCalligraphyItems(source, [
      runtimeItem("真实书帖一", "calligraphy"),
      runtimeItem("真实书帖二", "calligraphy"),
    ]);

    expect(result).toContain("真实书帖一");
    expect(result).toContain("真实书帖二");
    expect(result).toContain('data-content-id="runtime-真实书帖一"');
    expect(result).toContain('data-category="all"');
    expect(result).toContain('data-content-id="calligraphy-autumn"');
    expect(result).toContain('data-title="秋山札"');
    expect(result).toContain('data-content-id="calligraphy-pine"');
    expect(result).toContain('data-title="松窗帖"');
    expect(result).toContain("../../design-system/assets/demo/ink-album.svg");
  });

  it("preserves accepted browse search text and calligraphy metadata", async () => {
    const source = await (
      await serveT02File({ kind: "prototype", segments: ["index.html"] }, "GET")
    ).text();
    const inscription = appendInscriptionItems(source, [
      runtimeItem("苍岩题记", "inscription"),
    ]);
    const calligraphy = appendCalligraphyItems(source, [
      runtimeItem("兰亭短札", "calligraphy"),
    ]);

    expect(inscription).toContain(
      'data-search-text="苍岩题记 苍岩题记摘要 唐"',
    );
    expect(calligraphy).toContain(
      'data-calligraphy-filter-text="兰亭短札 兰亭短札摘要 唐"',
    );
    expect(calligraphy).toContain('<span class="app-card__meta">唐</span>');
    expect(calligraphy).not.toContain(
      '<span class="app-card__meta">唐 · 书帖</span>',
    );
  });

  it("never mutates canonical source when there are no runtime items", async () => {
    const source = await (
      await serveT02File({ kind: "prototype", segments: ["index.html"] }, "GET")
    ).text();

    expect(appendDiscoverItems(source, [])).toBe(source);
    expect(appendInscriptionItems(source, [])).toBe(source);
    expect(appendCalligraphyItems(source, [])).toBe(source);
  });

  it("escapes runtime content before appending it to T02 HTML", async () => {
    const source = await (
      await serveT02File({ kind: "prototype", segments: ["index.html"] }, "GET")
    ).text();
    const item = runtimeItem(`真实 <b>"第一"</b> & '条'`, "calligraphy");
    const result = appendCalligraphyItems(source, [item]);

    expect(result).toContain(
      "真实 &lt;b&gt;&quot;第一&quot;&lt;/b&gt; &amp; &#39;条&#39;",
    );
    expect(result).not.toContain('<b>"第一"</b>');
    expect(result).toContain('data-title="秋山札"');
  });

  it("keeps every approved Detail section in canonical T02 order", async () => {
    const source = await (
      await serveT02File({ kind: "prototype", segments: ["index.html"] }, "GET")
    ).text();
    const labels = [
      "基本资料",
      "简介",
      "释文",
      "历史背景",
      "学术研究",
      "说明",
      "资料来源",
    ];
    const positions = labels.map((label) =>
      source.indexOf(`<h2>${label}</h2>`),
    );

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(
      [...positions].sort((left, right) => left - right),
    );
    expect(source.match(/data-detail-transcription(?:\s|>)/g)).toHaveLength(1);
  });

  it("serves the formal root with canonical QA records, runtime records, and one base", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const response = await readT02Document(
      "GET",
      {
        discover: [runtimeItem("真实发现", "inscription")],
        inscriptions: [runtimeItem("真实碑刻", "inscription")],
        calligraphy: [runtimeItem("真实书帖", "calligraphy")],
      },
      "formal-root",
    );
    const body = await bodyText(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(
      body.match(/<base href="\/docs\/prototypes\/mobile-preview\/" \/>/g),
    ).toHaveLength(1);
    expect(body).toContain("真实发现");
    expect(body).toContain("真实碑刻");
    expect(body).toContain("真实书帖");
    expect(body).toContain('data-title="山门北壁题记"');
    expect(body).toContain('data-title="云峰山题名"');
    expect(body).toContain('data-title="秋山札"');
    expect(body).toContain('<script src="./device-platform.js"></script>');
    expect(body).toContain('data-view="home"');
    expect(body).toContain("./fixtures/home-feed.placeholder.js");
    expect(body).toContain("./fixtures/topics.placeholder.js");
    expect(body).toContain("./fixtures/catalog-detail.placeholder.js");
    expect(body).toContain("./fixtures/p5-pilot.snapshot.js");
    expect(body).toContain('data-formal-root="true"');
    expect(body).toContain('data-runtime-environment="development"');
    expect(body).toContain("<h2>释文</h2>");
    expect(body).toContain("<h2>历史背景</h2>");
    expect(body).toContain("<h2>学术研究</h2>");
    expect(body).not.toContain("data-runtime-catalog-bridge");
  });

  it("serves only truthful runtime records from the formal Production root", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const missingMedia: BrowseItem = {
      id: "runtime-no-media",
      kind: "inscription",
      title: "真实无图碑刻",
      aliases: [],
      summary: "真实无图碑刻摘要",
      periodLabel: "唐",
    };
    const response = await readT02Document(
      "GET",
      {
        calligraphy: [runtimeItem("真实书帖", "calligraphy")],
        discover: [runtimeItem("真实发现", "inscription")],
        inscriptions: [missingMedia],
      },
      "formal-root",
    );
    const body = await bodyText(response);
    const contentIds = [...body.matchAll(/data-content-id="([^"]+)"/g)].map(
      ([, id]) => id,
    );
    const missingMediaCard = body.match(
      /<button\b[^>]*data-content-id="runtime-no-media"[^>]*>[\s\S]*?<\/button>/,
    )?.[0];

    expect(response.status).toBe(200);
    expect(contentIds).toEqual([
      "runtime-真实发现",
      "runtime-no-media",
      "runtime-真实书帖",
    ]);
    expect(body).toContain('data-record-origin="runtime"');
    expect(body).toContain('data-content-id="runtime-no-media"');
    expect(body).toContain('data-title="真实无图碑刻"');
    expect(missingMediaCard).toBeDefined();
    expect(missingMediaCard).not.toContain("<img");
    expect(missingMediaCard).not.toContain("data-image");
    expect(missingMediaCard).not.toContain("app-card__media-fallback");
    expect(missingMediaCard).not.toContain("is-media-missing");
    expect(missingMediaCard).not.toContain("data-media-origin");
    expect(body).not.toContain("../../design-system/assets/demo/");

    for (const qaIdentity of [
      "云峰山题名",
      "石门东侧残刻",
      "秋山札",
      "松窗帖",
      "discover-cliff-gate",
      "inscription-yunfeng",
      "inscription-shimen",
      "calligraphy-autumn",
      "calligraphy-pine",
    ]) {
      expect(body).not.toContain(qaIdentity);
    }

    for (const fixtureScript of [
      "home-feed.placeholder.js",
      "topics.placeholder.js",
      "catalog-detail.placeholder.js",
      "p5-pilot.snapshot.js",
    ]) {
      expect(body).not.toContain(fixtureScript);
    }

    expect(body).not.toContain("内容待接入");
    expect(body).toContain("data-detail-transcription");
    expect(body).toContain("data-detail-historical-context");
    expect(body).toContain("data-detail-scholarly-research");
    expect(body).toContain('data-runtime-environment="production"');
    expect(body).toContain('data-view="home"');
    expect(body).toContain('data-view="detail"');
    expect(body).toContain('data-feed-grid="discover"');
    expect(body).toContain('data-feed-grid="nearby"');
    expect(body).toContain('data-scroll-view="inscriptions"');
    expect(body).toContain("app-calligraphy-grid");
    expect(body).toContain("data-search-empty");
    expect(body).toContain("data-calligraphy-filter-empty");
    expect(body).toContain("./catalog-ui-adapter.js?v=20260823-catalog-detail");
    expect(body).toContain("./preview.js?v=20260823-catalog-detail");
  });

  it("never restores QA records when the formal Production root has no runtime data", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const body = await bodyText(
      await readT02Document("GET", {}, "formal-root"),
    );

    expect([...body.matchAll(/data-content-id=/g)]).toHaveLength(0);
    expect(body).not.toContain("../../design-system/assets/demo/");
    expect(body).not.toContain("catalog-detail.placeholder.js");
    expect(body).toContain('data-view="home"');
    expect(body).toContain("data-search-empty");
  });

  it("keeps the canonical prototype source intact in Production", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const source = await bodyText(
      await serveT02File(
        { kind: "prototype", segments: ["index.html"] },
        "GET",
      ),
    );
    const directPrototype = await bodyText(await readT02Document("GET"));

    for (const document of [source, directPrototype]) {
      expect(document).toContain('data-content-id="discover-cliff-gate"');
      expect(document).toContain('data-content-id="inscription-yunfeng"');
      expect(document).toContain('data-content-id="calligraphy-autumn"');
      expect(document).toContain("../../design-system/assets/demo/");
      expect(document).toContain("./fixtures/home-feed.placeholder.js");
      expect(document).toContain("./fixtures/topics.placeholder.js");
      expect(document).toContain("./fixtures/catalog-detail.placeholder.js");
      expect(document).toContain("./fixtures/p5-pilot.snapshot.js");
    }
  });

  it("removes prototype records only inside explicit Production data boundaries", async () => {
    const source = await bodyText(
      await serveT02File(
        { kind: "prototype", segments: ["index.html"] },
        "GET",
      ),
    );
    const result = sanitizeProductionT02Document(source);

    expect(result).not.toContain("data-content-id=");
    expect(result).not.toContain("./fixtures/catalog-detail.placeholder.js");
    expect(result).toContain('data-feed-grid="discover"');
    expect(result).toContain('data-feed-grid="nearby"');
    expect(result).toContain("data-search-empty");
    expect(result).toContain("data-calligraphy-filter-empty");
    expect(result).toContain('data-view="detail"');
    expect(result).toContain(
      "./catalog-ui-adapter.js?v=20260823-catalog-detail",
    );
    expect(result).toContain("./preview.js?v=20260823-catalog-detail");
  });

  it("supports bodyless HEAD responses", async () => {
    const response = await readT02Document("HEAD");

    expect(response.status).toBe(200);
    expect(await bodyText(response)).toBe("");
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
  });

  it.each([
    [
      "preview.js",
      { kind: "prototype", segments: ["preview.js"] },
      "text/javascript; charset=utf-8",
    ],
    [
      "preview.css",
      { kind: "prototype", segments: ["preview.css"] },
      "text/css; charset=utf-8",
    ],
    [
      "demo image",
      { kind: "demo-assets", segments: ["demo", "cliff-gate.svg"] },
      "image/svg+xml",
    ],
    [
      "settings icon",
      { kind: "ui-assets", segments: ["icons", "settings.svg"] },
      "image/svg+xml",
    ],
    [
      "navigation label",
      { kind: "ui-assets", segments: ["labels", "nav-home.png"] },
      "image/png",
    ],
    [
      "paper texture",
      { kind: "ui-assets", segments: ["textures", "paper-visible.svg"] },
      "image/svg+xml",
    ],
  ] as const)(
    "serves the allowlisted %s",
    async (_name, access, contentType) => {
      const response = await serveT02File(access, "GET");

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    },
  );

  it.each([
    ["parent traversal", ["..", "package.json"]],
    ["encoded traversal", ["%2e%2e", "package.json"]],
    ["absolute path", ["/etc/passwd"]],
    ["directory request", ["fixtures"]],
    ["unallowlisted package file", ["package.json"]],
  ] as const)(
    "rejects %s without leaking filesystem details",
    async (_name, segments) => {
      const response = await serveT02File(
        { kind: "prototype", segments },
        "GET",
      );
      const body = await response.text();

      expect(response.status).toBe(404);
      expect(body).toBe("");
      expect(body).not.toContain("/private/");
    },
  );
});
