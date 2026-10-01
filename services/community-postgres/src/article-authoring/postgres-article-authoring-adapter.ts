import { createHash, randomUUID } from "node:crypto";

import {
  CommunityConflictError,
  CommunityInputError,
  CommunityNotFoundError,
} from "@moya/api";
import type {
  ArticleAuthoringActor,
  ArticleAuthoringPage,
  ArticleAuthoringPort,
  ArticlePublicationOperatorPort,
  ArticleCandidateIdentity,
  ArticleCandidateValidation,
  ArticleCreateCommand,
  ArticleDraftListQuery,
  ArticlePublishCommand,
  ArticleReferenceIssue,
  ArticleSaveCommand,
  ArticleWithdrawCommand,
  PublishedAuthoredArticle,
  PublishedAuthoredArticleSummary,
} from "@moya/api";
import {
  articleAuthoringDocumentSchema,
  articleReferences,
  articleCatalogReferences,
  applyArticleBlockEdits,
} from "@moya/contracts/schemas";
import type {
  ArticleOwnMediaListQuery,
  ArticleOwnMediaPage,
  ArticleDraft,
  ArticleDraftSummary,
  ArticleBlockEditsCommand,
  ArticlePreview,
  ArticleMediaReference,
  ArticleId,
  ArticleAuthoringDocument,
  PublicUserId,
} from "@moya/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  articlePendingPageSchema,
  articlePendingCandidateSchema,
  articleModerationResultSchema,
} from "@moya/contracts/internal/community-operator";
import type {
  ArticlePendingListQuery,
  ArticlePendingPage,
  ArticlePendingCandidate,
  ArticlePendingSummary,
  ModerateArticlePendingCommand,
  ArticleModerationResult,
} from "@moya/contracts/internal/community-operator";

import {
  actorTransaction,
  authorCommand,
  readTransaction,
  selectSettings,
  operatorCommand,
  lockActor,
} from "../publishing/db.js";
import { releaseHolderRefs } from "../publishing/media.js";
import { listArticleOwnMedia } from "./media-read.js";

type Operation = "read" | "draft-write" | "publish";
export interface PostgresArticleAuthoringOptions {
  /** Persisted connection/generation/scope admission, under this SAME transaction. */
  readonly assertDelegatedActor?: (
    db: PoolClient,
    actor: Extract<ArticleAuthoringActor, { source: "delegated" }>,
    operation: Operation,
    resourceId: string | null,
    now: Date,
  ) => Promise<void>;
  /** Exact human-granted candidate approval; consume inside this transaction. */
  readonly assertDelegatedPublication?: (
    db: PoolClient,
    candidate: {
      readonly articleId: ArticleId;
      readonly ownerId: PublicUserId;
      readonly version: number;
      readonly fingerprint: string;
    },
    actor: Extract<ArticleAuthoringActor, { source: "delegated" }>,
    requestId: string,
    now: Date,
  ) => Promise<void>;
}

interface DraftSummaryRow extends QueryResultRow {
  id: string;
  owner_id: string;
  version: number;
  title: string;
  cover_ref_id: string | null;
  fingerprint: string;
  status: ArticleDraft["status"];
  published_version: number | null;
  pending_version: number | null;
  updated_at: Date;
}
interface DraftRow extends DraftSummaryRow {
  document: unknown;
}
interface PublishedSummaryRow extends QueryResultRow {
  article_id: string;
  owner_id: string;
  version: number;
  title: string;
  cover_ref_id: string | null;
  fingerprint: string;
  byline: string;
  first_published_at: Date;
  published_at: Date;
  updated_at: Date;
}

interface PublishedRow extends PublishedSummaryRow {
  document: unknown;
}

const columns =
  "id,owner_id,version,title,cover_ref_id,document,fingerprint,status,published_version,pending_version,updated_at";
const summaryColumns =
  "id,owner_id,version,title,cover_ref_id,fingerprint,status,published_version,pending_version,updated_at";
const publishedColumns =
  "r.article_id,r.owner_id,r.version,r.title,r.cover_ref_id,r.document,r.fingerprint,u.display_name AS byline,a.first_published_at,a.published_at,a.published_at AS updated_at";
const publishedFrom = `FROM community.article_documents a
  JOIN community.article_revisions r ON r.article_id=a.id AND r.version=a.published_version
  JOIN community.public_users u ON u.id=a.owner_id AND u.status='active'
  WHERE a.published_version IS NOT NULL AND a.status<>'withdrawn'`;

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
};
export const authoredArticleFingerprint = (
  candidate: Pick<ArticleDraft, "title" | "coverRefId" | "document">,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          title: candidate.title,
          coverRefId: candidate.coverRefId,
          document: candidate.document,
        }),
      ),
    )
    .digest("hex");

