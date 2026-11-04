import {
  adminApprovalRevokeInputSchema,
  adminCollectionSaveInputSchema,
  adminMediaRegisterInputSchema,
  adminMediaUpdateInputSchema,
  adminPublicationInputSchema,
  adminRestoreInputSchema,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminCmsRecordType,
  AdminCollectionSaveInput,
  AdminMediaRegisterInput,
  AdminOpClass,
  AdminPublicationInput,
} from "@moya/contracts/internal/admin-mcp";
import { sql, type PostgresAdapter } from "@payloadcms/db-postgres";
import type { PayloadRequest } from "payload";

import { assertCatalogDeliveryPublication } from "../../editorial/catalog-delivery";
import { relationshipID } from "../../editorial/collections";
import {
  draftContent,
  payloadContentData,
  publishedContent,
  requestFingerprint,
} from "../../editorial/content";
import { EditorialError } from "../../editorial/errors";
import {
  numericID,
  receiptedCommand,
  restoreVersionAsDraft,
} from "../../editorial/operations";
import {
  collectingSupersededIntents,
  lockEditorialKey,
  withEditorialTransaction,
} from "../../editorial/transaction";
import { articleContentSubset } from "../../editorial-content/approvals";
import type { EditorialReceipt } from "../../payload-types";
import { okEnvelope } from "../envelope";
import {
  CMS_FAMILIES,
  collectionContent,
  findDocuments,
  readLatest,
  readLive,
  rowIdOf,
  type CmsFamily,
  type RecordDocument,
} from "../records";
import { requestKeyOf, type AdminOpContext, type AdminOpEntry } from "./define";
import {
  beforeOf,
  echoOf,
  removedBy,
  type SavedAnswer,
  type SaveSlug,
} from "./saves";

/**
 * Publish, withdraw, restore and the small saves on admin_execute: the same Local API
 * call the Admin's own request makes, under this key's user, with overrideAccess and
 * overrideLock false, so every hook still runs, inside a receipt so a retry replays
 * (admin-mcp-completion-v1 section 10).
 */

type PublicationAction = "publish" | "withdraw" | "restore";
type VersionedType = Exclude<AdminCmsRecordType, "media">;

interface PublicationSpec {
  readonly family: CmsFamily;
  readonly slug: SaveSlug;
  readonly column: "catalog" | "article" | "articleCollection";
  readonly receipts: Readonly<
    Record<PublicationAction, EditorialReceipt["operation"]>
  >;
  /** What a publish writes beside the state: a Catalog writes its full snapshot. */
  readonly publishData: (latest: RecordDocument) => Record<string, unknown>;
  readonly contentOf: (document: RecordDocument) => Record<string, unknown>;
}

const SPECS: Readonly<Record<VersionedType, PublicationSpec>> = {
  catalog: {
    family: CMS_FAMILIES.catalog,
    slug: "catalogs",
    column: "catalog",
    receipts: {
      publish: "publish-direct",
      withdraw: "withdraw",
      restore: "restore-draft",
    },
    publishData: (latest) => payloadContentData(publishedContent(latest)),
    contentOf: draftContent,
  },
  article: {
    family: CMS_FAMILIES.article,
    slug: "articles",
    column: "article",
    receipts: {
      publish: "article-publish",
      withdraw: "article-withdraw",
      restore: "article-restore",
    },
    publishData: () => ({}),
    contentOf: articleContentSubset,
  },
  collection: {
    family: CMS_FAMILIES.collection,
    slug: "article-collections",
    column: "articleCollection",
    receipts: {
      publish: "collection-publish",
      withdraw: "collection-withdraw",
      restore: "collection-restore",
    },
    publishData: () => ({}),
    contentOf: collectionContent,
  },
};

/** The row an id names, or the record is not there for this key. */
export const requireRow = async (
  req: PayloadRequest,
  family: CmsFamily,
  id: number | string,
): Promise<number> => {
  const row = await rowIdOf(req, family, id);
  if (row === undefined) throw new EditorialError("RECORD_UNAVAILABLE", 404);
  return row;
};

/** One write, with the delivery intents its hooks ended, as a draft save reports them. */
const written = async (
  { family }: PublicationSpec,
  req: PayloadRequest,
  status: "draft" | "published",
  write: () => Promise<unknown>,
): Promise<SavedAnswer> => {
  const { saved, superseded } = await collectingSupersededIntents(req, write);
  const doc = saved as RecordDocument;
  return {
    id: numericID(doc.id),
    revision: Number(doc.revision),
    fingerprint: family.fingerprint(doc),
    status,
    ...(superseded.length > 0 ? { supersededIntents: superseded } : {}),
  };
};

