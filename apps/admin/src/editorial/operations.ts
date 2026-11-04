import {
  editorialApproveBatchSchema,
  editorialPublishApprovedSchema,
  editorialReadDraftSchema,
  editorialRestoreDraftSchema,
  editorialSaveDraftSchema,
  EDITORIAL_FIELD_NAMES,
} from "@moya/contracts/internal/editorial";
import {
  restoreVersionOperation,
  ValidationError,
  type PayloadRequest,
} from "payload";
import type { EditorialReceipt } from "../payload-types";

import {
  isAiOperator,
  isAutomation,
  actsAsOwner,
  requireActor,
} from "./access";
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
import {
  collectingSupersededIntents,
  isMissingRecord,
  lockEditorialKey,
  ReplayedEditorialError,
  withEditorialTransaction,
  writesRejectedReceipt,
} from "./transaction";

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
  } catch (error) {
    if (isMissingRecord(error))
      throw new EditorialError("RECORD_UNAVAILABLE", 404);
    throw error;
  }
};

/**
 * A create that reaches an existing record. The record's own identity bindings let
 * it through claimEditorialIdentities, then a unique index refuses it, and Payload
 * words that as a field refusal although the content is fine. A Catalog cannot be
 * hard-deleted, so the same command meets this again: it keeps a rejected receipt.
 */
const isIdentityTaken = (error: unknown): boolean =>
  error instanceof ValidationError &&
  error.data.errors.some(
    ({ path }) => path === "catalogId" || path === "sourceId",
  );

export const numericID = (value: unknown): number => {
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
  /** Omitted when none, and on a replay: a receipt does not keep them. */
  supersededIntents?: readonly string[];
};
type ReceiptOperation = EditorialReceipt["operation"];

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

/** What a stored receipt answers to a repeat of its key, before its result. */
const assertSameCommand = (receipt: EditorialReceipt, fingerprint: string) => {
  if (receipt.requestFingerprint !== fingerprint)
    throw new EditorialError("IDEMPOTENCY_CONFLICT", 409);
  if (receipt.status !== "completed")
    throw new ReplayedEditorialError(
      String(receipt.errorCode ?? "OPERATION_REJECTED"),
    );
};

/**
 * One command under one key: the same key replays, a changed command conflicts, and
 * the receipt commits with the work. `recorded` says what the receipt keeps and
 * `replayFrom` what it answers later.
 */
export const receiptedCommand = async <Result extends object>(
  req: PayloadRequest,
  idempotencyKey: string,
  fingerprint: string,
  operation: ReceiptOperation,
  work: () => Promise<Result>,
  recorded: (
    result: Result,
  ) => Pick<
    Partial<EditorialReceipt>,
    "catalog" | "article" | "articleCollection" | "revision" | "fingerprint"
  >,
  replayFrom: (receipt: EditorialReceipt) => Result | Promise<Result>,
): Promise<Result & { replayed: boolean }> => {
  const actor = requireActor(req);
  const deduplicationKey = requestFingerprint([req.user?.id, idempotencyKey]);
  try {
    return await withEditorialTransaction(req, async () => {
      await lockEditorialKey(req, `receipt:${deduplicationKey}`);
      const prior = await receiptFor(req, deduplicationKey);
      if (prior) {
        assertSameCommand(prior, fingerprint);
        return { ...(await replayFrom(prior)), replayed: true };
      }
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
            ...recorded(result),
          },
        }),
      );
      return { ...result, replayed: false };
    });
  } catch (error) {
    // A failed Payload write rolls back its whole transaction. Persist only a
    // sanitized rejection in a fresh transaction; never append after rollback.
    // The rejection is the answer whether or not its receipt lands: with no
    // receipt, a retry meets it again.
    if (!req.transactionID && writesRejectedReceipt(error)) {
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
      }).catch(() => undefined);
    }
    throw error;
  }
};