const documentOf = (value: unknown): ArticleAuthoringDocument => {
  if (
    value &&
    typeof value === "object" &&
    "version" in value &&
    value.version !== 1
  )
    throw new CommunityInputError("article_document_version_unsupported");
  const result = articleAuthoringDocumentSchema.safeParse(value);
  if (!result.success)
    throw new CommunityInputError("article_document_invalid");
  // The shared schema enforces this too. This defense measures the minified
  // canonical DTO, never PostgreSQL JSONB's whitespace-expanded rendering.
  if (Buffer.byteLength(JSON.stringify(result.data), "utf8") > 1_048_576)
    throw new CommunityInputError("article_document_too_large");
  return result.data;
};
const draftOf = (row: DraftRow): ArticleDraft => ({
  id: row.id as ArticleId,
  ownerId: row.owner_id as PublicUserId,
  version: row.version,
  title: row.title,
  coverRefId: row.cover_ref_id,
  document: documentOf(row.document),
  fingerprint: row.fingerprint,
  status: row.status,
  publicVersion: row.published_version,
  updatedAt: row.updated_at.toISOString(),
});
const summaryOf = (row: DraftSummaryRow): ArticleDraftSummary => ({
  id: row.id as ArticleId,
  ownerId: row.owner_id as PublicUserId,
  version: row.version,
  title: row.title,
  coverRefId: row.cover_ref_id,
  fingerprint: row.fingerprint,
  status: row.status,
  publicVersion: row.published_version,
  updatedAt: row.updated_at.toISOString(),
});
const publishedOf = (row: PublishedRow): PublishedAuthoredArticle => ({
  id: row.article_id as ArticleId,
  ownerId: row.owner_id as PublicUserId,
  version: row.version,
  title: row.title,
  coverRefId: row.cover_ref_id,
  document: documentOf(row.document),
  fingerprint: row.fingerprint,
  byline: row.byline,
  firstPublishedAt: row.first_published_at.toISOString(),
  publishedAt: row.published_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

interface ReferenceSet {
  readonly itemIds: readonly string[];
  readonly catalogIds: readonly string[];
  readonly mediaCatalogIds: readonly string[];
  readonly mediaIds: readonly string[];
}
/** A typed bounded projection, not a second document representation. */
const referencesOf = (
  document: ArticleAuthoringDocument,
  coverRefId: string | null,
): ReferenceSet => {
  const items = new Set<string>(),
    catalogs = new Set<string>(articleCatalogReferences(document));
  const media = new Map<string, { catalogId: string; mediaId: string }>();
  for (const { reference: ref } of articleReferences(document, coverRefId)) {
    if (ref.type === "managed") items.add(ref.itemId);
    else {
      catalogs.add(ref.catalogId);
      media.set(JSON.stringify([ref.catalogId, ref.mediaId]), {
        catalogId: ref.catalogId,
        mediaId: ref.mediaId,
      });
    }
  }
  const pairs = [...media.values()].sort(
    (a, b) =>
      a.catalogId.localeCompare(b.catalogId) ||
      a.mediaId.localeCompare(b.mediaId),
  );
  return {
    itemIds: [...items].sort(),
    catalogIds: [...catalogs].sort(),
    mediaCatalogIds: pairs.map((p) => p.catalogId),
    mediaIds: pairs.map((p) => p.mediaId),
  };
};
const revisionHolder = (id: string, version: number): string =>
  `article-revision-${createHash("sha256").update(`${id}:${version}`).digest("hex").slice(0, 32)}`;

const assertVersion = (
  draft: ArticleDraft,
  expected: number,
  fingerprint?: string,
) => {
  if (
    draft.version !== expected ||
    (fingerprint !== undefined && draft.fingerprint !== fingerprint)
  )
    throw new CommunityConflictError("article_revision_conflict");
};
const cursorOf = (row: Pick<DraftRow, "id" | "updated_at">): string =>
  Buffer.from(
    JSON.stringify([row.updated_at.toISOString(), row.id]),
    "utf8",
  ).toString("base64url");
const decodeCursor = (
  value: string | undefined,
): readonly [string, string] | null => {
  if (value === undefined) return null;
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw Error();
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string" ||
      !/^article-[0-9a-f]{32}$/u.test(parsed[1]) ||
      !Number.isFinite(Date.parse(parsed[0]))
    )
      throw Error();
    return [parsed[0], parsed[1]];
  } catch {
    throw new CommunityInputError("article_cursor_invalid");
  }
};

