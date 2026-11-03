import {
  EDITORIAL_FIELD_NAMES,
  editorialContentFromDocument,
  editorialPublishSchema,
  ownerDraftPageRequestSchema,
  ownerHistoryRequestSchema,
  type OwnerDraftPage,
  type OwnerHistoryPage,
} from "@moya/contracts/internal/editorial";
import type { PayloadRequest } from "payload";

import { actsAsOwner } from "./access";
import { draftContent } from "./content";
import { EditorialError, validationError } from "./errors";

const requireOwner = (req: PayloadRequest) => {
  if (!actsAsOwner(req)) throw new EditorialError("OWNER_WORKFLOW_ONLY", 403);
};

/** Owner summaries never contain complete original text, object keys or notes. */
export const ownerDraftPage = async (
  req: PayloadRequest,
  input: unknown,
): Promise<OwnerDraftPage> => {
  requireOwner(req);
  const parsed = ownerDraftPageRequestSchema.safeParse(input);
  if (!parsed.success) throw validationError(parsed.error.issues);
  const page = await req.payload.find({
    collection: "catalogs",
    draft: true,
    depth: 0,
    sort: "-updatedAt",
    page: parsed.data.page,
    limit: parsed.data.pageSize,
    req,
    user: req.user,
    overrideAccess: false,
  });
  const accounts = await req.payload.find({
    collection: "users",
    where: { role: { equals: "automation" } },
    select: { role: true },
    depth: 0,
    limit: 100,
    req,
    user: req.user,
    // After the gate; account rows are reserved to the Owner's browser.
    overrideAccess: true,
  });
  const docs = await Promise.all(
    page.docs.map(async (document) => {
      const content = draftContent(document);
      const checked = editorialPublishSchema.safeParse(content);
      const live = await req.payload.findByID({
        collection: "catalogs",
        id: document.id,
        draft: false,
        depth: 0,
        req,
        user: req.user,
        overrideAccess: false,
      });
      const baseline =
        live._status === "published"
          ? editorialContentFromDocument({ ...draftContent(live) })
          : {};
      return {
        id: document.id,
        catalogId: content.catalogId,
        title: content.title ?? null,
        revision: Number(document.revision),
        status:
          document._status === "published"
            ? ("published" as const)
            : ("draft" as const),
        missingFields: checked.success
          ? []
          : [
              ...new Set(
                checked.error.issues.map(({ path }) =>
                  String(path[0] ?? "content"),
                ),
              ),
            ],
        changedFields: EDITORIAL_FIELD_NAMES.filter(
          (field) =>
            JSON.stringify(content[field]) !== JSON.stringify(baseline[field]),
        ),
      };
    }),
  );
  return {
    docs,
    page: page.page ?? parsed.data.page,
    totalPages: page.totalPages,
    totalDocs: page.totalDocs,
    automationUsers: accounts.docs.map(({ id }) => ({
      id,
      label: `自动化账号 #${id}`,
    })),
  };
};

export const ownerHistoryPage = async (
  req: PayloadRequest,
  input: unknown,
): Promise<OwnerHistoryPage> => {
  requireOwner(req);
  const parsed = ownerHistoryRequestSchema.safeParse(input);
  if (!parsed.success) throw validationError(parsed.error.issues);
  const current = await req.payload.findByID({
    collection: "catalogs",
    id: parsed.data.id,
    draft: true,
    depth: 0,
    req,
    user: req.user,
    overrideAccess: false,
  });
  const versions = await req.payload.findVersions({
    collection: "catalogs",
    where: { parent: { equals: current.id } },
    sort: "-createdAt",
    page: parsed.data.page,
    limit: 20,
    depth: 0,
    req,
    user: req.user,
    overrideAccess: false,
  });
  return {
    id: current.id,
    currentRevision: Number(current.revision),
    docs: versions.docs.map((version) => ({
      id: Number(version.id),
      revision: Number(version.version.revision),
      title: version.version.title ?? null,
      status: version.version._status === "published" ? "published" : "draft",
      createdAt: version.createdAt,
    })),
    page: versions.page ?? parsed.data.page,
    totalPages: versions.totalPages,
  };
};
