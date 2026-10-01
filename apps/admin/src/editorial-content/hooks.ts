/**
 * Bounded editorial workflow for the content collections added by
 * content-community-completion-v1 (`articles`, `article-collections`). It
 * mirrors the Catalog rules the P2-04 amendment froze: an actor is required,
 * hard deletion is disabled, the Owner alone publishes, withdraws and restores,
 * automation writes drafts only, every mutation names the expected revision and
 * the public identity is server-generated and immutable. Publication by
 * automation happens only through the approval operation, which marks the
 * request with `withApprovedPublish` before calling the Local API.
 */
import { randomBytes } from "node:crypto";

import type {
  CollectionBeforeOperationHook,
  CollectionConfig,
  PayloadRequest,
} from "payload";

import { isAutomation, isOwner, requireActor } from "../editorial/access";
import { EditorialError } from "../editorial/errors";
import {
  clearMutationState,
  isApprovedPublishRequest,
  mutationState,
  setMutationState,
} from "../editorial/state";
import { lockEditorialKey } from "../editorial/transaction";

interface MutationArguments {
  id?: number | string;
  data?: Record<string, unknown>;
  draft?: boolean;
  overrideAccess?: boolean;
  overrideLock?: boolean;
  req: PayloadRequest;
}

export interface EditorialContentWorkflow {
  /** Payload collection slug. */
  readonly slug: "articles" | "article-collections";
  /** Field holding the stable public id. */
  readonly identityField: "articleId" | "collectionId";
  /** Prefix of the generated public id. */
  readonly identityPrefix: "article" | "collection";
  /**
   * Publication-time validation of the complete candidate document. Runs
   * inside the Payload transaction; throws an `EditorialError` on refusal.
   */
  readonly validatePublication: (
    req: PayloadRequest,
    candidate: Record<string, unknown>,
  ) => Promise<void>;
}

const revisionNumber = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new EditorialError("REVISION_REQUIRED", 409, ["revision"]);
  return value;
};

export const generatePublicIdentity = (prefix: string): string =>
  `${prefix}-${randomBytes(16).toString("hex")}`;

const identityPattern = (prefix: string) =>
  new RegExp(`^${prefix}-[0-9a-f]{32}$`, "u");

