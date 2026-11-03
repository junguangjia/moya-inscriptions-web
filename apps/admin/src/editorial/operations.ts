import {
  editorialApproveBatchSchema,
  editorialPublishApprovedSchema,
  editorialReadDraftSchema,
  editorialRestoreDraftSchema,
  editorialSaveDraftSchema,
  EDITORIAL_FIELD_NAMES,
} from "@moya/contracts/internal/editorial";
import { restoreVersionOperation, type PayloadRequest } from "payload";
import type { EditorialReceipt } from "../payload-types";

import { isAutomation, actsAsOwner, requireActor } from "./access";
import { relationshipID } from "./collections";
import {
  contentFingerprint,
  draftContent,
  publishedContent,
  payloadContentData,
  requestFingerprint,
} from "./content";
import { EditorialError, validationError } from "./errors";
import { withApprovedPublish, withLedgerWrite } from "./state";
import { lockEditorialKey, withEditorialTransaction } from "./transaction";

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

const editableDocument = async (req: PayloadRequest, id: number | string) => {
  requireActor(req);
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

const numericID = (value: unknown): number => {
  const id =
    typeof value === "string" && /^[1-9]\d*$/.test(value)
      ? Number(value)
      : value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
    throw new EditorialError("RECORD_ID_INVALID", 400);
  }
  return id;
};

const documentResult = (document: { id: unknown; revision?: unknown }) => ({
  id: numericID(document.id),
  revision: Number(document.revision),
  fingerprint: contentFingerprint(document),
});

type MutationResult = ReturnType<typeof documentResult> & {
  replayed?: boolean;
};
type ReceiptOperation = "save-draft" | "publish-approved";

const receiptFor = async (req: PayloadRequest, deduplicationKey: string) => {
  const { docs } = await req.payload.find({
    collection: "editorial-receipts",
    where: { deduplicationKey: { equals: deduplicationKey } },
    limit: 1,
    depth: 0,
    req,
    user: req.user,
    overrideAccess: false,
  });
  return docs[0];
};

const replay = (
  receipt: EditorialReceipt,
  fingerprint: string,
): MutationResult => {
  if (receipt.requestFingerprint !== fingerprint)
    throw new EditorialError("IDEMPOTENCY_CONFLICT", 409);
  if (receipt.status !== "completed") {
    throw new EditorialError(
      String(receipt.errorCode ?? "OPERATION_REJECTED"),
      409,
    );
  }
  return {
    id: numericID(relationshipID(receipt.catalog)),
    revision: Number(receipt.revision),
    fingerprint: String(receipt.fingerprint),
    replayed: true,
  };
};

const idempotentMutation = async (
  req: PayloadRequest,
  idempotencyKey: string,
  fingerprint: string,
  operation: ReceiptOperation,
  work: () => Promise<MutationResult>,
): Promise<MutationResult> => {
  const actor = requireActor(req);
  const deduplicationKey = requestFingerprint([req.user?.id, idempotencyKey]);
  try {
    return await withEditorialTransaction(req, async () => {
      await lockEditorialKey(req, `receipt:${deduplicationKey}`);
      const prior = await receiptFor(req, deduplicationKey);
      if (prior) return replay(prior, fingerprint);
      const result = await work();
      await withLedgerWrite(req, () =>
        req.payload.create({
          collection: "editorial-receipts",
          overrideAccess: false,
          req,
          user: req.user,
          data: {
            deduplicationKey,
            requestFingerprint: fingerprint,
            actor: actor.id,
            operation,
            status: "completed",
            catalog: result.id,
            revision: result.revision,
            fingerprint: result.fingerprint,
          },
        }),
      );
      return { ...result, replayed: false };
    });
  } catch (error) {
    // A failed Payload write rolls back its whole transaction. Persist only a
    // sanitized rejection in a fresh transaction; never append after rollback.
    if (
      !req.transactionID &&
      error instanceof EditorialError &&
      error.code !== "IDEMPOTENCY_CONFLICT"
    ) {
      await withEditorialTransaction(req, async () => {
        await lockEditorialKey(req, `receipt:${deduplicationKey}`);
        if (await receiptFor(req, deduplicationKey)) return;
        await withLedgerWrite(req, () =>
          req.payload.create({
            collection: "editorial-receipts",
            overrideAccess: false,
            req,
            user: req.user,
            data: {
              deduplicationKey,
              requestFingerprint: fingerprint,
              actor: actor.id,
              operation,
              status: "rejected",
              errorCode: error.code,
            },
          }),
        );
      });
    }
    throw error;
  }
};

export const readDraft = async (req: PayloadRequest, input: unknown) => {
  const { id } = parse(editorialReadDraftSchema, input);
  const document = await editableDocument(req, id);
  return { ...documentResult(document), content: draftContent(document) };
};

