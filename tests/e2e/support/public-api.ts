import { createServer } from "node:http";

import sharp from "sharp";

import type {
  ArticlePage,
  ContentCard,
  CatalogDetail,
  CatalogId,
  CatalogPage,
  CatalogSummary,
  MediaId,
  MediaRendition,
  PublicMedia,
  ThreadPage,
} from "@moya/contracts";
import type { ServerResponse } from "node:http";

const host = "127.0.0.1";
const port = Number(process.env.MOYA_E2E_PUBLIC_API_PORT ?? "3101");
const baseUrl = `http://${host}:${port}`;

const catalogId = (value: string) => value as CatalogId;
const mediaId = (value: string) => value as MediaId;

const publicMedia = (
  id: string,
  fileName: string,
  alt: string,
  width: number,
  height: number,
): PublicMedia => ({
  alt,
  height,
  id: mediaId(id),
  kind: "image",
  src: `${baseUrl}/media/${fileName}`,
  width,
});

/*
 * unified-media-pipeline-v1: two images carry real rendition candidates, each
 * a solid-colour WebP generated at its declared size (truthful MIME). In the
 * detail list the 1600 × 900 candidate is the anchor (`src`) and 3200 × 1800
 * a Viewer zoom level. Every other fixture stays on the legacy path without
 * candidates.
 */
const renditionFiles = new Map<
  string,
  { color: string; height: number; width: number }
>();
const renditions = (
  name: string,
  color: string,
  sizes: readonly (readonly [width: number, height: number])[],
): MediaRendition[] =>
  sizes.map(([width, height]) => {
    const path = `/media/renditions/${name}-${width}x${height}.webp`;
    renditionFiles.set(path, { color, height, width });
    return {
      src: `${baseUrl}${path}`,
      width,
      height,
      contentType: "image/webp",
    };
  });

const inscriptionFront = publicMedia(
  "runtime-inscription-front",
  "inscription-front.svg",
  "运行时多图碑刻正面",
  1200,
  1600,
);
const inscriptionDetailRenditions = renditions(
  "inscription-detail",
  "#8b735f",
  [
    [480, 270],
    [1080, 608],
    [1600, 900],
    [3200, 1800],
  ],
);
const inscriptionDetail: PublicMedia = {
  ...publicMedia(
    "runtime-inscription-detail",
    "inscription-detail.svg",
    "运行时多图碑刻局部",
    1600,
    900,
  ),
  src: inscriptionDetailRenditions[2]!.src,
  renditions: inscriptionDetailRenditions,
  placeholderColor: "#8b735f",
};
/** The Discover card of the multi-media record: card candidates of its front. */
const multiMediaCardRenditions = renditions(
  "inscription-front-card",
  "#655044",
  [
    [360, 480],
    [810, 1080],
    [1200, 1600],
  ],
);
const calligraphyLeaf = publicMedia(
  "runtime-calligraphy-leaf",
  "calligraphy-leaf.svg",
  "运行时书帖册页",
  1400,
  1000,
);
const pagingInscriptionFront = publicMedia(
  "runtime-paging-inscription-22-front",
  "inscription-front.svg",
  "分页碑刻二十二正面",
  1200,
  1600,
);
const pagingInscriptionDetail = publicMedia(
  "runtime-paging-inscription-22-detail",
  "inscription-detail.svg",
  "分页碑刻二十二局部",
  1600,
  900,
);
const pagingCalligraphyFront = publicMedia(
  "runtime-paging-calligraphy-24-front",
  "calligraphy-leaf.svg",
  "分页书帖二十四正面",
  1400,
  1000,
);
const pagingCalligraphyDetail = publicMedia(
  "runtime-paging-calligraphy-24-detail",
  "inscription-detail.svg",
  "分页书帖二十四局部",
  1600,
  900,
);

const baseSummaries: readonly CatalogSummary[] = [
  {
    aliases: ["无图运行记录"],
    id: catalogId("runtime-inscription-no-media"),
    kind: "inscription",
    periodLabel: "唐",
    summary: "用于验证真实无图记录不会获得演示图像。",
    title: "运行时无图碑刻",
  },
  {
    aliases: ["多图运行记录"],
    id: catalogId("runtime-inscription-multi-media"),
    kind: "inscription",
    periodLabel: "北魏",
    representativeMedia: inscriptionFront,
    summary: "用于验证多媒体与响应式连续性。",
    title: "运行时多图碑刻",
  },
  {
    aliases: [],
    id: catalogId("runtime-identity-mismatch"),
    kind: "inscription",
    summary: "用于验证错误身份不会替代所选资源。",
    title: "运行时身份校验条目",
  },
  {
    aliases: ["运行时册页"],
    id: catalogId("runtime-calligraphy"),
    kind: "calligraphy",
    periodLabel: "宋",
    representativeMedia: calligraphyLeaf,
    summary: "用于验证书帖运行时身份。",
    title: "运行时书帖",
  },
];

