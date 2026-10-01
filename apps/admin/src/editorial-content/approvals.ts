/**
 * Exact-revision Owner approval for Articles: the same rule as the Catalog
 * batch approval (`editorial-approvals`), kept as its own collection so the
 * Catalog approval validation stays untouched. An item binds one Article row,
 * its reviewed revision and a content fingerprint; a later edit changes the
 * fingerprint and the item fails individually at publication.
 */
import { createHash } from "node:crypto";

import type { CollectionConfig, PayloadRequest } from "payload";

import { isAutomation, isOwner } from "../editorial/access";
import { relationshipID } from "../editorial/collections";
import { EditorialError } from "../editorial/errors";
import { lockEditorialKey } from "../editorial/transaction";

const contentKeys = [
  "presentation",
  "title",
  "subtitle",
  "summary",
  "section",
  "issue",
  "byline",
  "coverCatalog",
  "coverAlt",
  "intro",
  "sections",
  "citations",
] as const;

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      "id" in record &&
      Object.keys(record).length > 1 &&
      "catalogId" in record
    )
      return record.id; // a populated relationship: identity only
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => key !== "id" || Object.keys(record).length === 1)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value ?? null;
};

/** Order-preserving digest of the Article's editorial content only. */
export const articleContentFingerprint = (document: object): string => {
  const record = document as Record<string, unknown>;
  const subset = Object.fromEntries(
    contentKeys.map((key) => [
      key,
      key === "coverCatalog"
        ? (relationshipID(record[key]) ?? null)
        : canonical(record[key]),
    ]),
  );
  return createHash("sha256").update(JSON.stringify(subset)).digest("hex");
};

export const editableArticle = async (
  req: PayloadRequest,
  id: number | string,
) => {
  try {
    return await req.payload.findByID({
      collection: "articles",
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

export const EditorialArticleApprovals: CollectionConfig = {
  slug: "editorial-article-approvals",
  labels: { singular: "文章批次发布批准", plural: "文章批次发布批准" },
  admin: {
    useAsTitle: "label",
    group: "系统与自动化",
    description:
      "批准所选文章版本供自动化账号发布。内容变动后该项需重新批准；可撤销尚未执行的批准。",
    defaultColumns: ["label", "automationUser", "status", "approvedAt"],
  },
  access: {
    create: ({ req }) => isOwner(req),
    delete: () => false,
    read: ({ req }) =>
      isOwner(req) ||
      (isAutomation(req)
        ? { automationUser: { equals: req.user?.id } }
        : false),
    update: ({ req }) => isOwner(req),
  },
  fields: [
    {
      name: "label",
      type: "text",
      required: true,
      maxLength: 200,
      label: "批次名称",
    },
    {
      name: "automationUser",
      type: "relationship",
      relationTo: "users",
      required: true,
      label: "获准自动化账号",
    },
    {
      name: "status",
      type: "select",
      options: ["active", "revoked"],
      defaultValue: "active",
      required: true,
      label: "批准状态",
    },
    {
      name: "items",
      type: "array",
      minRows: 1,
      maxRows: 100,
      required: true,
      label: "精确版本清单",
      fields: [
        {
          name: "article",
          type: "relationship",
          relationTo: "articles",
          required: true,
          label: "文章",
        },
        {
          name: "revision",
          type: "number",
          required: true,
          min: 1,
          label: "审核版本号",
        },
        {
          name: "fingerprint",
          type: "text",
          admin: { readOnly: true },
          label: "内容校验",
        },
      ],
    },
    {
      name: "approvedBy",
      type: "relationship",
      relationTo: "users",
      admin: { readOnly: true },
      label: "批准人",
    },
    {
      name: "approvedAt",
      type: "date",
      admin: { readOnly: true },
      label: "批准时间",
    },
  ],
  hooks: {
    beforeOperation: [
      async ({ args, operation, req }) => {
        if (operation === "update") {
          if (!isOwner(req))
            throw new EditorialError("APPROVAL_OWNER_ONLY", 403);
          if (!("id" in args) || !args.id)
            throw new EditorialError("SINGLE_RECORD_REQUIRED", 400);
          await lockEditorialKey(req, `approval:${String(args.id)}`);
        }
        if (operation === "delete")
          throw new EditorialError("HARD_DELETE_DISABLED", 403);
        return args;
      },
    ],
    beforeValidate: [
      async ({ data, operation, originalDoc, req }) => {
        if (!isOwner(req)) throw new EditorialError("APPROVAL_OWNER_ONLY", 403);
        if (!data) throw new EditorialError("APPROVAL_INVALID", 400);
        if (operation === "update") {
          if (data.status !== "revoked")
            throw new EditorialError("APPROVAL_IMMUTABLE", 400);
          return { ...originalDoc, status: "revoked" };
        }
        const automationUserID = relationshipID(data.automationUser);
        const items = Array.isArray(data.items)
          ? (data.items as Record<string, unknown>[])
          : [];
        if (!automationUserID || items.length < 1 || items.length > 100)
          throw new EditorialError("APPROVAL_INVALID", 400);
        const account = await req.payload.findByID({
          collection: "users",
          id: automationUserID,
          depth: 0,
          overrideAccess: false,
          req,
          user: req.user,
        });
        if (account.role !== "automation")
          throw new EditorialError("APPROVAL_ACCOUNT_INVALID", 400);
        const ids = items.map((item) =>
          String(relationshipID(item.article) ?? ""),
        );
        if (ids.some((id) => !id) || new Set(ids).size !== ids.length)
          throw new EditorialError("APPROVAL_INVALID", 400);
        for (const id of [...ids].sort())
          await lockEditorialKey(req, `document:${id}`);
        for (const item of items) {
          const id = String(relationshipID(item.article));
          const document = await editableArticle(req, id);
          if (document.revision !== item.revision)
            throw new EditorialError("REVISION_CONFLICT", 409);
          item.fingerprint = articleContentFingerprint(document);
        }
        data.approvedBy = req.user?.id;
        data.approvedAt = new Date().toISOString();
        data.status = "active";
        return data;
      },
    ],
  },
};