const idempotentMutation = (
  req: PayloadRequest,
  idempotencyKey: string,
  fingerprint: string,
  operation: ReceiptOperation,
  work: () => Promise<MutationResult>,
): Promise<MutationResult> =>
  receiptedCommand(
    req,
    idempotencyKey,
    fingerprint,
    operation,
    work,
    ({ id, revision, fingerprint: stored }) => ({
      catalog: id,
      revision,
      fingerprint: stored,
    }),
    (receipt) => ({
      id: numericID(relationshipID(receipt.catalog)),
      revision: Number(receipt.revision),
      fingerprint: String(receipt.fingerprint),
    }),
  );

export const readDraft = async (req: PayloadRequest, input: unknown) => {
  const { id } = parse(editorialReadDraftSchema, input);
  const document = await editableDocument(req, id);
  return { ...documentResult(document), content: draftContent(document) };
};

/**
 * One draft edit of the fields in `patch`, under the revision the caller read. Hooks
 * check that revision, the identities, the media and the content, and keep
 * overrideLock false. Payload merges what is left out from the latest version.
 */
export const writeDraftPatch = async (
  req: PayloadRequest,
  id: number | string,
  expectedRevision: number,
  patch: Readonly<Record<string, unknown>>,
) => {
  const { saved, superseded } = await collectingSupersededIntents(req, () =>
    req.payload.update({
      collection: "catalogs",
      id,
      data: { ...patch, revision: expectedRevision, _status: "draft" },
      draft: true,
      depth: 0,
      overrideAccess: false,
      overrideLock: false,
      req,
      user: req.user,
    }),
  );
  return {
    ...documentResult(saved),
    ...(superseded.length > 0 ? { supersededIntents: superseded } : {}),
  };
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
        try {
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
        } catch (error) {
          if (isIdentityTaken(error))
            throw new EditorialError("IDENTITY_ALREADY_BOUND", 409, [
              "catalogId",
              "sourceId",
            ]);
          throw error;
        }
      }
      const { id, expectedRevision } = parsed;
      if (expectedRevision === undefined)
        throw new EditorialError("REVISION_REQUIRED", 409);
      return writeDraftPatch(req, id, expectedRevision, patch);
    },
  );
};

export const approveBatch = async (req: PayloadRequest, input: unknown) => {
  if (!actsAsOwner(req)) throw new EditorialError("APPROVAL_OWNER_ONLY", 403);
  const parsed = parse(editorialApproveBatchSchema, input);
  const approval = await withEditorialTransaction(req, () =>
    req.payload.create({
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
    }),
  );
  return {
    approvalId: approval.id,
    itemCount: parsed.items.length,
    status: approval.status,
  };
};

const APPROVAL_RECEIPT = "approval:";

interface ApprovalAnswer {
  readonly approvalId: number | string;
  readonly itemCount: number;
  readonly status: unknown;
}

/**
 * Approving under a key, for a caller that can lose an answer: the route has none, so
 * a retry would leave a second active approval (section 17). A receipt holds no
 * approval column and the amendment lists none, so its fingerprint names the batch,
 * and a replay reads what that batch says now: a revoked one never reads as active.
 */
export const approvalOnce = (
  req: PayloadRequest,
  idempotencyKey: string,
  command: { operation: ReceiptOperation; parsed: object },
  collection: "editorial-approvals" | "editorial-article-approvals",
  work: () => Promise<ApprovalAnswer>,
): Promise<ApprovalAnswer & { replayed: boolean }> =>
  receiptedCommand(
    req,
    idempotencyKey,
    requestFingerprint(command),
    command.operation,
    work,
    ({ approvalId }) => ({
      fingerprint: `${APPROVAL_RECEIPT}${String(approvalId)}`,
    }),
    async ({ fingerprint }) => {
      const approvalId = numericID(
        String(fingerprint).slice(APPROVAL_RECEIPT.length),
      );
      const { items, status } = await req.payload.findByID({
        collection,
        id: approvalId,
        depth: 0,
        overrideAccess: false,
        req,
        user: req.user,
      });
      return { approvalId, itemCount: items.length, status };
    },
  );