const pagingSummary = (
  kind: "calligraphy" | "inscription",
  number: number,
): CatalogSummary => {
  const sequence = String(number).padStart(2, "0");
  const id = `runtime-paging-${kind}-${sequence}`;
  const representativeMedia =
    number % 3 === 0
      ? undefined
      : publicMedia(
          `${id}-representative`,
          kind === "inscription"
            ? "inscription-front.svg"
            : "calligraphy-leaf.svg",
          `${kind === "inscription" ? "分页碑刻" : "分页书帖"}${number}代表图`,
          kind === "inscription" ? 1200 : 1400,
          kind === "inscription" ? 1600 : 1000,
        );
  return {
    aliases: [],
    id: catalogId(id),
    kind,
    periodLabel: number % 2 === 0 ? "唐" : "宋",
    ...(representativeMedia === undefined ? {} : { representativeMedia }),
    summary: `用于验证${kind === "inscription" ? "碑刻" : "书帖"}渐进加载第 ${number} 条记录。`,
    title: `${kind === "inscription" ? "分页碑刻" : "分页书帖"} ${number}`,
  };
};

const pagingSummaries: readonly CatalogSummary[] = [
  ...baseSummaries,
  ...Array.from({ length: 52 }, (_, index) =>
    pagingSummary("inscription", index + 1),
  ),
  ...Array.from({ length: 54 }, (_, index) =>
    pagingSummary("calligraphy", index + 1),
  ),
];

const details = new Map<string, CatalogDetail>([
  [
    "runtime-inscription-no-media",
    {
      aliases: ["无图运行记录"],
      description: "此记录有真实文字资料，但没有任何公开媒体。",
      dynasty: "唐",
      id: catalogId("runtime-inscription-no-media"),
      kind: "inscription",
      media: [],
      periodLabel: "唐",
      sourceCitations: [{ label: "测试公开资料" }],
      summary: "用于验证真实无图记录不会获得演示图像。",
      title: "运行时无图碑刻",
    },
  ],
  [
    "runtime-inscription-multi-media",
    {
      aliases: ["多图运行记录"],
      contributors: [
        { name: "运行时撰文者", role: "textAuthor" },
        { name: "运行时书者", role: "calligrapher" },
      ],
      currentLocation: "测试陈列区",
      dateText: "太和年间",
      description:
        "此记录提供两张公开图像，并用于验证详情独立纵向滚动与历史恢复。".repeat(
          24,
        ),
      dynasty: "北魏",
      historicalContext: "运行时历史背景内容。",
      id: catalogId("runtime-inscription-multi-media"),
      kind: "inscription",
      media: [inscriptionFront, inscriptionDetail],
      periodLabel: "北魏",
      representativeMedia: inscriptionFront,
      scholarlyResearch: "运行时学术研究内容。",
      scriptStyle: "碑额篆书，正文楷书",
      sourceCitations: [
        { label: "测试公开资料" },
        {
          appliesTo: ["transcription", "historicalContext"],
          citation: "运行时多范围公开引文",
          label: "测试分区资料",
        },
      ],
      summary: "用于验证多媒体与响应式连续性。",
      title: "运行时多图碑刻",
      transcription: "运行时释文第一行\n运行时释文第二行",
    },
  ],
  [
    "runtime-calligraphy",
    {
      aliases: ["运行时册页"],
      description: "此记录验证书帖使用真实运行时身份。",
      dynasty: "宋",
      id: catalogId("runtime-calligraphy"),
      kind: "calligraphy",
      media: [calligraphyLeaf],
      periodLabel: "宋",
      representativeMedia: calligraphyLeaf,
      sourceCitations: [{ label: "测试公开资料" }],
      summary: "用于验证书帖运行时身份。",
      title: "运行时书帖",
    },
  ],
  [
    "runtime-paging-inscription-22",
    {
      aliases: [],
      description:
        "此记录用于验证第二页碑刻进入详情、查看多媒体并准确返回列表位置。".repeat(
          12,
        ),
      dynasty: "唐",
      id: catalogId("runtime-paging-inscription-22"),
      kind: "inscription",
      media: [pagingInscriptionFront, pagingInscriptionDetail],
      periodLabel: "唐",
      representativeMedia: pagingInscriptionFront,
      sourceCitations: [{ label: "测试公开资料" }],
      summary: "用于验证碑刻分页往返。",
      title: "分页碑刻 22",
    },
  ],
  [
    "runtime-paging-calligraphy-24",
    {
      aliases: [],
      description:
        "此记录用于验证第二页书帖进入详情、查看多媒体并准确返回全部分类位置。".repeat(
          12,
        ),
      dynasty: "唐",
      id: catalogId("runtime-paging-calligraphy-24"),
      kind: "calligraphy",
      media: [pagingCalligraphyFront, pagingCalligraphyDetail],
      periodLabel: "唐",
      representativeMedia: pagingCalligraphyFront,
      sourceCitations: [{ label: "测试公开资料" }],
      summary: "用于验证书帖分页往返。",
      title: "分页书帖 24",
    },
  ],
]);