/** One command under this target's key: a repeat replays, a changed one conflicts. */
const receipted = (
  { column, receipts, family }: PublicationSpec,
  context: AdminOpContext,
  action: PublicationAction | "save",
  parsed: object,
  work: () => Promise<SavedAnswer>,
) =>
  receiptedCommand(
    context.req,
    requestKeyOf(context),
    requestFingerprint({ operation: `${family.type}.${action}`, ...parsed }),
    action === "save" ? "collection-save" : receipts[action],
    work,
    ({ id, revision, fingerprint }) =>
      ({
        [column]: id,
        revision,
        fingerprint,
      }) as Partial<EditorialReceipt>,
    (receipt) => ({
      id: numericID(relationshipID(receipt[column])),
      revision: Number(receipt.revision),
      fingerprint: String(receipt.fingerprint),
      status:
        action === "publish" ? ("published" as const) : ("draft" as const),
    }),
  );

const assertExpected = (
  { family }: PublicationSpec,
  latest: RecordDocument,
  expected: AdminPublicationInput["expected"],
) => {
  if (
    latest.revision !== expected.revision ||
    (expected.fingerprint !== undefined &&
      expected.fingerprint !== family.fingerprint(latest))
  )
    throw new EditorialError("REVISION_CONFLICT", 409);
};

export const publishRecord =
  (type: VersionedType) => async (raw: unknown, context: AdminOpContext) => {
    const parsed = adminPublicationInputSchema.parse(raw);
    const { req } = context;
    const spec = SPECS[type];
    const id = await requireRow(req, spec.family, parsed.id);
    const saved = await receipted(
      spec,
      context,
      "publish",
      parsed,
      async () => {
        await lockEditorialKey(req, `document:${id}`);
        const latest = await readLatest(req, spec.family, id);
        const { revision, fingerprint } = parsed.expected;
        // Publishing moves the revision and keeps the content, so a retry under a new
        // key after a success finds exactly what it read already live.
        if (
          latest._status === "published" &&
          (fingerprint === undefined
            ? latest.revision === revision
            : fingerprint === spec.family.fingerprint(latest))
        ) {
          // Live says nothing of its images: the Owner's switch publishes ahead of them.
          if (type === "catalog")
            await assertCatalogDeliveryPublication(draftContent(latest), req);
          throw new EditorialError("ALREADY_PUBLISHED", 409);
        }
        assertExpected(spec, latest, parsed.expected);
        return written(spec, req, "published", () =>
          req.payload.update({
            collection: spec.slug,
            id,
            data: {
              ...spec.publishData(latest),
              revision: Number(latest.revision),
              _status: "published",
            } as never,
            draft: false,
            depth: 0,
            overrideAccess: false,
            overrideLock: false,
            req,
            user: req.user,
          }),
        );
      },
    );
    return okEnvelope(
      await echoOf(
        context,
        spec.slug,
        saved,
        undefined,
        undefined,
        spec.contentOf,
      ),
    );
  };

export const withdrawRecord =
  (type: VersionedType) => async (raw: unknown, context: AdminOpContext) => {
    const parsed = adminPublicationInputSchema.parse(raw);
    const { req } = context;
    const spec = SPECS[type];
    const id = await requireRow(req, spec.family, parsed.id);
    const saved = await receipted(
      spec,
      context,
      "withdraw",
      parsed,
      async () => {
        await lockEditorialKey(req, `document:${id}`);
        // The live row is what the public reads, whatever a later draft says, so a
        // record it no longer holds has nothing left to withdraw at any revision.
        const live = await readLive(req, spec.family, id);
        if (live._status !== "published")
          throw new EditorialError("ALREADY_WITHDRAWN", 409);
        assertExpected(
          spec,
          await readLatest(req, spec.family, id),
          parsed.expected,
        );
        return written(spec, req, "draft", () =>
          req.payload.update({
            collection: spec.slug,
            id,
            data: {
              revision: parsed.expected.revision,
              _status: "draft",
            } as never,
            draft: false,
            depth: 0,
            overrideAccess: false,
            overrideLock: false,
            req,
            user: req.user,
          }),
        );
      },
    );
    return okEnvelope(
      await echoOf(
        context,
        spec.slug,
        saved,
        undefined,
        undefined,
        spec.contentOf,
      ),
    );
  };

