import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalReq, getPayload, type TypedUser } from "payload";
import {
  closePostgresPool,
  createPostgresPool,
  parsePostgresConfig,
  PostgresEditorialContentAdapter,
} from "@moya/catalog-postgres";

import config from "admin/config";
import {
  approveArticleBatch,
  publishApprovedArticle,
  saveArticleDraft,
} from "admin/editorial-content";

if (
  process.env.CMS_ENVIRONMENT !== "synthetic" ||
  !process.env.CMS_DATABASE_URL
) {
  throw new Error("An isolated synthetic CMS database is required");
}

const run = randomUUID();
let payload: Awaited<ReturnType<typeof getPayload>>;
let owner: TypedUser;
let automation: TypedUser;
let pool: ReturnType<typeof createPostgresPool>;
const reqFor = (user: TypedUser | null) =>
  createLocalReq(user ? { user } : {}, payload);
const failureCode = async (operation: Promise<unknown>) => {
  try {
    await operation;
    return null;
  } catch (error) {
    return (error as { data?: { code?: string } }).data?.code ?? "UNKNOWN";
  }
};
const draft = (title: string) => ({
  presentation: "news" as const,
  title,
  summary: `${title} 摘要`,
  section: "田野观察",
  byline: "由艺编辑室",
  sections: [{ body: "第一段。\n\n第二段。" }],
  citations: [],
});

beforeAll(async () => {
  payload = await getPayload({ config });
  owner = await payload.create({
    collection: "users",
    overrideAccess: true,
    data: {
      email: `synthetic-owner-${run}@example.invalid`,
      password: randomUUID(),
      role: "owner",
    },
  });
  automation = await payload.create({
    collection: "users",
    overrideAccess: false,
    req: await reqFor(owner),
    user: owner,
    data: {
      email: `synthetic-automation-${run}@example.invalid`,
      password: randomUUID(),
      role: "automation",
      scopeCatalogIds: [],
    },
  });
  pool = createPostgresPool(
    parsePostgresConfig({ DATABASE_URL: process.env.CMS_DATABASE_URL }),
  );
});

afterAll(async () => {
  if (pool) await closePostgresPool(pool);
  await payload?.db?.destroy?.();
});

