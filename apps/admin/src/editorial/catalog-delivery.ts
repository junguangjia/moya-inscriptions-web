import { randomUUID } from "node:crypto";

import {
  cancelCatalogDeliverySchema,
  catalogDeliveryManifestSchema,
  catalogDeliveryResultSchema,
  prepareCatalogDeliverySchema,
  readCatalogDeliverySchema,
  releaseCatalogDeliverySchema,
  requestCatalogReleaseSchema,
  type CatalogDeliveryMedia,
  type CatalogDeliveryResult,
  type CatalogDeliveryState,
  type EditorialDraft,
} from "@moya/contracts/internal/editorial";
import { sql } from "@payloadcms/db-postgres";
import type { PayloadRequest } from "payload";

import { canEditCatalog, isOwner, requireActor } from "./access";
import {
  catalogDeliveryReadiness,
  readCatalogRecipePolicy,
  requireCatalogDeliveryBackend,
  readCatalogReadiness,
} from "./catalog-delivery-backend";
import {
  contentFingerprint,
  draftContent,
  requestFingerprint,
  payloadContentData,
  publishedContent,
} from "./content";
import { publishApproved } from "./operations";
import {
  catalogDeliveryPublishProof,
  withCatalogDeliveryPublish,
} from "./state";
import { EditorialError, validationError } from "./errors";
import {
  editorialTransaction,
  lockEditorialKey,
  withEditorialTransaction,
} from "./transaction";
import { validateCatalogMedia } from "../media/validation";

// Storage-only row shape, never an HTTP DTO. In particular, the persisted B
// snapshot and source object keys are not returned by the five endpoints.
interface IntentRow {
  id: string;
  catalog_document_id: number;
  catalog_id: string;
  actor_id: number;
  draft_revision: number;
  draft_fingerprint: string;
  draft_snapshot: EditorialDraft;
  base_revision: number;
  base_status: string;
  base_fingerprint: string;
  media_manifest: CatalogDeliveryMedia[];
  media_manifest_sha256: string;
  recipe_manifest_sha256: string | null;
  state: CatalogDeliveryState;
  state_version: number;
  expires_at: Date | string;
}

const parse = <T>(
  schema: {
    safeParse(
      input: unknown,
    ):
      | { success: true; data: T }
      | { success: false; error: { issues: { path: PropertyKey[] }[] } };
  },
  input: unknown,
): T => {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(result.error.issues);
  return result.data;
};

const assertScope = (req: PayloadRequest, row: IntentRow) => {
  requireActor(req);
  if (!canEditCatalog(req, row.catalog_id))
    throw new EditorialError("RECORD_UNAVAILABLE", 404);
};

const intentByID = async (
  req: PayloadRequest,
  id: string,
): Promise<IntentRow> => {
  const db = await editorialTransaction(req);
  const result = await db.execute(
    sql`SELECT * FROM catalog_delivery_intents WHERE id = ${id}::uuid`,
  );
  const row = result.rows[0] as IntentRow | undefined;
  if (!row) throw new EditorialError("RECORD_UNAVAILABLE", 404);
  assertScope(req, row);
  return row;
};

const lockedIntent = async (
  req: PayloadRequest,
  id: string,
): Promise<IntentRow> => {
  const initial = await intentByID(req, id);
  // The same document lock is used by all Native REST/Admin/MCP writes. Never
  // acquire an intent lock before this lock or invert the publication order.
  await lockEditorialKey(req, `document:${initial.catalog_document_id}`);
  const db = await editorialTransaction(req);
  await db.execute(sql`
    UPDATE catalog_delivery_intents SET state = 'expired', state_version = state_version + 1,
      ended_at = now(), end_reason = 'EXPIRED', updated_at = now()
    WHERE id = ${id}::uuid AND state IN ('prepared', 'release_requested') AND expires_at <= now()
  `);
  return intentByID(req, id);
};