export const saveDraft = async (req: PayloadRequest, input: unknown) => {
  requireActor(req);
  const parsed = parse(editorialSaveDraftSchema, input);
  // Validation supplies defaults; only explicitly supplied keys are update
  // intentions. Omitting a relation array must not clear an existing array.
  const rawContent = (input as { content: Record<string, unknown> }).content;
  const patch = Object.fromEntries(
    EDITORIAL_FIELD_NAMES.filter((key) => Object.hasOwn(rawContent, key)).map(
      (key) => [key, parsed.content[key]],
    ),
  );
  const fingerprint = requestFingerprint({
    operation: "save-draft",
    ...parsed,
    content: patch,
  });
  return idempotentMutation(
    req,
    parsed.idempotencyKey,
    fingerprint,
    "save-draft",
    async () => {
      if (parsed.id === undefined) {
        if (
          parsed.expectedRevision !== undefined &&
          parsed.expectedRevision !== 0
        ) {
          throw new EditorialError("REVISION_CONFLICT", 409);
        }
        const document = await req.payload.create({
          collection: "catalogs",
          data: {
            ...payloadContentData(parsed.content),
            _status: "draft",
            revision: 0,
          },
          draft: true,
          depth: 0,
          req,
          user: req.user,
          overrideAccess: false,
        });
        return documentResult(document);
      }
      if (parsed.expectedRevision === undefined)
        throw new EditorialError("REVISION_REQUIRED", 409);
      const document = await req.payload.update({
        collection: "catalogs",
        id: parsed.id,
        data: { ...patch, revision: parsed.expectedRevision, _status: "draft" },
        draft: true,
        depth: 0,
        overrideAccess: false,
        overrideLock: false,
        req,
        user: req.user,
      });
      return documentResult(document);
    },
  );
};

export const approveBatch = async (req: PayloadRequest, input: unknown) => {
  if (!actsAsOwner(req)) throw new EditorialError("APPROVAL_OWNER_ONLY", 403);
  const parsed = parse(editorialApproveBatchSchema, input);
  const approval = await req.payload.create({
    collection: "editorial-approvals",
    depth: 0,
    req,
    user: req.user,
    overrideAccess: false,
    data: {
      label: parsed.label ?? "Approved editorial batch",
      automationUser: numericID(parsed.automationUserId),
      status: "active",
      items: parsed.items.map(({ id, revision }) => ({
        catalog: numericID(id),
        revision,
      })),
    },
  });
  return {
    approvalId: approval.id,
    itemCount: parsed.items.length,
    status: approval.status,
  };
};

export const publishApproved = async (req: PayloadRequest, input: unknown) => {
  requireActor(req);
  const parsed = parse(editorialPublishApprovedSchema, input);
  const fingerprint = requestFingerprint({
    operation: "publish-approved",
    ...parsed,
  });
  return idempotentMutation(
    req,
    parsed.idempotencyKey,
    fingerprint,
    "publish-approved",
    async () => {
      // The order is receipt -> approval -> document for this single item. Native
      // approval revocation takes only the approval lock; batch approval creation
      // locks its documents in sorted order and never takes an existing approval.
      await lockEditorialKey(req, `approval:${String(parsed.approvalId)}`);
      const approval = await req.payload.findByID({
        collection: "editorial-approvals",
        id: parsed.approvalId,
        depth: 0,
        req,
        user: req.user,
        overrideAccess: false,
      });
      if (approval.status !== "active")
        throw new EditorialError("APPROVAL_REVOKED", 409);
      if (
        isAutomation(req) &&
        String(relationshipID(approval.automationUser)) !== String(req.user?.id)
      ) {
        throw new EditorialError("APPROVAL_ACCOUNT_INVALID", 403);
      }
      const items = approval.items as Record<string, unknown>[];
      const item = items.find(
        (candidate) =>
          String(relationshipID(candidate.catalog)) === String(parsed.id),
      );
      if (!item) throw new EditorialError("RECORD_NOT_APPROVED", 403);
      await lockEditorialKey(req, `document:${String(parsed.id)}`);
      const latest = await editableDocument(req, parsed.id);
      if (
        latest.revision !== item.revision ||
        contentFingerprint(latest) !== item.fingerprint
      ) {
        throw new EditorialError("APPROVED_REVISION_CHANGED", 409);
      }
      const content = publishedContent(latest);
      const document = await withApprovedPublish(req, () =>
        req.payload.update({
          collection: "catalogs",
          id: parsed.id,
          data: {
            ...payloadContentData(content),
            revision: Number(latest.revision),
            _status: "published",
          },
          draft: false,
          depth: 0,
          overrideAccess: false,
          overrideLock: false,
          req,
          user: req.user,
        }),
      );
      return documentResult(document);
    },
  );
};

export const restoreDraft = async (req: PayloadRequest, input: unknown) => {
  if (!actsAsOwner(req)) throw new EditorialError("RESTORE_OWNER_ONLY", 403);
  const parsed = parse(editorialRestoreDraftSchema, input);
  const originalExpected = req.query.expectedRevision;
  req.query.expectedRevision = String(parsed.expectedRevision);
  try {
    // Payload 3.88's Local API wrapper drops options.draft. The public exported
    // operation is also used by its native REST handler and forwards it intact.
    const document = await restoreVersionOperation({
      collection: req.payload.collections.catalogs,
      id: String(parsed.versionId),
      draft: true,
      depth: 0,
      req,
      overrideAccess: false,
    });
    return documentResult(document);
  } finally {
    if (originalExpected === undefined) delete req.query.expectedRevision;
    else req.query.expectedRevision = originalExpected;
  }
};