export const restoreRecord =
  (type: VersionedType) => async (raw: unknown, context: AdminOpContext) => {
    const parsed = adminRestoreInputSchema.parse(raw);
    const { req } = context;
    const spec = SPECS[type];
    const id = await requireRow(req, spec.family, parsed.id);
    const before = await beforeOf(context, spec.slug, id);
    const saved = await receipted(
      spec,
      context,
      "restore",
      parsed,
      async () => {
        await lockEditorialKey(req, `document:${id}`);
        const { docs } = await req.payload.db.findVersions({
          collection: spec.slug,
          limit: 1,
          pagination: false,
          req,
          where: { id: { equals: parsed.versionId } },
        });
        // A version of another record is not this record's to restore.
        if (String(docs[0]?.parent) !== String(id))
          throw new EditorialError("VERSION_NOT_FOUND", 404);
        assertExpected(
          spec,
          await readLatest(req, spec.family, id),
          parsed.expected,
        );
        return written(spec, req, "draft", () =>
          restoreVersionAsDraft(
            req,
            spec.slug,
            parsed.versionId,
            parsed.expected.revision,
          ),
        );
      },
    );
    return okEnvelope(
      await echoOf(
        context,
        spec.slug,
        saved,
        before,
        type === "catalog" && before !== undefined
          ? (after) => removedBy(before, after)
          : undefined,
        spec.contentOf,
      ),
    );
  };

/**
 * Whether this record's media cannot be public: no version the system still keeps
 * holds any, and none has been pruned, so there is no older one to ask about.
 */
const holdsNoMedia = async (req: PayloadRequest, id: number) => {
  const { drizzle } = req.payload.db as unknown as Pick<
    PostgresAdapter,
    "drizzle"
  >;
  const { rows } = await drizzle.execute(sql`
    SELECT
      EXISTS (SELECT 1 FROM catalogs_media WHERE _parent_id = ${id})
        OR EXISTS (
          SELECT 1 FROM _catalogs_v_version_media m
          JOIN _catalogs_v v ON v.id = m._parent_id
          WHERE v.parent_id = ${id}
        ) AS held,
      (SELECT count(*) FROM _catalogs_v WHERE parent_id = ${id})::int AS versions`);
  const { held, versions } = rows[0] as { held: boolean; versions: number };
  const setting = req.payload.collections.catalogs.config.versions;
  const kept = typeof setting === "object" ? setting.maxPerDoc : undefined;
  return !held && (kept === undefined || kept === 0 || versions < kept);
};

const WORKER_SYNC_HINT =
  "The record has left public reads. Its images leave when the worker next reconciles, and no read here can prove that yet, so do not report them gone, and repeating this cannot change the answer. Read the record for its state.";

/**
 * The worker's Catalog reconcile withdraws a record's renditions, and no job exists
 * until it runs (publishing/publication.ts). published-renditions cannot prove it:
 * its `complete` is false as soon as one rendition of a set has left and also when
 * the set never finished, so false is not "none of it is live" (section 9). Only a
 * record with no media at all has nothing left to prove.
 */
export const catalogWithdrawal: AdminOpEntry["completion"] = {
  kind: "async",
  settle: async (raw, _result, { req }) => {
    const id = await requireRow(
      req,
      CMS_FAMILIES.catalog,
      adminPublicationInputSchema.parse(raw).id,
    );
    if (await holdsNoMedia(req, id)) return { ok: true, code: "OK" };
    return {
      ok: false,
      code: "QUEUED",
      state: "worker_sync",
      hint: WORKER_SYNC_HINT,
      next: { tool: "admin_get", args: { type: "catalog", id } },
    };
  },
};

/** A collection's public id is set once, on create. An edit binds nothing. */
export const classifyCollectionSave = async (
  raw: unknown,
): Promise<AdminOpClass> =>
  (raw as AdminCollectionSaveInput).id === undefined
    ? "irreversible"
    : "reversible";

export const saveCollection = async (raw: unknown, context: AdminOpContext) => {
  const parsed = adminCollectionSaveInputSchema.parse(raw);
  const { req } = context;
  const spec = SPECS.collection;
  // A create is classed irreversible, so it never comes here.
  const id = await requireRow(req, spec.family, parsed.id!);
  const before = await beforeOf(context, spec.slug, id);
  const saved = await receipted(spec, context, "save", parsed, async () => {
    if (parsed.expected === undefined)
      throw new EditorialError("REVISION_REQUIRED", 409, ["expected"]);
    await lockEditorialKey(req, `document:${id}`);
    assertExpected(
      spec,
      await readLatest(req, spec.family, id),
      parsed.expected,
    );
    const { revision } = parsed.expected;
    return written(spec, req, "draft", () =>
      req.payload.update({
        collection: spec.slug,
        id,
        data: { ...parsed.content, revision } as never,
        draft: true,
        depth: 0,
        overrideAccess: false,
        overrideLock: false,
        req,
        user: req.user,
      }),
    );
  });
  return okEnvelope(
    await echoOf(context, spec.slug, saved, before, undefined, spec.contentOf),
  );
};

