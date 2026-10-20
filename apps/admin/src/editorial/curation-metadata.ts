import { createHash } from "node:crypto";
import { sql } from "@payloadcms/db-postgres";
import {
  decodeCurationMetadata,
  deriveCurationMetadataCounts,
  verifyCurationMetadataAnnotationHashes,
  readCurationMetadataSchema,
  saveCurationMetadataSchema,
  type CurationMetadata,
  type CurationMetadataResponse,
} from "@moya/contracts/internal/editorial";
import { APIError, Forbidden, NotFound, type PayloadRequest } from "payload";
import type { Catalog, EditorialReceipt } from "../payload-types";

import { canEditCatalog, requireActor } from "./access";
import { relationshipID } from "./collections";
import {
  contentFingerprint,
  draftContent,
  requestFingerprint,
} from "./content";
import { EditorialError, validationError } from "./errors";
import { withLedgerWrite } from "./state";
import {
  editorialTransaction,
  lockEditorialKey,
  withEditorialTransaction,
} from "./transaction";

const operation = "save-curation-metadata" as const;
const digest = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const validateAnnotationHashes = (snapshot: CurationMetadata) => {
  if (!verifyCurationMetadataAnnotationHashes(snapshot, digest))
    throw new EditorialError("CURATION_METADATA_ANNOTATION_HASH_MISMATCH", 400);
};
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
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw validationError(parsed.error.issues);
  return parsed.data;
};

const catalogStorageRead = async <T>(read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    if (
      error instanceof NotFound ||
      error instanceof Forbidden ||
      (error instanceof APIError &&
        (error.status === 403 || error.status === 404))
    )
      throw new EditorialError("RECORD_UNAVAILABLE", 404);
    throw new EditorialError("CURATION_METADATA_STORAGE_UNAVAILABLE", 503);
  }
};

const catalog = async (
  req: PayloadRequest,
  id: number | string,
  catalogId: string,
): Promise<Catalog> => {
  requireActor(req);
  if (!canEditCatalog(req, catalogId))
    throw new EditorialError("CURATION_METADATA_SCOPE_DENIED", 403);
  const document = await catalogStorageRead(() =>
    req.payload.findByID({
      collection: "catalogs",
      id,
      draft: true,
      depth: 0,
      req,
      user: req.user,
      overrideAccess: false,
    }),
  );
  if (document.catalogId !== catalogId)
    throw new EditorialError("CURATION_METADATA_IDENTITY_CONFLICT", 409);
  return document;
};

/** Only these two global head scalars are read outside actor-scoped receipts. */
const globalHead = async (req: PayloadRequest, catalogId: string) => {
  const db = await editorialTransaction(req);
  const result = await db.execute(sql`
    SELECT metadata_sha256, metadata_version
      FROM public.editorial_receipts
     WHERE metadata_catalog_id = ${catalogId}
       AND operation = 'save-curation-metadata'
       AND status = 'completed'
       AND metadata_sha256 IS NOT NULL AND metadata_version IS NOT NULL
     ORDER BY metadata_version DESC LIMIT 1
  `);
  const row = result.rows[0] as
    { metadata_sha256: unknown; metadata_version: unknown } | undefined;
  if (!row) return null;
  const version = Number(row.metadata_version);
  if (
    typeof row.metadata_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.metadata_sha256) ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    throw new EditorialError("CURATION_METADATA_STORAGE_INVALID", 503);
  return { sha256: row.metadata_sha256, version };
};

const visibleReceipt = async (
  req: PayloadRequest,
  catalogId: string,
  sha256: string,
): Promise<EditorialReceipt | undefined> => {
  const result = await req.payload.find({
    collection: "editorial-receipts",
    where: {
      and: [
        { operation: { equals: operation } },
        { status: { equals: "completed" } },
        { metadataCatalogId: { equals: catalogId } },
        { metadataSha256: { equals: sha256 } },
      ],
    },
    limit: 1,
    depth: 0,
    req,
    user: req.user,
    overrideAccess: false,
  });
  return result.docs[0];
};