const mismatchedDetail: CatalogDetail = {
  aliases: [],
  id: catalogId("wrong-runtime-resource"),
  kind: "inscription",
  media: [],
  sourceCitations: [],
  title: "错误替代资源",
};

const mediaAssets = new Map([
  ["/media/inscription-front.svg", "#655044"],
  ["/media/inscription-detail.svg", "#8b735f"],
  ["/media/calligraphy-leaf.svg", "#5f6f58"],
]);

// Rendered once before the fixture listens, so its health check also means
// every candidate file exists.
const renditionAssets = new Map(
  await Promise.all(
    [...renditionFiles].map(
      async ([path, { color, height, width }]) =>
        [
          path,
          await sharp({
            create: { background: color, channels: 3, height, width },
          })
            .webp()
            .toBuffer(),
        ] as const,
    ),
  ),
);

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};

const sendSvg = (response: ServerResponse, color: string) => {
  response.writeHead(200, { "Content-Type": "image/svg+xml" });
  response.end(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120"><rect width="160" height="120" fill="${color}"/></svg>`,
  );
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", baseUrl);

  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" });
    response.end();
    return;
  }

  if (url.pathname === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (url.pathname === "/v1/catalog" || url.pathname === "/paging/v1/catalog") {
    const summaries = url.pathname.startsWith("/paging/")
      ? pagingSummaries
      : baseSummaries;
    const kind = url.searchParams.get("kind");
    const items = summaries.filter(
      (item) => kind === null || item.kind === kind,
    );
    const pageNumber = Number(url.searchParams.get("page") ?? "1");
    const pageSize = Number(url.searchParams.get("pageSize") ?? "20");
    const offset = (pageNumber - 1) * pageSize;
    const page: CatalogPage = {
      items: items.slice(offset, offset + pageSize),
      page: pageNumber,
      pageSize,
      total: items.length,
      totalPages: items.length === 0 ? 0 : Math.ceil(items.length / pageSize),
    };
    sendJson(response, 200, page);
    return;
  }

  // Phase 4 product fixture: preserve these same Catalog identities while
  // answering the Development composition's bounded discovery/card reads.
  // Authentication and mutations remain outside this anonymous fixture.
  const communityPath = url.pathname.replace(/^\/paging\//, "/");
  // Anonymous mounted Discussion panels have valid empty lists in this fixture.
  // Keep authentication and mutations outside this synthetic read-only service.
  if (communityPath === "/v1/community/editorial/articles") {
    sendJson(response, 200, {
      items: [],
      total: 0,
      page: 1,
      pageSize: 12,
      totalPages: 0,
    } satisfies ArticlePage);
    return;
  }
  if (communityPath === "/v1/community/threads") {
    sendJson(response, 200, {
      items: [],
      total: 0,
      page: 1,
      pageSize: 22,
      totalPages: 0,
      anchor: "2026-10-05T00:00:00.000Z",
    } satisfies ThreadPage);
    return;
  }
  const summaries = url.pathname.startsWith("/paging/")
    ? pagingSummaries
    : baseSummaries;
  const card = (item: CatalogSummary): ContentCard => ({
    aliases: [...item.aliases],
    target: { type: "catalog", id: item.id },
    title: item.title,
    kind: item.kind,
    authorId: null,
    firstPublishedAt: null,
    media: !item.representativeMedia
      ? null
      : item.id === "runtime-inscription-multi-media"
        ? {
            id: item.representativeMedia.id,
            src: multiMediaCardRenditions[2]!.src,
            width: 1200,
            height: 1600,
            renditions: multiMediaCardRenditions,
            placeholderColor: "#655044",
          }
        : {
            id: item.representativeMedia.id,
            src: item.representativeMedia.src,
            width: item.representativeMedia.width,
            height: item.representativeMedia.height,
          },
  });
  if (communityPath === "/v1/community/discover") {
    const kind = url.searchParams.get("kind") ?? "all";
    const items = summaries.filter(
      (item) => kind === "all" || item.kind === kind,
    );
    const after = Number(url.searchParams.get("after") ?? "0");
    const size = Math.min(50, Number(url.searchParams.get("pageSize") ?? "12"));
    sendJson(response, 200, {
      items: items.slice(after, after + size).map(card),
      sequence: "f0de661e-3527-4c37-8d46-af96c5e5cf74",
      nextAfter: Math.min(items.length, after + size),
      hasMore: after + size < items.length,
    });
    return;
  }
  if (communityPath === "/v1/community/filter-options") {
    sendJson(
      response,
      200,
      Object.fromEntries(
        [
          "dynasty",
          "textAuthor",
          "calligrapher",
          "originalRegion",
          "script",
        ].map((key) => [
          key,
          {
            values: [],
            unknown: 0,
            unsupplied: summaries.filter((item) => item.kind === "inscription")
              .length,
          },
        ]),
      ),
    );
    return;
  }
  const communityCard = communityPath.match(
    /^\/v1\/community\/content\/catalog\/([^/]+)\/card$/,
  );
  if (communityCard) {
    const item = summaries.find(
      (candidate) =>
        candidate.id === decodeURIComponent(communityCard[1] ?? ""),
    );
    if (item) sendJson(response, 200, card(item));
    else {
      response.writeHead(404);
      response.end();
    }
    return;
  }
  const discussion = communityPath.match(
    /^\/v1\/community\/discussion\/catalog\/([^/]+)$/,
  );
  if (discussion) {
    const item = summaries.find(
      (candidate) => candidate.id === decodeURIComponent(discussion[1] ?? ""),
    );
    if (item)
      sendJson(response, 200, {
        hot: [],
        items: [],
        visibleTotal: 0,
        total: 0,
        page: Number(url.searchParams.get("page") ?? "1"),
        pageSize: Number(url.searchParams.get("pageSize") ?? "10"),
        totalPages: 0,
      });
    else {
      response.writeHead(404);
      response.end();
    }
    return;
  }

  // Community V1 (Mission 2C): the Formal root composes the live comment
  // section in the Development runtime, so the fixture answers the anonymous
  // reads with an empty listing for every known record. Writes and the
  // session probe stay outside the fixture: no cookie is ever issued here, so
  // the Web relay answers /api/community/me with 401 on its own.
  const commentListingMatch = url.pathname.match(
    /^\/(?:paging\/)?v1\/catalog\/([^/]+)\/comments$/,
  );
  if (commentListingMatch) {
    const requestedId = decodeURIComponent(commentListingMatch[1] ?? "");
    if (!details.has(requestedId)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const pageSize = Number(url.searchParams.get("pageSize") ?? "10");
    sendJson(response, 200, {
      hot: [],
      items: [],
      page: Number(url.searchParams.get("page") ?? "1"),
      pageSize,
      total: 0,
      totalPages: 0,
    });
    return;
  }

  const catalogDetailMatch = url.pathname.match(
    /^\/(?:paging\/)?v1\/catalog\/([^/]+)$/,
  );
  if (catalogDetailMatch) {
    const requestedId = decodeURIComponent(catalogDetailMatch[1] ?? "");
    if (requestedId === "runtime-identity-mismatch") {
      sendJson(response, 200, mismatchedDetail);
      return;
    }
    const detail = details.get(requestedId);
    if (detail) {
      sendJson(response, 200, detail);
      return;
    }
    response.writeHead(404);
    response.end();
    return;
  }

  const color = mediaAssets.get(url.pathname);
  if (color) {
    sendSvg(response, color);
    return;
  }

  const rendition = renditionAssets.get(url.pathname);
  if (rendition) {
    response.writeHead(200, {
      "Content-Length": rendition.byteLength,
      "Content-Type": "image/webp",
    });
    response.end(rendition);
    return;
  }

  response.writeHead(404);
  response.end();
});

server.listen(port, host);
