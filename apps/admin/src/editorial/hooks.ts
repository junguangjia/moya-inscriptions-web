import { EDITORIAL_STATEFUL_FIELDS } from "@moya/contracts/internal/editorial";

import type {
  CollectionBeforeOperationHook,
  CollectionConfig,
  PayloadRequest,
} from "payload";

import { canEditCatalog, isAutomation, isOwner, requireActor } from "./access";
import { draftContent, payloadContentData, publishedContent } from "./content";
import { EditorialError } from "./errors";
import {
  clearMutationState,
  isApprovedPublishRequest,
  mutationState,
  setMutationState,
} from "./state";
import { editorialTransaction, lockEditorialKey } from "./transaction";
import { recordFirstCatalogPublication } from "../published/discovery";
import { synchronizePublishedCatalogSearch } from "../published/search";
import { claimEditorialIdentities } from "./identities";
import { validateCatalogMedia } from "../media/validation";
import {
  assertCatalogDeliveryPublication,
  invalidateCatalogDelivery,
} from "./catalog-delivery";

interface MutationArguments {
  id?: number | string;
  data?: Record<string, unknown>;
  draft?: boolean;
  overrideAccess?: boolean;
  overrideLock?: boolean;
  req: PayloadRequest;
}

const revisionNumber = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new EditorialError("REVISION_REQUIRED", 409, ["revision"]);
  }
  return value;
};

const beforeOperation: CollectionBeforeOperationHook = async ({
  args,
  operation,
  req,
}) => {
  if (!["create", "update", "restoreVersion", "delete"].includes(operation)) {
    return args;
  }
  requireActor(req);
  if (operation === "delete")
    throw new EditorialError("HARD_DELETE_DISABLED", 403);
  const input = args as unknown as MutationArguments;
  input.overrideAccess = false;
  input.overrideLock = false;

  if (operation === "restoreVersion") {
    if (!isOwner(req)) throw new EditorialError("RESTORE_OWNER_ONLY", 403);
    // Payload captures this argument before beforeOperation. Do not mutate it
    // here and assume that the operation will honor the changed value.
    if (input.draft !== true)
      throw new EditorialError("RESTORE_REQUIRES_DRAFT", 400);
    // Payload restores through Object.create(req). Fetch Request accessors
    // reject that clone's receiver, so preserve the real request's values as
    // own properties before its native operation clones the request. Auth,
    // transaction and server-only workflow state still use the same request.
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
      collection: "catalogs",
      limit: 1,
      pagination: false,
      req,
      where: { id: { equals: input.id } },
    });
    const version = docs[0];
    if (!version?.parent) throw new EditorialError("RECORD_NOT_FOUND", 404);
    await lockEditorialKey(req, `document:${String(version.parent)}`);
    const latest = await req.payload.findByID({
      collection: "catalogs",
      id: version.parent,
      depth: 0,
      draft: true,
      overrideAccess: false,
      req,
      user: req.user,
    });
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
  // Payload merges omitted nested values from the original document before
  // collection validation. Preserve the caller's explicit non-VALUE state as a
  // null clearing intent first; an explicitly supplied non-null value remains
  // an invalid pair and is rejected by the shared schema.
  for (const field of EDITORIAL_STATEFUL_FIELDS) {
    const value = data[field];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "state" in value &&
      ["UNSUPPLIED", "UNKNOWN", "NOT_APPLICABLE", "CLEAR"].includes(
        String(value.state),
      ) &&
      (!("value" in value) || value.value === undefined)
    ) {
      Object.assign(value, { value: null });
    }
  }
  if (operation === "create") {
    // Only identity is needed for locking here. Native Admin encodes an empty
    // array as 0; Payload sanitizes that transport sentinel in its field hooks
    // before our complete beforeValidate check runs.
    const content = draftContent({
      catalogId: data.catalogId,
      sourceId: data.sourceId,
      kind: data.kind,
    });
    if (!canEditCatalog(req, content.catalogId)) {
      throw new EditorialError("CATALOG_OUT_OF_SCOPE", 403);
    }
    if (data.revision !== undefined && data.revision !== 0) {
      throw new EditorialError("REVISION_INVALID", 400, ["revision"]);
    }
    const keys = [
      `catalog:${content.catalogId}`,
      `source:${content.sourceId}`,
    ].sort();
    for (const key of keys) await lockEditorialKey(req, key);
    if (data._status === "published" && !isOwner(req)) {
      throw new EditorialError("PUBLISH_NOT_APPROVED", 403);
    }
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
  if (publishing && !isOwner(req) && !isApprovedPublishRequest(req)) {
    throw new EditorialError("PUBLISH_NOT_APPROVED", 403);
  }
  if (isAutomation(req) && !isApprovedPublishRequest(req)) {
    // A request that explicitly asks to overwrite/unpublish the main record is
    // rejected, not silently reported as a successful unpublish.
    if (input.draft !== true)
      throw new EditorialError("AUTOMATION_DRAFT_ONLY", 403);
    data._status = "draft";
  }
  // A non-draft update writes the main document. Payload preserves its existing
  // _status when omitted, so treating an implicit update as withdrawal could
  // leave invalid content published. Require an explicit main-record state.
  if (
    input.draft !== true &&
    data._status !== "published" &&
    data._status !== "draft"
  ) {
    throw new EditorialError("PUBLICATION_STATE_REQUIRED", 400, ["_status"]);
  }
  const mode = publishing ? "publish" : input.draft ? "draft" : "withdraw";
  if (mode === "withdraw" && !isOwner(req)) {
    throw new EditorialError("WITHDRAW_OWNER_ONLY", 403);
  }
  setMutationState(req, { mode, expectedRevision });
  return args;
};