/**
 * No receipt: the row holds one thing to change, so the row itself says whether this
 * already happened, and a save of what it already says writes nothing.
 */
export const updateMediaMetadata = async (
  raw: unknown,
  { req }: AdminOpContext,
) => {
  const parsed = adminMediaUpdateInputSchema.parse(raw);
  const family = CMS_FAMILIES.media;
  const id = await requireRow(req, family, parsed.id);
  const updated = await withEditorialTransaction(req, async () => {
    await lockEditorialKey(req, `media:${id}`);
    const current = await readLatest(req, family, id);
    if (current.alt === parsed.alt)
      throw new EditorialError("ALREADY_SET", 409);
    if (family.fingerprint(current) !== parsed.expected.fingerprint)
      throw new EditorialError("REVISION_CONFLICT", 409);
    return req.payload.update({
      collection: "media",
      id,
      data: { alt: parsed.alt },
      depth: 0,
      overrideAccess: false,
      overrideLock: false,
      req,
      user: req.user,
    });
  });
  const doc = updated as unknown as RecordDocument;
  return okEnvelope({
    id,
    mediaId: doc.mediaId,
    catalogId: doc.catalogId,
    title: doc.alt,
    fingerprint: family.fingerprint(doc),
    // A Catalog holds its own copy of an image's alt from when it was selected.
    warnings: ["catalog_alt_kept"],
  });
};

// Strict, an omitted one included, as catalog-ingest.ts matchesIntent compares: alt and
// rights are what a caller means to have recorded, and no answer here shows them.
const REGISTERED_FIELDS = [
  "catalogId",
  "objectKey",
  "sha256",
  "mimeType",
  "filesize",
  "width",
  "height",
  "alt",
  "rights",
  "orderConfidence",
] as const;

const registeredRow = async (req: PayloadRequest, mediaId: string) => {
  const [row] = await findDocuments(req, CMS_FAMILIES.media, {
    where: { mediaId: { equals: mediaId } },
    limit: 1,
    draft: false,
    select: Object.fromEntries(
      ["mediaId", ...REGISTERED_FIELDS].map((name) => [name, true]),
    ),
  });
  return row;
};

export const classifyMediaRegistration = async (
  raw: unknown,
  { req }: AdminOpContext,
): Promise<AdminOpClass> =>
  (await registeredRow(req, (raw as AdminMediaRegisterInput).mediaId)) ===
  undefined
    ? "irreversible"
    : "reversible";

/** Only a row that is there comes here: the identical row replays, others are refused. */
export const answerMediaRegistration = async (
  raw: unknown,
  { req }: AdminOpContext,
) => {
  const input = adminMediaRegisterInputSchema.parse(raw);
  const row = await registeredRow(req, input.mediaId);
  if (
    row === undefined ||
    REGISTERED_FIELDS.some((name) => (row[name] ?? undefined) !== input[name])
  )
    throw new EditorialError("MEDIA_IDENTITY_EXISTS", 409);
  return okEnvelope({ id: row.id, mediaId: input.mediaId, replayed: true });
};

const APPROVAL_COLLECTIONS = {
  catalog: "editorial-approvals",
  article: "editorial-article-approvals",
} as const;

/** The approval lock is what a publish holds while it reads the batch. */
export const revokeApproval = async (raw: unknown, { req }: AdminOpContext) => {
  const parsed = adminApprovalRevokeInputSchema.parse(raw);
  const approvalId = numericID(parsed.approvalId);
  const collection = APPROVAL_COLLECTIONS[parsed.type] as "editorial-approvals";
  const updated = await withEditorialTransaction(req, async () => {
    await lockEditorialKey(req, `approval:${approvalId}`);
    const approval = await req.payload.findByID({
      collection,
      id: approvalId,
      depth: 0,
      overrideAccess: false,
      req,
      user: req.user,
    });
    if (approval.status === "revoked")
      throw new EditorialError("ALREADY_REVOKED", 409);
    return req.payload.update({
      collection,
      id: approvalId,
      data: { status: "revoked" },
      depth: 0,
      overrideAccess: false,
      overrideLock: false,
      req,
      user: req.user,
    });
  });
  return okEnvelope({
    approvalId,
    status: updated.status,
    itemCount: updated.items.length,
  });
};
