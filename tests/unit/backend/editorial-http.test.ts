import {
  createBackendApplication,
  createBackendServer,
  startServer,
  stopServer,
} from "@moya/backend-runtime";
import {
  apiErrorSchema,
  articleCollectionDetailSchema,
  articleCollectionPageSchema,
  articleDetailSchema,
  articlePageSchema,
} from "@moya/contracts/schemas";
import { MappedStorageUrlResolver } from "@moya/image";
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryCommunityIdentityPort } from "./community-identity-fixture.js";

import type {
  ArticleCollectionDetailRecord,
  ArticleDetailRecord,
  AuthorCommunityPort,
  EditorialContentReadPort,
} from "@moya/api";
import type { NodeEnvironment } from "@moya/backend-runtime";
import type { ArticleId, MediaId } from "@moya/contracts";
import type { Server } from "node:http";

const servers = new Set<Server>();
const articleId = `article-${"a".repeat(32)}` as ArticleId;
const collectionId = `collection-${"b".repeat(32)}`;
const mediaId = "media-synthetic-cover" as MediaId;
const cover = {
  id: mediaId,
  objectKey: "editorial/synthetic/cover.jpg",
  alt: "封面",
  width: 1200,
  height: 800,
};
const article: ArticleDetailRecord = {
  id: articleId,
  presentation: "academic",
  title: "石与纸之间",
  subtitle: "碑刻图像的观看与传递",
  summary: "摘要",
  section: "金石学",
  issue: "专题一",
  byline: "由艺编辑室",
  cover,
  firstPublishedAt: "2026-09-20T10:00:00.000Z",
  publishedAt: "2026-09-21T10:00:00.000Z",
  updatedAt: "2026-09-21T10:00:00.000Z",
  intro: "导语",
  sections: [
    {
      heading: "问题的起点",
      body: "第一段。\n\n第二段。\n \n第三段。",
      image: cover,
      imageCaption: "图 1",
    },
  ],
  citations: [{ text: "由艺编辑室：《石与纸之间》", url: null }],
};
const collection: ArticleCollectionDetailRecord = {
  id: collectionId as ArticleCollectionDetailRecord["id"],
  title: "重返碑刻现场",
  subtitle: null,
  summary: "简介",
  category: "田野方法",
  issue: "专题三",
  cover: null,
  memberTotal: 1,
  firstPublishedAt: "2026-09-20T10:00:00.000Z",
  publishedAt: "2026-09-21T10:00:00.000Z",
  updatedAt: "2026-09-21T10:00:00.000Z",
  members: [{ kind: "article", position: 0, article }],
};

class FixtureEditorialPort implements EditorialContentReadPort {
  readonly calls: string[] = [];
  async listArticles(query: { page: number; pageSize: number }) {
    this.calls.push(`list:${query.page}:${query.pageSize}`);
    return {
      items: [article],
      total: 1,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
  async findArticle(id: ArticleId) {
    return id === articleId ? article : null;
  }
  async isArticlePublished(id: string) {
    return id === articleId;
  }
  async listCollections(query: { page: number; pageSize: number }) {
    return {
      items: [collection],
      total: 1,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
  async findCollection(id: string) {
    return id === collectionId ? collection : null;
  }
}

const start = async (
  nodeEnv: NodeEnvironment,
  port?: EditorialContentReadPort,
) => {
  const server = createBackendServer(
    createBackendApplication({
      nodeEnv,
      communityIdentityPort: new InMemoryCommunityIdentityPort(),
      // The editorial reads never touch the author port; the branch only needs it composed.
      authorCommunityPort: {} as unknown as AuthorCommunityPort,
      storageUrlResolver: new MappedStorageUrlResolver(
        new Map([[cover.objectKey, "http://media.invalid/cover.jpg"]]),
      ),
      ...(port ? { editorialContentPort: port } : {}),
    }),
  );
  servers.add(server);
  const address = await startServer(server, { host: "127.0.0.1", port: 0 });
  return `http://${address.address}:${address.port}/v1/community/editorial`;
};

afterEach(async () => {
  await Promise.all(
    [...servers].map(async (server) => {
      await stopServer(server);
      servers.delete(server);
    }),
  );
});

describe("published editorial content HTTP reads (content-community-completion-v1)", () => {
  it("lists and reads Articles with resolved media and split paragraphs", async () => {
    const base = await start("development", new FixtureEditorialPort());
    const list = await fetch(
      `${base}/articles?pageSize=5&presentation=academic`,
    );
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("private, no-store");
    const page = articlePageSchema.parse(await list.json());
    expect(page.items[0]?.cover?.src).toBe("http://media.invalid/cover.jpg");
    expect(page.totalPages).toBe(1);
    const detail = await fetch(`${base}/articles/${articleId}`);
    expect(detail.status).toBe(200);
    const body = articleDetailSchema.parse(await detail.json());
    expect(body.sections[0]?.paragraphs).toEqual([
      "第一段。",
      "第二段。",
      "第三段。",
    ]);
    expect(body.sections[0]?.image?.src).toBe("http://media.invalid/cover.jpg");
    expect(JSON.stringify(body)).not.toContain("objectKey");
  });

  it("answers 404 for an unknown, malformed or withdrawn identity and 400 for a bad query", async () => {
    const base = await start("development", new FixtureEditorialPort());
    const missing = await fetch(`${base}/articles/article-${"f".repeat(32)}`);
    expect(missing.status).toBe(404);
    expect(apiErrorSchema.parse(await missing.json()).error.code).toBe(
      "ITEM_NOT_FOUND",
    );
    const malformed = await fetch(`${base}/articles/12`);
    expect(malformed.status).toBe(404);
    const badQuery = await fetch(`${base}/articles?presentation=video`);
    expect(badQuery.status).toBe(400);
    expect(apiErrorSchema.parse(await badQuery.json()).error.code).toBe(
      "INVALID_QUERY",
    );
    const post = await fetch(`${base}/articles`, { method: "POST" });
    expect(post.status).toBe(405);
  });

  it("lists and reads Collections with typed eligible members", async () => {
    const base = await start("development", new FixtureEditorialPort());
    const list = articleCollectionPageSchema.parse(
      await (await fetch(`${base}/collections`)).json(),
    );
    expect(list.items[0]?.memberTotal).toBe(1);
    const detail = articleCollectionDetailSchema.parse(
      await (await fetch(`${base}/collections/${collectionId}`)).json(),
    );
    expect(detail.members[0]?.kind).toBe("article");
    if (detail.members[0]?.kind === "article")
      expect(detail.members[0].article.id).toBe(articleId);
  });

  it("is absent without a composed editorial port and outside Development", async () => {
    const withoutPort = await start("development");
    expect((await fetch(`${withoutPort}/articles`)).status).toBe(404);
    const production = createBackendServer(
      createBackendApplication({
        nodeEnv: "production",
        communityIdentityPort: new InMemoryCommunityIdentityPort(),
        authorCommunityPort: {} as unknown as AuthorCommunityPort,
        editorialContentPort: new FixtureEditorialPort(),
        catalogQueryPort: {
          list: async () => ({
            items: [],
            total: 0,
            page: 1,
            pageSize: 1,
            totalPages: 0,
          }),
          getById: async () => null,
        },
        storageUrlResolver: new MappedStorageUrlResolver(new Map()),
      }),
    );
    servers.add(production);
    const address = await startServer(production, {
      host: "127.0.0.1",
      port: 0,
    });
    const response = await fetch(
      `http://${address.address}:${address.port}/v1/community/editorial/articles`,
    );
    expect(response.status).toBe(404);
  });
});