export const catalogHooks: NonNullable<CollectionConfig["hooks"]> = {
  beforeOperation: [beforeOperation],
  beforeValidate: [
    async ({ data, originalDoc, operation, req }) => {
      const state = mutationState(req);
      if (!state || !data) throw new EditorialError("WORKFLOW_REQUIRED", 403);
      const previous = (originalDoc ?? {}) as Record<string, unknown>;
      if (operation === "update") {
        if (state.expectedRevision !== previous.revision) {
          throw new EditorialError("REVISION_CONFLICT", 409);
        }
        for (const field of ["catalogId", "sourceId"] as const) {
          if (data[field] !== undefined && data[field] !== previous[field]) {
            throw new EditorialError("IDENTITY_IMMUTABLE", 400, [field]);
          }
        }
        state.nextRevision = revisionNumber(previous.revision) + 1;
      }
      const candidate = draftContent({ ...previous, ...data });
      if (!canEditCatalog(req, candidate.catalogId)) {
        throw new EditorialError("CATALOG_OUT_OF_SCOPE", 403);
      }
      await claimEditorialIdentities(req, candidate);
      await validateCatalogMedia(req, candidate, {
        publishing: state.mode === "publish",
      });
      if (state.mode === "publish")
        assertCatalogDeliveryPublication(candidate, req);
      Object.assign(data, payloadContentData(candidate), {
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
        if (!isOwner(req) && !isApprovedPublishRequest(req)) {
          throw new EditorialError("PUBLISH_NOT_APPROVED", 403);
        }
        Object.assign(
          data,
          payloadContentData(publishedContent({ ...originalDoc, ...data })),
        );
        data._status = "published";
      }
      return data;
    },
  ],
  afterChange: [
    async ({ data, doc, req }) => {
      const state = mutationState(req);
      if (
        state &&
        ["draft", "restore", "withdraw", "publish"].includes(state.mode)
      ) {
        await invalidateCatalogDelivery(
          req,
          Number(doc.id),
          state.mode === "withdraw"
            ? "WITHDRAWN"
            : state.mode === "publish"
              ? "PUBLISHED"
              : "DRAFT_CHANGED",
        );
      }
      if (state?.mode === "publish" || state?.mode === "withdraw") {
        if (typeof data.catalogId !== "string")
          throw new EditorialError("CONTENT_INVALID", 422);
        if (state.mode === "publish")
          await recordFirstCatalogPublication(
            await editorialTransaction(req),
            data.catalogId,
          );
        await synchronizePublishedCatalogSearch(
          await editorialTransaction(req),
          data.catalogId,
          state.mode === "publish",
        );
      }
      return doc;
    },
  ],
  afterOperation: [
    ({ result, operation, req }) => {
      if (
        ["create", "update", "updateByID", "restoreVersion"].includes(operation)
      ) {
        clearMutationState(req);
      }
      return result;
    },
  ],
};