export const approveBatchOnce = (
  req: PayloadRequest,
  idempotencyKey: string,
  input: unknown,
) =>
  approvalOnce(
    req,
    idempotencyKey,
    {
      operation: "approve-batch",
      parsed: parse(editorialApproveBatchSchema, input),
    },
    "editorial-approvals",
    () => approveBatch(req, input),
  );

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
        // Publishing moves the revision and keeps the content, so a retry under
        // a new key after a success finds exactly what it approved already live.
        if (
          latest._status === "published" &&
          contentFingerprint(latest) === item.fingerprint
        )
          throw new EditorialError("ALREADY_PUBLISHED", 409);
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

type VersionedSlug = "catalogs" | "articles" | "article-collections";

/**
 * A restore has no lock check of its own (payload
 * dist/collections/operations/restoreVersion.js), unlike the update every other write
 * goes through. So an AI key meets a document someone else has open here, as it would
 * there; the Owner's button stays as it was.
 */
const refuseAnotherHolder = async (
  req: PayloadRequest,
  slug: VersionedSlug,
  versionId: number | string,
) => {
  const { docs } = await req.payload.db.findVersions({
    collection: slug,
    limit: 1,
    pagination: false,
    req,
    where: { id: { equals: versionId } },
  });
  const parent = docs[0]?.parent;
  if (!parent) return;
  const { docs: locks } = await req.payload.find({
    collection: "payload-locked-documents",
    where: {
      and: [
        { "document.relationTo": { equals: slug } },
        { "document.value": { equals: parent } },
      ],
    },
    sort: "-updatedAt",
    depth: 0,
    limit: 1,
    pagination: false,
    overrideAccess: false,
    req,
    user: req.user,
  });
  const lock = locks[0];
  const setting = req.payload.collections[slug].config.lockDocuments;
  const seconds =
    typeof setting === "object" && setting !== null ? setting.duration : 300;
  if (
    lock &&
    lock.user?.value !== req.user?.id &&
    Date.now() - Date.parse(lock.updatedAt) <= seconds * 1000
  )
    throw new EditorialError("DOCUMENT_LOCKED", 423);
};

/**
 * A past version as a new draft, under the revision the caller read. The collection's
 * own hook keeps automation out, and checks the revision.
 */
export const restoreVersionAsDraft = async (
  req: PayloadRequest,
  slug: VersionedSlug,
  versionId: number | string,
  expectedRevision: number,
) => {
  const originalExpected = req.query.expectedRevision;
  req.query.expectedRevision = String(expectedRevision);
  try {
    // Payload 3.88's Local API wrapper drops options.draft. The public exported
    // operation is also used by its native REST handler and forwards it intact.
    return await withEditorialTransaction(req, async () => {
      if (isAiOperator(req)) await refuseAnotherHolder(req, slug, versionId);
      return restoreVersionOperation({
        collection: req.payload.collections[slug],
        id: String(versionId),
        draft: true,
        depth: 0,
        req,
        overrideAccess: false,
      });
    });
  } finally {
    if (originalExpected === undefined) delete req.query.expectedRevision;
    else req.query.expectedRevision = originalExpected;
  }
};

export const restoreDraft = async (req: PayloadRequest, input: unknown) => {
  if (!actsAsOwner(req)) throw new EditorialError("RESTORE_OWNER_ONLY", 403);
  const parsed = parse(editorialRestoreDraftSchema, input);
  return documentResult(
    await restoreVersionAsDraft(
      req,
      "catalogs",
      parsed.versionId,
      parsed.expectedRevision,
    ),
  );
};

/** A restore under a key: a repeat after a lost answer replays, and never conflicts. */
export const restoreDraftOnce = (
  req: PayloadRequest,
  idempotencyKey: string,
  input: unknown,
) =>
  idempotentMutation(
    req,
    idempotencyKey,
    requestFingerprint({
      operation: "restore-draft",
      ...parse(editorialRestoreDraftSchema, input),
    }),
    "restore-draft",
    () => restoreDraft(req, input),
  );
