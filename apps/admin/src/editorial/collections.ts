import { workspacePageLabel } from "../workspace/routes";
import type { CollectionConfig } from "payload";

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
  labels: {
    singular: workspacePageLabel("/admin/collections/editorial-approvals"),
    plural: workspacePageLabel("/admin/collections/editorial-approvals"),
  },
  admin: {
    useAsTitle: "label",
    group: "操作记录",
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
      options: [
        { label: "有效", value: "active" },
        { label: "已撤销", value: "revoked" },
      ],
      defaultValue: "active",
      required: true,
      label: "批准状态",
    },
    {
      name: "items",
      type: "array",
      labels: { singular: "资料版本", plural: "资料版本" },
      minRows: 1,
      maxRows: 100,
      required: true,
      label: "获准发布的资料版本",
      fields: [
        {
          name: "catalog",
          type: "relationship",
          relationTo: "catalogs",
          required: true,
          label: "资料",
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
  labels: {
    singular: workspacePageLabel("/admin/collections/editorial-receipts"),
    plural: workspacePageLabel("/admin/collections/editorial-receipts"),
  },
  admin: {
    useAsTitle: "deduplicationKey",
    group: "操作记录",
    description: "查看自动化操作的执行结果。",
    defaultColumns: ["operation", "catalog", "status", "createdAt"],
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
      name: "actor",
      type: "relationship",
      label: "执行账号",
      relationTo: "users",
      required: true,
    },
    {
      name: "operation",
      type: "select",
      label: "操作",
      options: [
        { label: "保存草稿", value: "save-draft" },
        { label: "发布已批准内容", value: "publish-approved" },
      ],
      required: true,
    },
    {
      name: "status",
      type: "select",
      label: "执行结果",
      options: [
        { label: "已完成", value: "completed" },
        { label: "未通过", value: "rejected" },
      ],
      required: true,
    },
    {
      name: "catalog",
      type: "relationship",
      relationTo: "catalogs",
      label: "资料",
    },
    { name: "errorCode", type: "text", label: "错误代码" },
    {
      type: "collapsible",
      label: "执行详细信息",
      admin: { initCollapsed: true },
      fields: [
        {
          name: "deduplicationKey",
          type: "text",
          label: "操作编号",
          required: true,
          unique: true,
          index: true,
        },
        {
          name: "requestFingerprint",
          type: "text",
          label: "请求校验值",
          required: true,
        },
        { name: "revision", type: "number", label: "版本号" },
        { name: "fingerprint", type: "text", label: "内容校验值" },
      ],
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
