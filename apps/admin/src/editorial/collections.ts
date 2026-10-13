import type { CollectionConfig } from "payload";
import { MAX_CURATION_METADATA_BYTES } from "@moya/contracts/internal/editorial";

import { canEditCatalog, isAutomation, isOwner } from "./access";
import { contentFingerprint, publishedContent } from "./content";
import { EditorialError } from "./errors";
import { isLedgerRequest } from "./state";
import { lockEditorialKey } from "./transaction";

export const relationshipID = (value: unknown): number | string | undefined => {
  if (typeof value === "number" || typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    return relationshipID(value.id);
  }
  return undefined;
};

export const EditorialApprovals: CollectionConfig = {
  slug: "editorial-approvals",
  labels: { singular: "批次发布批准", plural: "批次发布批准" },
  admin: {
    useAsTitle: "label",
    group: "系统与自动化",
    description:
      "批准所选版本。内容变动后该项需重新批准；可撤销尚未执行的批准。",
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
          name: "catalog",
          type: "relationship",
          relationTo: "catalogs",
          required: true,
          label: "目录记录",
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
        if (
          !automationUserID ||
          !Array.isArray(data.items) ||
          data.items.length < 1 ||
          data.items.length > 100
        ) {
          throw new EditorialError("APPROVAL_INVALID", 400);
        }
        const account = await req.payload.findByID({
          collection: "users",
          id: automationUserID,
          depth: 0,
          req,
          user: req.user,
          overrideAccess: false,
        });
        if (account.role !== "automation")
          throw new EditorialError("APPROVAL_ACCOUNT_INVALID", 400);
        const items = data.items as Record<string, unknown>[];
        const ids = items.map((item) => relationshipID(item.catalog));
        if (
          ids.some((id) => id === undefined) ||
          new Set(ids.map(String)).size !== ids.length
        ) {
          throw new EditorialError("APPROVAL_INVALID", 400);
        }
        for (const id of [...ids].sort((a, b) =>
          String(a).localeCompare(String(b)),
        )) {
          await lockEditorialKey(req, `document:${String(id)}`);
        }
        for (const item of items) {
          const id = relationshipID(item.catalog)!;
          const document = await req.payload.findByID({
            collection: "catalogs",
            id,
            depth: 0,
            draft: true,
            req,
            user: req.user,
            overrideAccess: false,
          });
          if (item.revision !== document.revision)
            throw new EditorialError("REVISION_CONFLICT", 409);
          if (
            !canEditCatalog(
              { ...req, user: account } as typeof req,
              String(document.catalogId),
            )
          ) {
            throw new EditorialError("APPROVAL_SCOPE_INVALID", 403);
          }
          publishedContent(document);
          item.fingerprint = contentFingerprint(document);
        }
        return {
          ...data,
          items,
          automationUser: automationUserID,
          status: "active",
          approvedBy: req.user?.id,
          approvedAt: new Date().toISOString(),
        };
      },
    ],
  },
};

export const EditorialReceipts: CollectionConfig = {
  slug: "editorial-receipts",
  labels: { singular: "批处理回执", plural: "批处理回执" },
  admin: {
    useAsTitle: "deduplicationKey",
    group: "系统与自动化",
    description: "每项执行结果；成功项重放不会重复创建内容或版本。",
    defaultColumns: ["operation", "catalog", "revision", "status", "createdAt"],
  },
  access: {
    create: ({ req }) => isLedgerRequest(req),
    delete: () => false,
    read: ({ req }) =>
      isOwner(req) ||
      (isAutomation(req) ? { actor: { equals: req.user?.id } } : false),
    update: () => false,
  },
  fields: [
    {
      name: "deduplicationKey",
      type: "text",
      required: true,
      unique: true,
      index: true,
    },
    { name: "requestFingerprint", type: "text", required: true },
    {
      name: "actor",
      type: "relationship",
      relationTo: "users",
      required: true,
    },
    {
      name: "operation",
      type: "select",
      options: ["save-draft", "publish-approved", "save-curation-metadata"],
      required: true,
    },
    {
      name: "status",
      type: "select",
      options: ["completed", "rejected"],
      required: true,
    },
    { name: "catalog", type: "relationship", relationTo: "catalogs" },
    { name: "revision", type: "number" },
    { name: "fingerprint", type: "text" },
    { name: "errorCode", type: "text" },
    // The metadata artifact lives in the existing append-only ledger. Text
    // retains the submitted UTF-8 JSON; a JSONB field would normalize it.
    {
      name: "metadataJson",
      type: "textarea",
      maxLength: MAX_CURATION_METADATA_BYTES,
      admin: { hidden: true, readOnly: true },
    },
    {
      name: "metadataSha256",
      type: "text",
      maxLength: 64,
      admin: { hidden: true, readOnly: true },
    },
    {
      name: "metadataCatalogId",
      type: "text",
      maxLength: 128,
      admin: { hidden: true, readOnly: true },
    },
    {
      name: "previousMetadataSha256",
      type: "text",
      maxLength: 64,
      admin: { hidden: true, readOnly: true },
    },
    {
      name: "metadataVersion",
      type: "number",
      min: 1,
      admin: { hidden: true, readOnly: true },
    },
  ],
  hooks: {
    beforeValidate: [
      ({ data, req }) => {
        if (!isLedgerRequest(req))
          throw new EditorialError("RECEIPT_SERVER_ONLY", 403);
        return data;
      },
    ],
  },
};