describe("editorial Articles workflow (content-community-completion-v1)", () => {
  it("generates the public identity, keeps it immutable and never publishes for automation", async () => {
    // Automation asking to create a published record is refused outright.
    expect(
      await failureCode(
        payload.create({
          collection: "articles",
          overrideAccess: false,
          req: await reqFor(automation),
          user: automation,
          data: {
            ...draft(`自动化发布 ${run}`),
            _status: "published" as const,
          },
        }),
      ),
    ).toBe("PUBLISH_NOT_APPROVED");
    const created = await payload.create({
      collection: "articles",
      overrideAccess: false,
      req: await reqFor(automation),
      user: automation,
      draft: true,
      data: draft(`自动化草稿 ${run}`),
    });
    expect(created.articleId).toMatch(/^article-[0-9a-f]{32}$/u);
    expect(created._status).toBe("draft");
    expect(created.revision).toBe(1);
    // A caller-supplied identity is refused, and an existing one cannot change.
    expect(
      await failureCode(
        payload.create({
          collection: "articles",
          overrideAccess: false,
          req: await reqFor(owner),
          user: owner,
          draft: true,
          data: { ...draft("id"), articleId: `article-${"0".repeat(32)}` },
        }),
      ),
    ).toBe("IDENTITY_SERVER_ONLY");
    expect(
      await failureCode(
        payload.update({
          collection: "articles",
          id: created.id,
          overrideAccess: false,
          req: await reqFor(owner),
          user: owner,
          draft: true,
          data: { revision: 1, articleId: `article-${"0".repeat(32)}` },
        }),
      ),
    ).toBe("IDENTITY_IMMUTABLE");
    // Automation may not publish or overwrite the main record.
    expect(
      await failureCode(
        payload.update({
          collection: "articles",
          id: created.id,
          overrideAccess: false,
          req: await reqFor(automation),
          user: automation,
          data: { revision: 1, _status: "published" },
        }),
      ),
    ).toBe("PUBLISH_NOT_APPROVED");
    expect(
      await failureCode(
        payload.update({
          collection: "articles",
          id: created.id,
          overrideAccess: false,
          req: await reqFor(automation),
          user: automation,
          data: { revision: 1, _status: "draft" },
        }),
      ),
    ).toBe("AUTOMATION_DRAFT_ONLY");
    // Hard deletion is disabled for everyone.
    expect(
      await failureCode(
        payload.delete({
          collection: "articles",
          id: created.id,
          overrideAccess: false,
          req: await reqFor(owner),
          user: owner,
        }),
      ),
    ).toBe("HARD_DELETE_DISABLED");
  });

  it("publishes only for the Owner at the expected revision and exposes exactly the published revision", async () => {
    const created = await payload.create({
      collection: "articles",
      overrideAccess: false,
      req: await reqFor(owner),
      user: owner,
      draft: true,
      data: draft(`发布 ${run}`),
    });
    const adapter = new PostgresEditorialContentAdapter(pool);
    const id = String(created.articleId);
    expect(await adapter.isArticlePublished(id)).toBe(false);
    expect(
      await failureCode(
        payload.update({
          collection: "articles",
          id: created.id,
          overrideAccess: false,
          req: await reqFor(owner),
          user: owner,
          data: { revision: 7, _status: "published" },
        }),
      ),
    ).toBe("REVISION_CONFLICT");
    const published = await payload.update({
      collection: "articles",
      id: created.id,
      overrideAccess: false,
      req: await reqFor(owner),
      user: owner,
      data: { revision: 1, _status: "published" },
    });
    expect(published._status).toBe("published");
    expect(published.revision).toBe(2);
    expect(published.firstPublishedAt).toBeTruthy();
    const detail = await adapter.findArticle(created.articleId as never);
    expect(detail?.title).toBe(`发布 ${run}`);
    expect(detail?.sections[0]?.body).toBe("第一段。\n\n第二段。");
    // A pending replacement draft leaves the published revision readable.
    await payload.update({
      collection: "articles",
      id: created.id,
      overrideAccess: false,
      req: await reqFor(owner),
      user: owner,
      draft: true,
      data: { revision: 2, title: `待发布替换 ${run}` },
    });
    expect((await adapter.findArticle(created.articleId as never))?.title).toBe(
      `发布 ${run}`,
    );
    // Withdrawal (Owner only) removes the public read; the identity survives.
    expect(
      await failureCode(
        payload.update({
          collection: "articles",
          id: created.id,
          overrideAccess: false,
          req: await reqFor(automation),
          user: automation,
          data: { revision: 3, _status: "draft" },
        }),
      ),
    ).toBe("AUTOMATION_DRAFT_ONLY");
    await payload.update({
      collection: "articles",
      id: created.id,
      overrideAccess: false,
      req: await reqFor(owner),
      user: owner,
      data: { revision: 3, _status: "draft" },
    });
    expect(await adapter.isArticlePublished(id)).toBe(false);
    expect(await adapter.findArticle(created.articleId as never)).toBeNull();
    const page = await adapter.listArticles({ page: 1, pageSize: 50 });
    expect(page.items.some((item) => item.id === created.articleId)).toBe(
      false,
    );
  });

  it("filters withdrawn collection members at read time without reordering the rest", async () => {
    const owned = await reqFor(owner);
    const first = await payload.create({
      collection: "articles",
      overrideAccess: false,
      req: owned,
      user: owner,
      data: { ...draft(`成员一 ${run}`), _status: "published" },
    });
    const second = await payload.create({
      collection: "articles",
      overrideAccess: false,
      req: await reqFor(owner),
      user: owner,
      data: { ...draft(`成员二 ${run}`), _status: "published" },
    });
    const third = await payload.create({
      collection: "articles",
      overrideAccess: false,
      req: await reqFor(owner),
      user: owner,
      data: { ...draft(`成员三 ${run}`), _status: "published" },
    });
    // A member naming an unknown Catalog record cannot publish.
    expect(
      await failureCode(
        payload.create({
          collection: "article-collections",
          overrideAccess: false,
          req: await reqFor(owner),
          user: owner,
          data: {
            title: `合集 ${run}`,
            members: [{ kind: "catalog", catalogId: `absent-${run}` }],
            _status: "published",
          },
        }),
      ),
    ).toBe("REFERENCE_NOT_FOUND");
    const collection = await payload.create({
      collection: "article-collections",
      overrideAccess: false,
      req: await reqFor(owner),
      user: owner,
      data: {
        title: `合集 ${run}`,
        category: "田野方法",
        issue: "专题三",
        members: [
          { kind: "article", article: first.id },
          { kind: "article", article: second.id },
          { kind: "article", article: third.id },
        ],
        _status: "published",
      },
    });
    const adapter = new PostgresEditorialContentAdapter(pool);
    const before = await adapter.findCollection(
      collection.collectionId as never,
    );
    expect(
      before?.members.map((m) =>
        m.kind === "article" ? m.article.title : m.kind,
      ),
    ).toEqual([`成员一 ${run}`, `成员二 ${run}`, `成员三 ${run}`]);
    expect(before?.memberTotal).toBe(3);
    await payload.update({
      collection: "articles",
      id: second.id,
      overrideAccess: false,
      req: await reqFor(owner),
      user: owner,
      data: { revision: 1, _status: "draft" },
    });
    const after = await adapter.findCollection(
      collection.collectionId as never,
    );
    expect(
      after?.members.map((m) =>
        m.kind === "article" ? m.article.title : m.kind,
      ),
    ).toEqual([`成员一 ${run}`, `成员三 ${run}`]);
    expect(after?.members.map((m) => m.position)).toEqual([0, 2]);
    expect(after?.memberTotal).toBe(2);
  });

  it("publishes for automation only through an exact-revision Owner approval, with replay-safe receipts", async () => {
    const saved = await saveArticleDraft(await reqFor(automation), {
      idempotencyKey: `save-${run}`,
      content: draft(`审批发布 ${run}`),
    });
    expect(saved.status).toBe("draft");
    expect(saved.revision).toBe(1);
    // Identical retry replays; a different command under the same key conflicts.
    const replayed = await saveArticleDraft(await reqFor(automation), {
      idempotencyKey: `save-${run}`,
      content: draft(`审批发布 ${run}`),
    });
    expect(replayed.replayed).toBe(true);
    expect(
      await failureCode(
        saveArticleDraft(await reqFor(automation), {
          idempotencyKey: `save-${run}`,
          content: draft(`其他内容 ${run}`),
        }),
      ),
    ).toBe("IDEMPOTENCY_CONFLICT");
    // No approval yet: automation cannot publish.
    expect(
      await failureCode(
        publishApprovedArticle(await reqFor(automation), {
          approvalId: 999999,
          id: saved.id,
          idempotencyKey: `publish-none-${run}`,
        }),
      ),
    ).not.toBeNull();
    // Only the Owner approves, binding the exact revision.
    expect(
      await failureCode(
        approveArticleBatch(await reqFor(automation), {
          automationUserId: automation.id,
          items: [{ id: saved.id, revision: 1 }],
        }),
      ),
    ).toBe("APPROVAL_OWNER_ONLY");
    expect(
      await failureCode(
        approveArticleBatch(await reqFor(owner), {
          automationUserId: automation.id,
          items: [{ id: saved.id, revision: 5 }],
        }),
      ),
    ).toBe("REVISION_CONFLICT");
    const approval = await approveArticleBatch(await reqFor(owner), {
      automationUserId: automation.id,
      items: [{ id: saved.id, revision: 1 }],
    });
    // A later edit changes the fingerprint: the approved item fails individually.
    await saveArticleDraft(await reqFor(automation), {
      id: saved.id,
      expectedRevision: 1,
      idempotencyKey: `edit-${run}`,
      content: { ...draft(`审批发布 ${run}`), summary: "修改后的摘要" },
    });
    expect(
      await failureCode(
        publishApprovedArticle(await reqFor(automation), {
          approvalId: approval.approvalId,
          id: saved.id,
          idempotencyKey: `publish-changed-${run}`,
        }),
      ),
    ).toBe("APPROVED_REVISION_CHANGED");
    const second = await approveArticleBatch(await reqFor(owner), {
      automationUserId: automation.id,
      items: [{ id: saved.id, revision: 2 }],
    });
    const published = await publishApprovedArticle(await reqFor(automation), {
      approvalId: second.approvalId,
      id: saved.id,
      idempotencyKey: `publish-${run}`,
    });
    expect(published.status).toBe("published");
    const adapter = new PostgresEditorialContentAdapter(pool);
    expect(await adapter.isArticlePublished(published.articleId)).toBe(true);
    // Lost response: the same command replays the committed result.
    const again = await publishApprovedArticle(await reqFor(automation), {
      approvalId: second.approvalId,
      id: saved.id,
      idempotencyKey: `publish-${run}`,
    });
    expect(again.replayed).toBe(true);
    expect(again.revision).toBe(published.revision);
  });
});