const baselineMatches = (
  document: Catalog,
  snapshot: CurationMetadata,
): boolean => {
  const baseline = snapshot.draftBaseline;
  let content: ReturnType<typeof draftContent>;
  let fingerprint: string;
  try {
    content = draftContent(document);
    fingerprint = contentFingerprint(document);
  } catch (error) {
    // An independently validated historical artifact remains readable when
    // only the current Draft fails its content schema. Other failures propagate.
    if (error instanceof EditorialError && error.code === "CONTENT_INVALID")
      return false;
    throw error;
  }
  const representatives = content.media.filter(
    (media) => media.isRepresentative,
  );
  return (
    String(document.id) === String(baseline.id) &&
    document.catalogId === snapshot.catalogId &&
    document.sourceId === snapshot.sourceId &&
    document._status === "draft" &&
    document.revision === baseline.revision &&
    fingerprint === baseline.fingerprint &&
    JSON.stringify(content.media.map((media) => media.mediaId)) ===
      JSON.stringify(baseline.displayMediaIds) &&
    representatives.length <= 1 &&
    (representatives[0]?.mediaId ?? null) === baseline.coverMediaId
  );
};

const response = (
  receipt: EditorialReceipt,
  document: Catalog,
  head: Awaited<ReturnType<typeof globalHead>>,
  replayed?: boolean,
): CurationMetadataResponse => {
  const text = receipt.metadataJson;
  const sha256 = receipt.metadataSha256;
  if (
    typeof text !== "string" ||
    typeof sha256 !== "string" ||
    digest(text) !== sha256 ||
    receipt.operation !== operation ||
    receipt.status !== "completed" ||
    String(relationshipID(receipt.catalog)) !== String(document.id) ||
    !Number.isSafeInteger(receipt.metadataVersion) ||
    Number(receipt.metadataVersion) < 1
  )
    throw new EditorialError("CURATION_METADATA_INTEGRITY_FAILED", 503);
  let snapshot: CurationMetadata;
  try {
    snapshot = decodeCurationMetadata(text);
    validateAnnotationHashes(snapshot);
  } catch {
    throw new EditorialError("CURATION_METADATA_INTEGRITY_FAILED", 503);
  }
  if (
    snapshot.catalogId !== receipt.metadataCatalogId ||
    snapshot.catalogId !== document.catalogId ||
    String(snapshot.draftBaseline.id) !== String(document.id) ||
    snapshot.draftBaseline.revision !== receipt.revision ||
    snapshot.draftBaseline.fingerprint !== receipt.fingerprint
  )
    throw new EditorialError("CURATION_METADATA_INTEGRITY_FAILED", 503);
  return {
    id: receipt.id,
    catalogId: snapshot.catalogId,
    snapshotSha256: sha256,
    payloadJSON: text,
    previousSha256: receipt.previousMetadataSha256 ?? null,
    createdAt: receipt.createdAt,
    current:
      head?.sha256 === sha256 &&
      head.version === receipt.metadataVersion &&
      baselineMatches(document, snapshot),
    counts: deriveCurationMetadataCounts(snapshot),
    ...(replayed === undefined ? {} : { replayed }),
  };
};

const validateMedia = async (
  req: PayloadRequest,
  snapshot: CurationMetadata,
) => {
  const { docs } = await req.payload.find({
    collection: "media",
    where: {
      and: [
        { catalogId: { equals: snapshot.catalogId } },
        { mediaId: { in: snapshot.photos.map((photo) => photo.mediaId) } },
      ],
    },
    limit: snapshot.photos.length,
    pagination: false,
    depth: 0,
    req,
    user: req.user,
    overrideAccess: false,
  });
  const byId = new Map(docs.map((media) => [media.mediaId, media]));
  if (
    docs.length !== snapshot.photos.length ||
    snapshot.photos.some((photo) => {
      const media = byId.get(photo.mediaId);
      return (
        !media ||
        String(media.id) !== String(photo.nativeId) ||
        media.catalogId !== snapshot.catalogId ||
        media.sha256 !== photo.uploadedSha256
      );
    })
  )
    throw new EditorialError("CURATION_METADATA_MEDIA_CONFLICT", 409);
};

/** No rejected ledger row is persisted: transient failures can safely retry. */
const storageOperation = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof EditorialError) throw error;
    let cause: unknown = error;
    let code: unknown;
    for (
      let depth = 0;
      depth < 5 && cause && typeof cause === "object";
      depth++
    ) {
      code = Reflect.get(cause, "code");
      if (code !== undefined) break;
      cause = Reflect.get(cause, "cause");
    }
    if (code === "23505")
      throw new EditorialError("CURATION_METADATA_REVISION_CONFLICT", 409);
    throw new EditorialError("CURATION_METADATA_STORAGE_UNAVAILABLE", 503);
  }
};