const resultFor = (row: IntentRow, replayed: boolean): CatalogDeliveryResult =>
  catalogDeliveryResultSchema.parse({
    intentId: row.id,
    id: row.catalog_document_id,
    catalogId: row.catalog_id,
    revision: row.draft_revision,
    fingerprint: row.draft_fingerprint,
    manifestSha256: row.media_manifest_sha256,
    mediaCount: row.media_manifest.length,
    recipeManifestSha256: row.recipe_manifest_sha256,
    state: row.state,
    stateVersion: row.state_version,
    readiness:
      row.state === "released"
        ? "READY"
        : catalogDeliveryReadiness(row.recipe_manifest_sha256),
    publicCopyAuthorized:
      ["release_requested", "released"].includes(row.state) &&
      (row.state === "released" ||
        new Date(row.expires_at).getTime() > Date.now()),
    expiresAt: new Date(row.expires_at).toISOString(),
    replayed,
  });

class ExpiredIntent extends EditorialError {
  constructor() {
    super("CATALOG_DELIVERY_EXPIRED", 409);
  }
}

// Lifecycle entrypoints own their transaction. A caller cannot wrap a rejected
// command in a larger rollback and undo the expiry tombstone committed below.
// Native hooks use invalidateCatalogDelivery within their existing transaction.
const requireStandaloneTransaction = (req: PayloadRequest) => {
  if (req.transactionID)
    throw new EditorialError("CATALOG_DELIVERY_TRANSACTION_ACTIVE", 409);
};

const mutation = async (
  req: PayloadRequest,
  key: string,
  operation: "prepare" | "request-release" | "release" | "cancel",
  input: unknown,
  work: () => Promise<IntentRow>,
): Promise<CatalogDeliveryResult> => {
  const actor = requireActor(req);
  requireStandaloneTransaction(req);
  const deduplicationKey = requestFingerprint([actor.id, key]);
  const fingerprint = requestFingerprint({ operation, input });
  const outcome = await withEditorialTransaction(req, async () => {
    const db = await editorialTransaction(req);
    await lockEditorialKey(req, `delivery-receipt:${deduplicationKey}`);
    const prior = await db.execute(sql`
      SELECT request_fingerprint, intent_id FROM catalog_delivery_receipts
      WHERE deduplication_key = ${deduplicationKey}
    `);
    if (prior.rows.length) {
      const receipt = prior.rows[0] as {
        request_fingerprint: string;
        intent_id: string;
      };
      if (receipt.request_fingerprint !== fingerprint)
        throw new EditorialError("IDEMPOTENCY_CONFLICT", 409);
      // Replaying an old successful prepare cannot revive a cancelled B or
      // imply it is still visible. Always return the intent's current state.
      return resultFor(await lockedIntent(req, receipt.intent_id), true);
    }
    let row: IntentRow;
    try {
      row = await work();
    } catch (error) {
      // Only this closed domain outcome commits the already-applied expiry.
      // No receipt or other command mutation has been performed at this point.
      // SQL, scope, CAS and all other failures still roll back normally.
      if (error instanceof ExpiredIntent) return { expiry: error };
      throw error;
    }
    await db.execute(sql`
      INSERT INTO catalog_delivery_receipts
        (deduplication_key, actor_id, request_fingerprint, operation, intent_id)
      VALUES (${deduplicationKey}, ${actor.id}, ${fingerprint}, ${operation}, ${row.id}::uuid)
    `);
    return resultFor(row, false);
  });
  if ("expiry" in outcome) throw outcome.expiry;
  return outcome;
};

const latestDraft = async (req: PayloadRequest, id: number) => {
  try {
    return await req.payload.findByID({
      collection: "catalogs",
      id,
      draft: true,
      depth: 0,
      overrideAccess: false,
      req,
      user: req.user,
    });
  } catch {
    throw new EditorialError("RECORD_UNAVAILABLE", 404);
  }
};

const currentDraft = async (req: PayloadRequest, row: IntentRow) => {
  const latest = await latestDraft(req, row.catalog_document_id);
  if (
    latest.revision !== row.draft_revision ||
    contentFingerprint(latest) !== row.draft_fingerprint
  )
    throw new EditorialError("CATALOG_DELIVERY_DRAFT_CHANGED", 409);
  const primary = await req.payload.findByID({
    collection: "catalogs",
    id: row.catalog_document_id,
    draft: false,
    depth: 0,
    overrideAccess: false,
    req,
    user: req.user,
  });
  if (
    primary.revision !== row.base_revision ||
    primary._status !== row.base_status ||
    contentFingerprint(primary) !== row.base_fingerprint
  )
    throw new EditorialError("CATALOG_DELIVERY_BASE_CHANGED", 409);
  return latest;
};

