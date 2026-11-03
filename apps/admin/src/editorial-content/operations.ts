/**
 * REST operations extending the editorial batch mechanism to Articles:
 * scoped draft saving, exact-revision Owner approval and approval-bound
 * publication by automation. Receipts reuse `editorial-receipts` (operation
 * `publish-approved`, naming the Article); an identical retry replays its result
 * and a different command under the same key conflicts.
 */
import {
  editorialArticleApproveBatchSchema,
  editorialArticlePublishApprovedSchema,
  editorialArticleSaveDraftSchema,
} from "@moya/contracts/internal/editorial";
import type { PayloadRequest } from "payload";

import { isAutomation, actsAsOwner, requireActor } from "../editorial/access";
import { relationshipID } from "../editorial/collections";
import { requestFingerprint } from "../editorial/content";
import { EditorialError, validationError } from "../editorial/errors";
import { withApprovedPublish, withLedgerWrite } from "../editorial/state";
import {
  lockEditorialKey,
  ReplayedEditorialError,
  withEditorialTransaction,
  writesRejectedReceipt,
} from "../editorial/transaction";
import { articleContentFingerprint, editableArticle } from "./approvals";

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

const numericID = (value: unknown): number => {
  const id =
    typeof value === "string" && /^[1-9]\d*$/u.test(value)
      ? Number(value)
      : value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
    throw new EditorialError("RECORD_ID_INVALID", 400);
  return id;
};

interface ArticleMutationResult {
  id: number;
  articleId: string;
  revision: number;
  fingerprint: string;
  status: "draft" | "published";
  replayed: boolean;
}

const documentResult = (
  document: Record<string, unknown>,
): Omit<ArticleMutationResult, "replayed"> => ({
  id: numericID(document.id),
  articleId: String(document.articleId),
  revision: Number(document.revision),
  fingerprint: articleContentFingerprint(document),
  status: document._status === "published" ? "published" : "draft",
});

/**
 * A receipt names its Article; one written before that column names none, so the
 * command supplies the id, and a create from then has no id left to return.
 */
const replayedArticle = async (
  req: PayloadRequest,
  receipt: Record<string, unknown>,
  commandID: number | string | undefined,
  status: ArticleMutationResult["status"],
): Promise<Omit<ArticleMutationResult, "replayed">> => {
  const id = relationshipID(receipt.article) ?? commandID;
  return {
    id: id === undefined ? 0 : numericID(id),
    articleId:
      id === undefined
        ? ""
        : String((await editableArticle(req, id)).articleId),
    revision: Number(receipt.revision),
    fingerprint: String(receipt.fingerprint),
    status,
  };
};