export const saveCurationMetadata = async (
  req: PayloadRequest,
  input: unknown,
) => {
  const actor = requireActor(req);
  const parsed = parse(saveCurationMetadataSchema, input);
  const snapshot = decodeCurationMetadata(parsed.payloadJSON);
  if (digest(parsed.payloadJSON) !== parsed.snapshotSha256)
    throw new EditorialError("CURATION_METADATA_HASH_MISMATCH", 400);
  validateAnnotationHashes(snapshot);
  await catalog(req, snapshot.draftBaseline.id, snapshot.catalogId);
  return storageOperation(() =>
    withEditorialTransaction(req, async () => {
      await lockEditorialKey(req, `curation-metadata:${snapshot.catalogId}`);
      await lockEditorialKey(
        req,
        `document:${String(snapshot.draftBaseline.id)}`,
      );
      const document = await catalog(
        req,
        snapshot.draftBaseline.id,
        snapshot.catalogId,
      );
      const head = await globalHead(req, snapshot.catalogId);
      const existing = await visibleReceipt(
        req,
        snapshot.catalogId,
        parsed.snapshotSha256,
      );
      if (existing) {
        if (existing.metadataJson !== parsed.payloadJSON)
          throw new EditorialError("IDEMPOTENCY_CONFLICT", 409);
        // Replays preserve the committed artifact even if the old baseline moved.
        // The independently checked `current` flag still reports that movement.
        return response(existing, document, head, true);
      }
      if (head?.sha256 === parsed.snapshotSha256)
        throw new EditorialError("CURATION_METADATA_NOT_AVAILABLE", 409);
      if ((head?.sha256 ?? null) !== parsed.expectedPreviousSha256)
        throw new EditorialError("CURATION_METADATA_REVISION_CONFLICT", 409);
      if (!baselineMatches(document, snapshot))
        throw new EditorialError("CURATION_METADATA_BASELINE_CONFLICT", 409);
      await validateMedia(req, snapshot);
      const version = (head?.version ?? 0) + 1;
      if (!Number.isSafeInteger(version))
        throw new EditorialError("CURATION_METADATA_STORAGE_INVALID", 503);
      const receipt = await withLedgerWrite(req, () =>
        req.payload.create({
          collection: "editorial-receipts",
          req,
          user: req.user,
          overrideAccess: false,
          data: {
            deduplicationKey: requestFingerprint([
              actor.id,
              operation,
              snapshot.catalogId,
              parsed.snapshotSha256,
            ]),
            requestFingerprint: parsed.snapshotSha256,
            actor: actor.id,
            operation,
            status: "completed",
            catalog: document.id,
            revision: snapshot.draftBaseline.revision,
            fingerprint: contentFingerprint(document),
            metadataJson: parsed.payloadJSON,
            metadataSha256: parsed.snapshotSha256,
            metadataCatalogId: snapshot.catalogId,
            previousMetadataSha256: parsed.expectedPreviousSha256,
            metadataVersion: version,
          },
        }),
      );
      return response(
        receipt,
        document,
        { sha256: parsed.snapshotSha256, version },
        false,
      );
    }),
  );
};

export const readCurationMetadata = async (
  req: PayloadRequest,
  input: unknown,
) => {
  requireActor(req);
  const parsed = parse(readCurationMetadataSchema, input);
  if (!canEditCatalog(req, parsed.catalogId))
    throw new EditorialError("CURATION_METADATA_SCOPE_DENIED", 403);
  const found = await catalogStorageRead(() =>
    req.payload.find({
      collection: "catalogs",
      where: { catalogId: { equals: parsed.catalogId } },
      limit: 1,
      draft: true,
      depth: 0,
      req,
      user: req.user,
      overrideAccess: false,
    }),
  );
  if (!found.docs[0]) throw new EditorialError("RECORD_UNAVAILABLE", 404);
  const id = found.docs[0].id;
  await catalog(req, id, parsed.catalogId);
  return storageOperation(() =>
    withEditorialTransaction(req, async () => {
      await lockEditorialKey(req, `curation-metadata:${parsed.catalogId}`);
      await lockEditorialKey(req, `document:${String(id)}`);
      const document = await catalog(req, id, parsed.catalogId);
      const head = await globalHead(req, parsed.catalogId);
      const target = parsed.snapshotSha256 ?? head?.sha256;
      const receipt =
        target && (await visibleReceipt(req, parsed.catalogId, target));
      if (!receipt)
        throw new EditorialError("CURATION_METADATA_NOT_AVAILABLE", 404);
      return response(receipt, document, head);
    }),
  );
};