const manifestFor = async (req: PayloadRequest, content: EditorialDraft) => {
  await validateCatalogMedia(req, content, { publishing: false });
  const hashes = new Map<string, string>();
  for (let offset = 0; offset < content.media.length; offset += 100) {
    const slice = content.media.slice(offset, offset + 100);
    const result = await req.payload.find({
      collection: "media",
      overrideAccess: false,
      req,
      depth: 0,
      limit: 100,
      select: { mediaId: true, sha256: true },
      where: { mediaId: { in: slice.map(({ mediaId }) => mediaId) } },
    });
    for (const media of result.docs) hashes.set(media.mediaId, media.sha256);
  }
  return parse(
    catalogDeliveryManifestSchema,
    content.media.map((media) => ({
      ...media,
      sourceSha256: hashes.get(media.mediaId),
    })),
  );
};

export const prepareCatalogDelivery = async (
  req: PayloadRequest,
  input: unknown,
) => {
  requireActor(req);
  const parsed = parse(prepareCatalogDeliverySchema, input);
  return mutation(req, parsed.idempotencyKey, "prepare", parsed, async () => {
    // Receipt replay has already returned above. Fetch only bounded policy
    // metadata, before holding the Native document lock; never source bytes.
    const policy = await readCatalogRecipePolicy();
    await lockEditorialKey(req, `document:${parsed.id}`);
    const latest = await latestDraft(req, parsed.id);
    if (
      latest.revision !== parsed.expectedRevision ||
      contentFingerprint(latest) !== parsed.expectedFingerprint
    )
      throw new EditorialError("CATALOG_DELIVERY_DRAFT_CHANGED", 409);
    const content = draftContent(latest);
    if (!canEditCatalog(req, content.catalogId))
      throw new EditorialError("RECORD_UNAVAILABLE", 404);
    const manifest = await manifestFor(req, content);
    const manifestSha256 = requestFingerprint(manifest);
    const primary = await req.payload.findByID({
      collection: "catalogs",
      id: parsed.id,
      draft: false,
      depth: 0,
      overrideAccess: false,
      req,
      user: req.user,
    });
    const baseFingerprint = contentFingerprint(primary);
    const db = await editorialTransaction(req);
    const existing = await db.execute(sql`
      SELECT * FROM catalog_delivery_intents WHERE catalog_document_id = ${parsed.id}
      AND state IN ('prepared', 'release_requested') AND expires_at > now()
    `);
    const active = existing.rows[0] as IntentRow | undefined;
    if (
      active &&
      active.draft_revision === latest.revision &&
      active.draft_fingerprint === parsed.expectedFingerprint &&
      active.media_manifest_sha256 === manifestSha256 &&
      active.base_revision === primary.revision &&
      active.base_status === primary._status &&
      active.base_fingerprint === baseFingerprint &&
      active.recipe_manifest_sha256 === (policy?.recipeManifestSha256 ?? null)
    )
      return active;
    await db.execute(sql`
      UPDATE catalog_delivery_intents SET state = 'superseded', state_version = state_version + 1,
        ended_at = now(), end_reason = 'NEW_PREPARE', updated_at = now()
      WHERE catalog_document_id = ${parsed.id} AND state IN ('prepared', 'release_requested')
    `);
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO catalog_delivery_intents
        (id, catalog_document_id, catalog_id, actor_id, draft_revision, draft_fingerprint, draft_snapshot,
         base_revision, base_status, base_fingerprint, media_manifest, media_manifest_sha256,
         recipe_manifest, recipe_manifest_sha256, expires_at)
      VALUES (${id}::uuid, ${parsed.id}, ${content.catalogId}, ${requireActor(req).id}, ${latest.revision},
        ${parsed.expectedFingerprint}, ${JSON.stringify(content)}::jsonb, ${primary.revision}, ${primary._status},
        ${baseFingerprint}, ${JSON.stringify(manifest)}::jsonb, ${manifestSha256},
        ${policy?.canonicalManifest ?? null}::jsonb, ${policy?.recipeManifestSha256 ?? null}, now() + interval '24 hours')
    `);
    return intentByID(req, id);
  });
};

export const readCatalogDelivery = async (
  req: PayloadRequest,
  input: unknown,
) => {
  requireActor(req);
  requireStandaloneTransaction(req);
  const parsed = parse(readCatalogDeliverySchema, input);
  return withEditorialTransaction(req, async () => {
    const row = await lockedIntent(req, parsed.intentId);
    const result = resultFor(row, false);
    if (
      row.recipe_manifest_sha256 &&
      ["prepared", "release_requested"].includes(row.state)
    ) {
      const proof = await readCatalogReadiness(row.id);
      if (
        proof.intentId !== row.id ||
        proof.manifestSha256 !== row.media_manifest_sha256 ||
        proof.recipeManifestSha256 !== row.recipe_manifest_sha256 ||
        proof.stateVersion !== row.state_version ||
        proof.mediaCount !== row.media_manifest.length
      )
        throw new EditorialError("CATALOG_DELIVERY_PROOF_CHANGED", 409);
      return {
        ...result,
        readiness: proof.publicReady
          ? ("READY" as const)
          : ("PENDING" as const),
      };
    }
    return result;
  });
};

const expectState = (row: IntentRow, version: number) => {
  if (row.state === "expired") throw new ExpiredIntent();
  if (row.state_version !== version)
    throw new EditorialError("CATALOG_DELIVERY_STATE_CONFLICT", 409);
  if (!["prepared", "release_requested"].includes(row.state))
    throw new EditorialError("CATALOG_DELIVERY_INACTIVE", 409);
};

export const requestCatalogRelease = async (
  req: PayloadRequest,
  input: unknown,
) => {
  requireActor(req);
  if (!isOwner(req))
    throw new EditorialError("CATALOG_RELEASE_OWNER_ONLY", 403);
  const parsed = parse(requestCatalogReleaseSchema, input);
  return mutation(
    req,
    parsed.idempotencyKey,
    "request-release",
    parsed,
    async () => {
      const row = await lockedIntent(req, parsed.intentId);
      expectState(row, parsed.expectedStateVersion);
      if (row.media_manifest_sha256 !== parsed.expectedManifestSha256)
        throw new EditorialError("CATALOG_DELIVERY_MANIFEST_CHANGED", 409);
      await currentDraft(req, row);
      if (!row.recipe_manifest_sha256) return requireCatalogDeliveryBackend();
      const policy = await readCatalogRecipePolicy();
      if (policy?.recipeManifestSha256 !== row.recipe_manifest_sha256)
        throw new EditorialError("CATALOG_DELIVERY_REPREPARE_REQUIRED", 409);
      const db = await editorialTransaction(req);
      await db.execute(
        sql`UPDATE catalog_delivery_intents SET state='release_requested',state_version=state_version+1,release_requested_by=${requireActor(req).id},release_requested_at=now(),updated_at=now() WHERE id=${row.id}::uuid AND state_version=${parsed.expectedStateVersion}`,
      );
      return intentByID(req, row.id);
    },
  );
};

export const releaseCatalogDelivery = async (
  req: PayloadRequest,
  input: unknown,
) => {
  requireActor(req);
  const parsed = parse(releaseCatalogDeliverySchema, input);
  const publishKey = `catalog-release:${requestFingerprint([parsed.intentId, parsed.idempotencyKey])}`;
  return mutation(req, parsed.idempotencyKey, "release", parsed, async () => {
    if (!isOwner(req)) {
      if (!parsed.approvalId)
        throw new EditorialError("CATALOG_RELEASE_APPROVAL_REQUIRED", 403);
      await lockEditorialKey(
        req,
        `receipt:${requestFingerprint([requireActor(req).id, publishKey])}`,
      );
      await lockEditorialKey(req, `approval:${parsed.approvalId}`);
    }
    const row = await lockedIntent(req, parsed.intentId);
    expectState(row, parsed.expectedStateVersion);
    if (
      row.draft_revision !== parsed.expectedRevision ||
      row.draft_fingerprint !== parsed.expectedFingerprint
    )
      throw new EditorialError("CATALOG_DELIVERY_DRAFT_CHANGED", 409);
    const latest = await currentDraft(req, row);
    if (!row.recipe_manifest_sha256) return requireCatalogDeliveryBackend();
    if (row.state !== "release_requested")
      throw new EditorialError("CATALOG_RELEASE_NOT_REQUESTED", 409);
    const proof = await readCatalogReadiness(row.id);
    if (
      proof.intentId !== row.id ||
      proof.manifestSha256 !== row.media_manifest_sha256 ||
      proof.recipeManifestSha256 !== row.recipe_manifest_sha256 ||
      proof.stateVersion !== row.state_version ||
      proof.mediaCount !== row.media_manifest.length ||
      !proof.privateReady ||
      !proof.publicReady
    )
      throw new EditorialError("CATALOG_DELIVERY_PENDING", 409);
    await withCatalogDeliveryPublish(
      req,
      { intentId: row.id, fingerprint: row.draft_fingerprint },
      async () => {
        if (isOwner(req))
          return req.payload.update({
            collection: "catalogs",
            id: row.catalog_document_id,
            req,
            user: req.user,
            overrideAccess: false,
            overrideLock: false,
            draft: false,
            depth: 0,
            data: {
              ...payloadContentData(publishedContent(latest)),
              revision: row.draft_revision,
              _status: "published",
            },
          });
        return publishApproved(req, {
          id: row.catalog_document_id,
          approvalId: parsed.approvalId!,
          idempotencyKey: publishKey,
        });
      },
    );
    const db = await editorialTransaction(req);
    await db.execute(
      sql`UPDATE catalog_delivery_intents SET state='released',state_version=state_version+1,release_proof_sha256=${proof.proofSha256},updated_at=now() WHERE id=${row.id}::uuid AND state_version=${parsed.expectedStateVersion}`,
    );
    return intentByID(req, row.id);
  });
};

export const cancelCatalogDelivery = async (
  req: PayloadRequest,
  input: unknown,
) => {
  const actor = requireActor(req);
  const parsed = parse(cancelCatalogDeliverySchema, input);
  return mutation(req, parsed.idempotencyKey, "cancel", parsed, async () => {
    const row = await lockedIntent(req, parsed.intentId);
    if (!isOwner(req) && row.actor_id !== actor.id)
      throw new EditorialError("CATALOG_DELIVERY_CANCEL_FORBIDDEN", 403);
    expectState(row, parsed.expectedStateVersion);
    const db = await editorialTransaction(req);
    await db.execute(sql`
      UPDATE catalog_delivery_intents SET state = 'cancelled', state_version = state_version + 1,
        ended_at = now(), end_reason = 'CANCELLED', updated_at = now()
      WHERE id = ${row.id}::uuid AND state_version = ${parsed.expectedStateVersion}
    `);
    return intentByID(req, row.id);
  });
};

/** Native writes and endpoint mutations share the document transaction lock.
 * Tombstones remain durable after version pruning, retries and republishing.
 */
export const invalidateCatalogDelivery = async (
  req: PayloadRequest,
  documentID: number,
  reason: "DRAFT_CHANGED" | "WITHDRAWN" | "PUBLISHED",
) => {
  const db = await editorialTransaction(req);
  await db.execute(sql`
    UPDATE catalog_delivery_intents SET state = ${reason === "WITHDRAWN" ? "withdrawn" : "superseded"},
      state_version = state_version + 1, ended_at = now(), end_reason = ${reason}, updated_at = now()
    WHERE catalog_document_id = ${documentID}
      AND id <> ${catalogDeliveryPublishProof(req)?.intentId ?? "00000000-0000-0000-0000-000000000000"}::uuid
      AND (state IN ('prepared', 'release_requested')
        OR (${reason === "WITHDRAWN" || reason === "PUBLISHED"} AND state = 'released'))
  `);
};

export const assertCatalogDeliveryPublication = (
  content: EditorialDraft,
  req?: PayloadRequest,
) => {
  if (
    req &&
    catalogDeliveryPublishProof(req)?.fingerprint ===
      contentFingerprint(content)
  )
    return;
  if (content.media.some(({ objectKey }) => objectKey.startsWith("editorial/")))
    throw new EditorialError("CATALOG_DELIVERY_PREPARATION_REQUIRED", 409);
};