interface PendingSummaryRow extends QueryResultRow {
  id: string;
  owner_id: string;
  expected_version: number;
  candidate_version: number;
  title: string;
  fingerprint: string;
  cover_ref_id: string | null;
  published_version: number | null;
  submitted_at: Date;
  updated_at: Date;
}
interface PendingRow extends PendingSummaryRow {
  document: unknown;
}
const pendingColumns =
  "a.id,a.owner_id,a.version AS expected_version,r.version AS candidate_version,r.title,r.fingerprint,r.cover_ref_id,a.published_version,r.created_at AS submitted_at,a.updated_at";
const pendingFrom = `FROM community.article_documents a
  JOIN community.article_revisions r ON r.article_id=a.id AND r.version=a.pending_version
  JOIN community.public_users u ON u.id=a.owner_id AND u.status='active'
  WHERE a.status='pending' AND a.pending_version IS NOT NULL AND r.submitted_policy='PRE_MODERATION'`;
const pendingSummaryOf = (row: PendingSummaryRow): ArticlePendingSummary => ({
  articleId: row.id as ArticleId,
  ownerId: row.owner_id as PublicUserId,
  expectedVersion: row.expected_version,
  candidateVersion: row.candidate_version,
  title: row.title,
  fingerprint: row.fingerprint,
  publicVersion: row.published_version,
  submittedAt: row.submitted_at.toISOString(),
});
const pendingCandidateOf = (row: PendingRow): ArticlePendingCandidate =>
  articlePendingCandidateSchema.parse({
    ...pendingSummaryOf(row),
    coverRefId: row.cover_ref_id,
    document: documentOf(row.document),
  });

/**
 * Public-user Article persistence, without any Payload actor/CRUD authority.
 * Every content mutation runs under the existing active actor lock/receipt.
 * Delegated admission happens BEFORE receipt replay. Ref/policy/approval
 * checks and exact-candidate publication share one PostgreSQL transaction.
 */