export const createEditorialContentHooks = (
  workflow: EditorialContentWorkflow,
): NonNullable<CollectionConfig["hooks"]> => {
  const beforeOperation: CollectionBeforeOperationHook = async ({
    args,
    operation,
    req,
  }) => {
    if (!["create", "update", "restoreVersion", "delete"].includes(operation))
      return args;
    requireActor(req);
    if (operation === "delete")
      throw new EditorialError("HARD_DELETE_DISABLED", 403);
    const input = args as unknown as MutationArguments;
    input.overrideAccess = false;
    input.overrideLock = false;
    if (operation === "restoreVersion") {
      if (!isOwner(req)) throw new EditorialError("RESTORE_OWNER_ONLY", 403);
      if (input.draft !== true)
        throw new EditorialError("RESTORE_REQUIRES_DRAFT", 400);
      Object.defineProperties(req, {
        headers: {
          value: req.headers,
          enumerable: true,
          configurable: true,
          writable: true,
        },
        url: {
          value: req.url,
          enumerable: true,
          configurable: true,
          writable: true,
        },
      });
      const expected = Number(req.query.expectedRevision);
      revisionNumber(expected);
      const { docs } = await req.payload.db.findVersions({
        collection: workflow.slug,
        limit: 1,
        pagination: false,
        req,
        where: { id: { equals: input.id } },
      });
      const version = docs[0];
      if (!version?.parent) throw new EditorialError("RECORD_NOT_FOUND", 404);
      await lockEditorialKey(req, `document:${String(version.parent)}`);
      const latest = (await req.payload.findByID({
        collection: workflow.slug,
        id: version.parent,
        depth: 0,
        draft: true,
        overrideAccess: false,
        req,
        user: req.user,
      })) as { revision?: unknown };
      if (latest.revision !== expected)
        throw new EditorialError("REVISION_CONFLICT", 409);
      setMutationState(req, {
        mode: "restore",
        expectedRevision: expected,
        nextRevision: expected + 1,
      });
      return args;
    }
    const data = input.data ?? {};
    if (operation === "create") {
      if (data.revision !== undefined && data.revision !== 0)
        throw new EditorialError("REVISION_INVALID", 400, ["revision"]);
      if (data[workflow.identityField] !== undefined)
        throw new EditorialError("IDENTITY_SERVER_ONLY", 400, [
          workflow.identityField,
        ]);
      if (data._status === "published" && !isOwner(req))
        throw new EditorialError("PUBLISH_NOT_APPROVED", 403);
      if (data._status !== "published") {
        input.draft = true;
        data._status = "draft";
      }
      setMutationState(req, {
        mode: data._status === "published" ? "publish" : "create",
        nextRevision: 1,
      });
      input.data = data;
      return args;
    }
    if (input.id === undefined)
      throw new EditorialError("SINGLE_RECORD_REQUIRED", 400);
    await lockEditorialKey(req, `document:${String(input.id)}`);
    const expectedRevision = revisionNumber(data.revision);
    const publishing = data._status === "published";
    if (publishing && !isOwner(req) && !isApprovedPublishRequest(req))
      throw new EditorialError("PUBLISH_NOT_APPROVED", 403);
    if (isAutomation(req) && !isApprovedPublishRequest(req)) {
      if (input.draft !== true)
        throw new EditorialError("AUTOMATION_DRAFT_ONLY", 403);
      data._status = "draft";
    }
    if (
      input.draft !== true &&
      data._status !== "published" &&
      data._status !== "draft"
    )
      throw new EditorialError("PUBLICATION_STATE_REQUIRED", 400, ["_status"]);
    const mode = publishing ? "publish" : input.draft ? "draft" : "withdraw";
    if (mode === "withdraw" && !isOwner(req))
      throw new EditorialError("WITHDRAW_OWNER_ONLY", 403);
    setMutationState(req, { mode, expectedRevision });
    return args;
  };

  return {
    beforeOperation: [beforeOperation],
    beforeValidate: [
      async ({ data, originalDoc, operation, req }) => {
        const state = mutationState(req);
        if (!state || !data) throw new EditorialError("WORKFLOW_REQUIRED", 403);
        const previous = (originalDoc ?? {}) as Record<string, unknown>;
        if (operation === "update") {
          if (state.expectedRevision !== previous.revision)
            throw new EditorialError("REVISION_CONFLICT", 409);
          const identity = data[workflow.identityField];
          if (
            identity !== undefined &&
            identity !== previous[workflow.identityField]
          )
            throw new EditorialError("IDENTITY_IMMUTABLE", 400, [
              workflow.identityField,
            ]);
          state.nextRevision = revisionNumber(previous.revision) + 1;
        } else {
          data[workflow.identityField] = generatePublicIdentity(
            workflow.identityPrefix,
          );
        }
        const identity =
          data[workflow.identityField] ?? previous[workflow.identityField];
        if (
          typeof identity !== "string" ||
          !identityPattern(workflow.identityPrefix).test(identity)
        )
          throw new EditorialError("IDENTITY_INVALID", 400, [
            workflow.identityField,
          ]);
        if (state.mode === "publish")
          await workflow.validatePublication(req, { ...previous, ...data });
        Object.assign(data, {
          revision: state.nextRevision,
          lastEditedBy: req.user?.id,
        });
        if (["draft", "create", "restore"].includes(state.mode))
          data._status = "draft";
        return data;
      },
    ],
    beforeChange: [
      ({ data, originalDoc, req }) => {
        const state = mutationState(req);
        if (!state) throw new EditorialError("WORKFLOW_REQUIRED", 403);
        if (state.mode === "publish") {
          if (!isOwner(req) && !isApprovedPublishRequest(req))
            throw new EditorialError("PUBLISH_NOT_APPROVED", 403);
          data._status = "published";
          const previous = (originalDoc ?? {}) as Record<string, unknown>;
          // Genuine first publication time; never rewritten by later edits.
          data.firstPublishedAt =
            typeof previous.firstPublishedAt === "string"
              ? previous.firstPublishedAt
              : new Date().toISOString();
          data.publishedAt = new Date().toISOString();
        }
        return data;
      },
    ],
    afterOperation: [
      ({ result, operation, req }) => {
        if (
          ["create", "update", "updateByID", "restoreVersion"].includes(
            operation,
          )
        )
          clearMutationState(req);
        return result;
      },
    ],
  };
};

/** Owner: everything except delete. Automation: read and draft writes only. */
export const editorialContentAccess = {
  create: ({ req }: { req: PayloadRequest }) =>
    isOwner(req) || isAutomation(req),
  delete: () => false,
  read: ({ req }: { req: PayloadRequest }) => isOwner(req) || isAutomation(req),
  readVersions: ({ req }: { req: PayloadRequest }) =>
    isOwner(req) || isAutomation(req),
  update: ({ req }: { req: PayloadRequest }) =>
    isOwner(req) || isAutomation(req),
};

/** A referenced Catalog record must be published for the reference to publish. */
export const assertPublishedCatalog = async (
  req: PayloadRequest,
  catalog: unknown,
  field: string,
): Promise<void> => {
  const id =
    typeof catalog === "object" && catalog !== null && "id" in catalog
      ? (catalog as { id: unknown }).id
      : catalog;
  if (id === undefined || id === null) return;
  const { docs } = await req.payload.find({
    collection: "catalogs",
    depth: 0,
    draft: false,
    limit: 1,
    overrideAccess: false,
    pagination: false,
    req,
    user: req.user,
    where: {
      and: [{ id: { equals: id } }, { _status: { equals: "published" } }],
    },
  });
  if (docs.length !== 1)
    throw new EditorialError("REFERENCE_NOT_PUBLISHED", 422, [field]);
};