/** Article receipts are replayed from the stored result. */
const idempotentArticleMutation = async (
  req: PayloadRequest,
  idempotencyKey: string,
  fingerprint: string,
  work: () => Promise<Omit<ArticleMutationResult, "replayed">>,
  replayFrom: (
    receipt: Record<string, unknown>,
  ) => Promise<Omit<ArticleMutationResult, "replayed">>,
): Promise<ArticleMutationResult> => {
  const actor = requireActor(req);
  const deduplicationKey = requestFingerprint([
    "article",
    req.user?.id,
    idempotencyKey,
  ]);
  const receiptFor = async () => {
    const { docs } = await req.payload.find({
      collection: "editorial-receipts",
      depth: 0,
      limit: 1,
      overrideAccess: false,
      pagination: false,
      req,
      user: req.user,
      where: { deduplicationKey: { equals: deduplicationKey } },
    });
    return (docs[0] as Record<string, unknown> | undefined) ?? null;
  };
  try {
    return await withEditorialTransaction(req, async () => {
      await lockEditorialKey(req, `receipt:${deduplicationKey}`);
      const prior = await receiptFor();
      if (prior) {
        if (prior.requestFingerprint !== fingerprint)
          throw new EditorialError("IDEMPOTENCY_CONFLICT", 409);
        if (prior.status !== "completed")
          throw new ReplayedEditorialError(
            String(prior.errorCode ?? "OPERATION_REJECTED"),
          );
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
            operation: "publish-approved",
            status: "completed",
            article: result.id,
            revision: result.revision,
            fingerprint: result.fingerprint,
          },
        }),
      );
      return { ...result, replayed: false };
    });
  } catch (error) {
    // As in the Catalog path: the rejection is the answer, receipt or not.
    if (!req.transactionID && writesRejectedReceipt(error)) {
      await withEditorialTransaction(req, async () => {
        await lockEditorialKey(req, `receipt:${deduplicationKey}`);
        if (await receiptFor()) return;
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
              operation: "publish-approved",
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

/** Draft-only write for automation and Owner; never publishes. */
export const saveArticleDraft = async (req: PayloadRequest, input: unknown) => {
  requireActor(req);
  const parsed = parse(editorialArticleSaveDraftSchema, input);
  const fingerprint = requestFingerprint({
    operation: "save-article-draft",
    ...parsed,
  });
  const content = { ...parsed.content };
  delete content._status;
  delete content.articleId;
  delete content.revision;
  return idempotentArticleMutation(
    req,
    parsed.idempotencyKey,
    fingerprint,
    async () => {
      if (parsed.id === undefined) {
        const document = await req.payload.create({
          collection: "articles",
          data: { ...content, _status: "draft" } as never,
          draft: true,
          depth: 0,
          overrideAccess: false,
          req,
          user: req.user,
        });
        return documentResult(document as unknown as Record<string, unknown>);
      }
      if (parsed.expectedRevision === undefined)
        throw new EditorialError("REVISION_REQUIRED", 409, [
          "expectedRevision",
        ]);
      const document = await req.payload.update({
        collection: "articles",
        id: parsed.id,
        data: { ...content, revision: parsed.expectedRevision } as never,
        draft: true,
        depth: 0,
        overrideAccess: false,
        overrideLock: false,
        req,
        user: req.user,
      });
      return documentResult(document as unknown as Record<string, unknown>);
    },
    (receipt) => replayedArticle(req, receipt, parsed.id, "draft"),
  );
};

export const approveArticleBatch = async (
  req: PayloadRequest,
  input: unknown,
) => {
  if (!actsAsOwner(req)) throw new EditorialError("APPROVAL_OWNER_ONLY", 403);
  const parsed = parse(editorialArticleApproveBatchSchema, input);
  const approval = await withEditorialTransaction(req, () =>
    req.payload.create({
      collection: "editorial-article-approvals",
      depth: 0,
      req,
      user: req.user,
      overrideAccess: false,
      data: {
        label: parsed.label ?? "Approved article batch",
        automationUser: numericID(parsed.automationUserId),
        status: "active",
        items: parsed.items.map(({ id, revision }) => ({
          article: numericID(id),
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

export const publishApprovedArticle = async (
  req: PayloadRequest,
  input: unknown,
) => {
  requireActor(req);
  const parsed = parse(editorialArticlePublishApprovedSchema, input);
  const fingerprint = requestFingerprint({
    operation: "publish-approved-article",
    ...parsed,
  });
  return idempotentArticleMutation(
    req,
    parsed.idempotencyKey,
    fingerprint,
    async () => {
      await lockEditorialKey(req, `approval:${String(parsed.approvalId)}`);
      const approval = await req.payload.findByID({
        collection: "editorial-article-approvals",
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
      )
        throw new EditorialError("APPROVAL_ACCOUNT_INVALID", 403);
      const item = (approval.items as Record<string, unknown>[]).find(
        (candidate) =>
          String(relationshipID(candidate.article)) === String(parsed.id),
      );
      if (!item) throw new EditorialError("RECORD_NOT_APPROVED", 403);
      await lockEditorialKey(req, `document:${String(parsed.id)}`);
      const latest = (await editableArticle(
        req,
        parsed.id,
      )) as unknown as Record<string, unknown>;
      if (
        latest.revision !== item.revision ||
        articleContentFingerprint(latest) !== item.fingerprint
      ) {
        // As in the Catalog path: what it approved is already live.
        if (
          latest._status === "published" &&
          articleContentFingerprint(latest) === item.fingerprint
        )
          throw new EditorialError("ALREADY_PUBLISHED", 409);
        throw new EditorialError("APPROVED_REVISION_CHANGED", 409);
      }
      const document = await withApprovedPublish(req, () =>
        req.payload.update({
          collection: "articles",
          id: parsed.id,
          data: { revision: Number(latest.revision), _status: "published" },
          draft: false,
          depth: 0,
          overrideAccess: false,
          overrideLock: false,
          req,
          user: req.user,
        }),
      );
      return documentResult(document as unknown as Record<string, unknown>);
    },
    (receipt) => replayedArticle(req, receipt, parsed.id, "published"),
  );
};