export class PostgresArticleAuthoringAdapter
  implements ArticleAuthoringPort, ArticlePublicationOperatorPort
{
  constructor(
    private readonly pool: Pool,
    private readonly options: PostgresArticleAuthoringOptions = {},
  ) {}

  private async admit(
    db: PoolClient,
    actor: ArticleAuthoringActor,
    operation: Operation,
    id: string | null,
    now: Date,
  ) {
    if (actor.source === "delegated") {
      if (!this.options.assertDelegatedActor)
        throw new CommunityNotFoundError();
      await this.options.assertDelegatedActor(db, actor, operation, id, now);
    }
  }
  listOwnMedia(
    actor: ArticleAuthoringActor,
    query: ArticleOwnMediaListQuery,
    now: Date,
  ): Promise<ArticleOwnMediaPage> {
    return actorTransaction(this.pool, actor.userId, async (db) => {
      await this.admit(db, actor, "read", null, now);
      return listArticleOwnMedia(db, actor.userId, query);
    });
  }
  private async owned(
    db: PoolClient,
    actor: ArticleAuthoringActor,
    id: ArticleId,
    lock: "share" | "update" = "share",
  ): Promise<ArticleDraft> {
    const row = (
      await db.query<DraftRow>(
        `SELECT ${columns} FROM community.article_documents WHERE id=$1 AND owner_id=$2 FOR ${lock.toUpperCase()}`,
        [id, actor.userId],
      )
    ).rows[0];
    if (!row) throw new CommunityNotFoundError();
    return draftOf(row);
  }
  private mutate<T>(
    actor: ArticleAuthoringActor,
    id: string | null,
    command: { requestId: string },
    operation: Operation,
    action: string,
    now: Date,
    run: (db: PoolClient) => Promise<T>,
    created?: (result: T) => string,
  ): Promise<T> {
    return authorCommand(
      this.pool,
      {
        actorId: actor.userId,
        requestId: command.requestId,
        action,
        subjectId: id ?? "new-article",
        input: command,
        now,
      },
      run,
      {
        beforeReceipt: (db: PoolClient) =>
          this.admit(db, actor, operation, id, now),
        ...(created ? { auditSubject: created } : {}),
      },
    );
  }

  private async referenceIssues(
    db: PoolClient,
    draft: Pick<ArticleDraft, "title" | "coverRefId" | "document" | "ownerId">,
    ready: boolean,
  ): Promise<ArticleReferenceIssue[]> {
    const refs = referencesOf(draft.document, draft.coverRefId),
      issues: ArticleReferenceIssue[] = [];
    if (
      draft.coverRefId !== null &&
      !Object.hasOwn(draft.document.references, draft.coverRefId)
    )
      issues.push({ code: "cover_unavailable", path: ["coverRefId"] });
    const rows = refs.itemIds.length
      ? (
          await db.query<{
            id: string;
            state: string;
            legacy_media_id: string | null;
            kind: string;
            display_ready: boolean;
            motion_ready: boolean;
          }>(
            `SELECT i.id,i.state,i.legacy_media_id,i.kind,
        EXISTS (SELECT 1 FROM community.media_derivatives d JOIN community.media_blobs b ON b.id=d.blob_id AND b.state='committed' WHERE d.item_id=i.id AND d.variant='display' AND d.edit_key='base') AS display_ready,
        EXISTS (SELECT 1 FROM community.media_derivatives d JOIN community.media_blobs b ON b.id=d.blob_id AND b.state='committed' WHERE d.item_id=i.id AND d.variant='motion' AND d.edit_key='base') AS motion_ready
       FROM community.media_items i WHERE i.id=ANY($1::text[]) AND i.owner_id=$2 ORDER BY i.id FOR SHARE OF i`,
            [refs.itemIds, draft.ownerId],
          )
        ).rows
      : [];
    // Existing permanent-media erasure locks the legacy PNG row before it
    // rechecks all refs. Lock the same rows through this candidate transaction
    // and reread their availability after any competing erasure commits.
    const legacyIds = [
      ...new Set(
        rows.flatMap((row) =>
          row.legacy_media_id === null ? [] : [row.legacy_media_id],
        ),
      ),
    ].sort();
    const legacyRows = legacyIds.length
      ? (
          await db.query<{ id: string; available: boolean }>(
            "SELECT id,(deleted_at IS NULL AND octet_length(bytes)>0) AS available FROM community.user_media WHERE id=ANY($1::text[]) AND owner_id=$2 ORDER BY id FOR SHARE",
            [legacyIds, draft.ownerId],
          )
        ).rows
      : [];
    const liveLegacy = new Set(
      legacyRows.filter((row) => row.available).map((row) => row.id),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const { refId, reference: ref } of articleReferences(
      draft.document,
      draft.coverRefId,
    ))
      if (ref.type === "managed") {
        const row = byId.get(ref.itemId);
        if (
          !row ||
          ["cancelled", "purged"].includes(row.state) ||
          (row.legacy_media_id !== null && !liveLegacy.has(row.legacy_media_id))
        )
          issues.push({
            code: "media_unavailable",
            path: ["document", "references", refId],
          });
        else if (
          ready &&
          (row.state !== "ready" ||
            (row.legacy_media_id === null && !row.display_ready) ||
            (row.kind === "live" && !row.motion_ready))
        )
          issues.push({
            code: "media_not_ready",
            path: ["document", "references", refId],
          });
      }
    const catalogs = await db.query<{ allowed: boolean }>(
      "SELECT community.article_catalog_references_published($1::text[],$2::text[],$3::text[]) AS allowed",
      [refs.catalogIds, refs.mediaCatalogIds, refs.mediaIds],
    );
    if (catalogs.rows[0]?.allowed !== true)
      issues.push({
        code: "catalog_unavailable",
        path: ["document", "references"],
      });
    return issues;
  }
  private async attachDraftRefs(
    db: PoolClient,
    draft: ArticleDraft,
    now: Date,
  ) {
    const ids = referencesOf(draft.document, draft.coverRefId).itemIds;
    // Locks and release timing are shared with Work publishing. This requires
    // the narrow RefHolderKind addition proposed beside this file.
    await releaseHolderRefs(
      db,
      [{ holderKind: "article_draft", holderIds: [draft.id] }],
      now,
      ids,
    );
    if (ids.length)
      await db.query(
        `INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id)
       SELECT id,'article_draft',$3 FROM community.media_items
       WHERE owner_id=$1 AND id=ANY($2::text[]) AND state NOT IN ('cancelled','purged') ON CONFLICT DO NOTHING`,
        [draft.ownerId, ids, draft.id],
      );
  }
  private assertInput(
    command: Pick<ArticleCreateCommand, "title" | "coverRefId" | "document">,
  ) {
    if ([...command.title].length > 120)
      throw new CommunityInputError("article_title_too_long");
    return {
      title: command.title,
      coverRefId: command.coverRefId,
      document: documentOf(command.document),
    };
  }

  create(
    actor: ArticleAuthoringActor,
    command: ArticleCreateCommand,
    now: Date,
  ): Promise<ArticleDraft> {
    const content = this.assertInput(command),
      fingerprint = authoredArticleFingerprint(content);
    return this.mutate(
      actor,
      null,
      command,
      "draft-write",
      "article.draft.create",
      now,
      async (db) => {
        const settings = await selectSettings(db, "share");
        const count = Number(
          (
            await db.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM community.article_documents WHERE owner_id=$1 AND status IN ('draft','pending')",
              [actor.userId],
            )
          ).rows[0]?.count ?? 0,
        );
        if (count >= settings.maxActiveDrafts)
          throw new CommunityInputError("article_draft_limit");
        const id = `article-${randomUUID().replaceAll("-", "")}` as ArticleId;
        const candidate = { ...content, ownerId: actor.userId };
        const issues = await this.referenceIssues(db, candidate, false);
        if (issues.length) throw new ArticleReferencesUnavailableError(issues);
        const row = (
          await db.query<DraftRow>(
            `INSERT INTO community.article_documents(id,owner_id,version,title,cover_ref_id,document,fingerprint,created_at,updated_at)
         VALUES($1,$2,1,$3,$4,$5::jsonb,$6,$7::timestamptz,$7::timestamptz) RETURNING ${columns}`,
            [
              id,
              actor.userId,
              content.title,
              content.coverRefId,
              JSON.stringify(content.document),
              fingerprint,
              now.toISOString(),
            ],
          )
        ).rows[0]!;
        const draft = draftOf(row);
        await this.attachDraftRefs(db, draft, now);
        return draft;
      },
      (draft) => draft.id,
    );
  }
  read(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    now: Date,
  ): Promise<ArticleDraft> {
    return actorTransaction(this.pool, actor.userId, async (db) => {
      await this.admit(db, actor, "read", id, now);
      return this.owned(db, actor, id);
    });
  }
  list(
    actor: ArticleAuthoringActor,
    query: ArticleDraftListQuery,
    now: Date,
  ): Promise<ArticleAuthoringPage> {
    const cursor = decodeCursor(query.cursor);
    if (
      !Number.isInteger(query.pageSize) ||
      query.pageSize < 1 ||
      query.pageSize > 50
    )
      throw new CommunityInputError("article_page_invalid");
    return actorTransaction(this.pool, actor.userId, async (db) => {
      await this.admit(db, actor, "read", null, now);
      const rows = (
        await db.query<DraftSummaryRow>(
          `SELECT ${summaryColumns} FROM community.article_documents
        WHERE owner_id=$1 AND ($2::timestamptz IS NULL OR (updated_at,id)<($2::timestamptz,$3::text))
        ORDER BY updated_at DESC,id DESC LIMIT $4`,
          [
            actor.userId,
            cursor?.[0] ?? null,
            cursor?.[1] ?? null,
            query.pageSize + 1,
          ],
        )
      ).rows;
      const visible = rows.slice(0, query.pageSize);
      return {
        items: visible.map(summaryOf),
        nextCursor:
          rows.length > query.pageSize ? cursorOf(visible.at(-1)!) : null,
      };
    });
  }
  save(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    command: ArticleSaveCommand,
    now: Date,
  ): Promise<ArticleDraft> {
    const content = this.assertInput(command),
      fingerprint = authoredArticleFingerprint(content);
    return this.mutate(
      actor,
      id,
      command,
      "draft-write",
      "article.draft.save",
      now,
      async (db) => {
        const prior = await this.owned(db, actor, id, "update");
        assertVersion(prior, command.expectedVersion);
        return this.saveContent(db, actor, id, content, fingerprint, now);
      },
    );
  }
  /** Runs only after receipt lookup and the current owned document lock. */
  private async saveContent(
    db: PoolClient,
    actor: ArticleAuthoringActor,
    id: ArticleId,
    content: Pick<ArticleDraft, "title" | "coverRefId" | "document">,
    fingerprint: string,
    now: Date,
  ): Promise<ArticleDraft> {
    const issues = await this.referenceIssues(
      db,
      { ...content, ownerId: actor.userId },
      false,
    );
    if (issues.length) throw new ArticleReferencesUnavailableError(issues);
    const row = (
      await db.query<DraftRow>(
        `UPDATE community.article_documents
      SET version=version+1,title=$3,cover_ref_id=$4,document=$5::jsonb,fingerprint=$6,status='draft',pending_version=NULL,updated_at=$7::timestamptz
      WHERE id=$1 AND owner_id=$2 RETURNING ${columns}`,
        [
          id,
          actor.userId,
          content.title,
          content.coverRefId,
          JSON.stringify(content.document),
          fingerprint,
          now.toISOString(),
        ],
      )
    ).rows[0]!;
    const draft = draftOf(row);
    await this.attachDraftRefs(db, draft, now);
    return draft;
  }
  editBlocks(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    command: ArticleBlockEditsCommand,
    now: Date,
  ): Promise<ArticleDraft> {
    return this.mutate(
      actor,
      id,
      command,
      "draft-write",
      "article.draft.edit",
      now,
      async (db) => {
        const prior = await this.owned(db, actor, id, "update");
        assertVersion(prior, command.expectedVersion);
        let document: ArticleAuthoringDocument;
        try {
          document = applyArticleBlockEdits(prior.document, command.edits);
        } catch {
          throw new CommunityInputError("article_block_edits_invalid");
        }
        const content = this.assertInput({
          title: prior.title,
          coverRefId: prior.coverRefId,
          document,
        });
        return this.saveContent(
          db,
          actor,
          id,
          content,
          authoredArticleFingerprint(content),
          now,
        );
      },
    );
  }
  private async validation(
    db: PoolClient,
    draft: ArticleDraft,
  ): Promise<ArticleCandidateValidation> {
    const issues = await this.referenceIssues(db, draft, true);
    if (!draft.title.trim())
      issues.push({ code: "title_required", path: ["title"] });
    return {
      id: draft.id,
      version: draft.version,
      fingerprint: draft.fingerprint,
      valid: issues.length === 0,
      issues,
    };
  }
  validate(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    candidate: ArticleCandidateIdentity,
    now: Date,
  ): Promise<ArticleCandidateValidation> {
    return actorTransaction(this.pool, actor.userId, async (db) => {
      await this.admit(db, actor, "read", id, now);
      const draft = await this.owned(db, actor, id);
      assertVersion(draft, candidate.expectedVersion, candidate.fingerprint);
      return this.validation(db, draft);
    });
  }
  preview(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    candidate: ArticleCandidateIdentity,
    now: Date,
  ): Promise<ArticlePreview> {
    return actorTransaction(this.pool, actor.userId, async (db) => {
      await this.admit(db, actor, "read", id, now);
      const draft = await this.owned(db, actor, id);
      assertVersion(draft, candidate.expectedVersion, candidate.fingerprint);
      return { draft, validation: await this.validation(db, draft) };
    });
  }
  publish(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    command: ArticlePublishCommand,
    now: Date,
  ): Promise<ArticleDraft> {
    return this.mutate(
      actor,
      id,
      command,
      "publish",
      "article.publish",
      now,
      async (db) => {
        const draft = await this.owned(db, actor, id, "update");
        assertVersion(draft, command.expectedVersion, command.fingerprint);
        const settings = await selectSettings(db, "share");
        const validation = await this.validation(db, draft);
        if (!validation.valid)
          throw new ArticleReferencesUnavailableError(validation.issues);
        if (actor.source === "delegated") {
          if (!this.options.assertDelegatedPublication)
            throw new CommunityNotFoundError();
          await this.options.assertDelegatedPublication(
            db,
            {
              articleId: id,
              ownerId: actor.userId,
              version: draft.version,
              fingerprint: draft.fingerprint,
            },
            actor,
            command.requestId,
            now,
          );
        }
        // A candidate snapshot is inserted BEFORE the mutable state advances.
        // Receipt replay precedes this callback and never creates another row.
        await db.query(
          `INSERT INTO community.article_revisions(article_id,version,owner_id,title,cover_ref_id,document,fingerprint,submitted_policy,submitted_by_source,created_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::timestamptz)`,
          [
            id,
            draft.version,
            actor.userId,
            draft.title,
            draft.coverRefId,
            JSON.stringify(draft.document),
            draft.fingerprint,
            settings.policy,
            actor.source,
            now.toISOString(),
          ],
        );
        const ids = referencesOf(draft.document, draft.coverRefId).itemIds;
        if (ids.length)
          await db.query(
            `INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id)
        SELECT id,'article_revision',$3 FROM community.media_items WHERE owner_id=$1 AND id=ANY($2::text[]) ON CONFLICT DO NOTHING`,
            [actor.userId, ids, revisionHolder(id, draft.version)],
          );
        const direct = settings.policy === "DIRECT_PUBLICATION";
        const row = (
          await db.query<DraftRow>(
            `UPDATE community.article_documents SET
        version=version+1,status=$3,
        published_version=CASE WHEN $4::boolean THEN $5 ELSE published_version END,
        pending_version=CASE WHEN $4::boolean THEN NULL ELSE $5 END,
        first_published_at=CASE WHEN $4::boolean THEN COALESCE(first_published_at,$6::timestamptz) ELSE first_published_at END,
        published_at=CASE WHEN $4::boolean THEN $6::timestamptz ELSE published_at END,
        updated_at=$6::timestamptz
        WHERE id=$1 AND owner_id=$2 RETURNING ${columns}`,
            [
              id,
              actor.userId,
              direct ? "published" : "pending",
              direct,
              draft.version,
              now.toISOString(),
            ],
          )
        ).rows[0]!;
        return draftOf(row);
      },
    );
  }
  withdraw(
    actor: ArticleAuthoringActor,
    id: ArticleId,
    command: ArticleWithdrawCommand,
    now: Date,
  ): Promise<ArticleDraft> {
    return this.mutate(
      actor,
      id,
      command,
      "publish",
      "article.withdraw",
      now,
      async (db) => {
        const draft = await this.owned(db, actor, id, "update");
        assertVersion(draft, command.expectedVersion, command.fingerprint);
        const row = (
          await db.query<DraftRow>(
            `UPDATE community.article_documents SET version=version+1,status='withdrawn',published_version=NULL,pending_version=NULL,updated_at=$3::timestamptz WHERE id=$1 AND owner_id=$2 RETURNING ${columns}`,
            [id, actor.userId, now.toISOString()],
          )
        ).rows[0]!;
        // Withdrawal changes public visibility, never the underlying asset or
        // immutable historical snapshots and their retention refs.
        return draftOf(row);
      },
    );
  }
  /** Bounded, oldest-first current-pending queue behind the operator guard. */
  listPending(query: ArticlePendingListQuery): Promise<ArticlePendingPage> {
    const cursor = decodeCursor(query.cursor);
    if (
      !Number.isInteger(query.pageSize) ||
      query.pageSize < 1 ||
      query.pageSize > 50
    )
      throw new CommunityInputError("article_page_invalid");
    return readTransaction(this.pool, async (db) => {
      const rows = (
        await db.query<PendingSummaryRow>(
          `SELECT ${pendingColumns} ${pendingFrom}
        AND ($1::timestamptz IS NULL OR (r.created_at,a.id)>($1::timestamptz,$2::text))
        ORDER BY r.created_at ASC,a.id ASC LIMIT $3`,
          [cursor?.[0] ?? null, cursor?.[1] ?? null, query.pageSize + 1],
        )
      ).rows;
      const visible = rows.slice(0, query.pageSize),
        last = visible.at(-1);
      return articlePendingPageSchema.parse({
        items: visible.map(pendingSummaryOf),
        nextCursor:
          rows.length > query.pageSize && last
            ? cursorOf({ id: last.id, updated_at: last.submitted_at })
            : null,
      });
    });
  }
  readPending(id: ArticleId): Promise<ArticlePendingCandidate> {
    return readTransaction(this.pool, async (db) => {
      const row = (
        await db.query<PendingRow>(
          `SELECT ${pendingColumns},r.document ${pendingFrom} AND a.id=$1`,
          [id],
        )
      ).rows[0];
      if (!row) throw new CommunityNotFoundError();
      return pendingCandidateOf(row);
    });
  }
  /** Staff moderation is independent of any delegated human-action consent. */
  moderatePending(
    operator: string,
    id: ArticleId,
    command: ModerateArticlePendingCommand,
    now: Date,
  ): Promise<ArticleModerationResult> {
    return operatorCommand(
      this.pool,
      {
        operator,
        requestId: command.requestId,
        action: "article.submission.moderate",
        target: { type: "article", id },
        input: command,
        now,
      },
      async (db) => {
        const identity = (
          await db.query<{ owner_id: string }>(
            "SELECT owner_id FROM community.article_documents WHERE id=$1",
            [id],
          )
        ).rows[0];
        if (!identity) throw new CommunityNotFoundError();
        // Match author write lock order. No Payload/public-human actor is forged.
        await lockActor(db, identity.owner_id);
        const row = (
          await db.query<PendingRow>(
            `SELECT ${pendingColumns},r.document ${pendingFrom} AND a.id=$1 FOR UPDATE OF a`,
            [id],
          )
        ).rows[0];
        if (
          !row ||
          row.expected_version !== command.expectedVersion ||
          row.candidate_version !== command.candidateVersion ||
          row.fingerprint !== command.fingerprint
        )
          throw new CommunityConflictError(
            "The Article is no longer the pending exact candidate",
          );
        const candidate = pendingCandidateOf(row);
        if (command.action === "approve") {
          // Current settings/ref locks live through this SAME decision commit.
          await selectSettings(db, "share");
          const validation = await this.validation(db, {
            id,
            ownerId: candidate.ownerId,
            version: candidate.candidateVersion,
            title: candidate.title,
            coverRefId: candidate.coverRefId,
            document: candidate.document,
            fingerprint: candidate.fingerprint,
            status: "pending",
            publicVersion: candidate.publicVersion,
            updatedAt: row.updated_at.toISOString(),
          });
          if (!validation.valid)
            throw new ArticleReferencesUnavailableError(validation.issues);
        }
        const approve = command.action === "approve";
        const changed = (
          await db.query<{ version: number; published_version: number | null }>(
            `UPDATE community.article_documents
        SET version=version+1,status=CASE WHEN $3::boolean THEN 'published' ELSE 'draft' END,
          published_version=CASE WHEN $3::boolean THEN $4 ELSE published_version END,
          pending_version=NULL,
          first_published_at=CASE WHEN $3::boolean THEN COALESCE(first_published_at,$5::timestamptz) ELSE first_published_at END,
          published_at=CASE WHEN $3::boolean THEN $5::timestamptz ELSE published_at END,
          updated_at=$5::timestamptz
        WHERE id=$1 AND owner_id=$2 RETURNING version,published_version`,
            [
              id,
              identity.owner_id,
              approve,
              candidate.candidateVersion,
              now.toISOString(),
            ],
          )
        ).rows[0]!;
        return articleModerationResultSchema.parse({
          articleId: id,
          candidateVersion: candidate.candidateVersion,
          fingerprint: candidate.fingerprint,
          version: changed.version,
          disposition: approve ? "approved" : "rejected",
          status: approve ? "published" : "draft",
          publicVersion: changed.published_version,
        });
      },
    );
  }
  readPublished(id: ArticleId): Promise<PublishedAuthoredArticle | null> {
    return readTransaction(this.pool, async (db) => {
      const row = (
        await db.query<PublishedRow>(
          `SELECT ${publishedColumns} ${publishedFrom} AND a.id=$1`,
          [id],
        )
      ).rows[0];
      return row ? publishedOf(row) : null;
    });
  }
  listPublished(query: {
    page: number;
    pageSize: number;
  }): Promise<{ items: PublishedAuthoredArticleSummary[]; total: number }> {
    if (
      !Number.isSafeInteger(query.page) ||
      query.page < 1 ||
      !Number.isInteger(query.pageSize) ||
      query.pageSize < 1 ||
      query.pageSize > 100
    )
      throw new CommunityInputError("article_page_invalid");
    return readTransaction(this.pool, async (db) => {
      const count = (
        await db.query<{ total: string }>(
          `SELECT count(*)::text AS total ${publishedFrom}`,
        )
      ).rows[0]!;
      const listingColumns =
        publishedColumns.replace("r.document,", "") +
        ",r.document->'references'->r.cover_ref_id AS cover_reference";
      const rows = (
        await db.query<
          PublishedSummaryRow & {
            cover_reference: ArticleMediaReference | null;
          }
        >(
          `SELECT ${listingColumns} ${publishedFrom} ORDER BY a.published_at DESC,a.id DESC LIMIT $1 OFFSET $2::bigint`,
          [query.pageSize, String((query.page - 1) * query.pageSize)],
        )
      ).rows;
      return {
        items: rows.map((row) => ({
          id: row.article_id as ArticleId,
          ownerId: row.owner_id as PublicUserId,
          version: row.version,
          title: row.title,
          coverRefId: row.cover_ref_id,
          fingerprint: row.fingerprint,
          byline: row.byline,
          firstPublishedAt: row.first_published_at.toISOString(),
          publishedAt: row.published_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
          coverReference: row.cover_reference,
        })),
        total: Number(count.total),
      };
    });
  }
}

export class ArticleReferencesUnavailableError extends CommunityInputError {
  readonly code = "ARTICLE_REFERENCES_UNAVAILABLE";
  constructor(readonly issues: ArticleReferenceIssue[]) {
    super("article_references_unavailable");
  }
}
