import type { CollectionConfig } from "payload";

import {
  assertPublishedCatalog,
  createEditorialContentHooks,
  editorialContentAccess,
} from "./hooks";
import { EditorialError } from "../editorial/errors";

export const ArticleCollections: CollectionConfig = {
  slug: "article-collections",
  disableBulkEdit: true,
  labels: { singular: "专题合集", plural: "专题合集" },
  admin: {
    useAsTitle: "title",
    defaultColumns: ["title", "collectionId", "revision", "_status"],
    group: "内容",
    description:
      "有序的文章 / 资料合集（专题）。公开读取只包含当前已发布的成员，顺序保持稳定；这不是用户收藏夹。",
  },
  access: editorialContentAccess,
  hooks: createEditorialContentHooks({
    slug: "article-collections",
    identityField: "collectionId",
    identityPrefix: "collection",
    validatePublication: async (req, candidate) => {
      if (typeof candidate.title !== "string" || !candidate.title.trim())
        throw new EditorialError("CONTENT_INVALID", 422, ["title"]);
      await assertPublishedCatalog(req, candidate.coverCatalog, "coverCatalog");
      const members = Array.isArray(candidate.members)
        ? (candidate.members as Record<string, unknown>[])
        : [];
      for (const member of members) {
        if (member.kind === "catalog") {
          if (typeof member.catalogId !== "string" || !member.catalogId)
            throw new EditorialError("CONTENT_INVALID", 422, ["members"]);
          const { docs } = await req.payload.find({
            collection: "catalogs",
            depth: 0,
            draft: false,
            limit: 1,
            overrideAccess: false,
            pagination: false,
            req,
            user: req.user,
            where: { catalogId: { equals: member.catalogId } },
          });
          if (docs.length !== 1)
            throw new EditorialError("REFERENCE_NOT_FOUND", 422, ["members"]);
        } else if (member.kind === "article") {
          const article = member.article;
          const id =
            typeof article === "object" && article !== null && "id" in article
              ? (article as { id: unknown }).id
              : article;
          if (id === undefined || id === null)
            throw new EditorialError("CONTENT_INVALID", 422, ["members"]);
          // Existence only: a withdrawn or pending member is filtered at read time.
          const { docs } = await req.payload.find({
            collection: "articles",
            depth: 0,
            draft: true,
            limit: 1,
            overrideAccess: false,
            pagination: false,
            req,
            user: req.user,
            where: { id: { equals: id } },
          });
          if (docs.length !== 1)
            throw new EditorialError("REFERENCE_NOT_FOUND", 422, ["members"]);
        } else throw new EditorialError("CONTENT_INVALID", 422, ["members"]);
      }
    },
  }),
  versions: {
    drafts: { autosave: { interval: 1500 }, validate: true },
    maxPerDoc: 100,
  },
  fields: [
    {
      name: "lastEditedBy",
      type: "relationship",
      relationTo: "users",
      admin: { readOnly: true, position: "sidebar" },
    },
    {
      name: "revision",
      type: "number",
      defaultValue: 0,
      admin: { readOnly: true, position: "sidebar" },
    },
    {
      name: "collectionId",
      type: "text",
      label: "公开标识",
      unique: true,
      index: true,
      admin: {
        readOnly: true,
        position: "sidebar",
        description: "系统生成，不可修改。",
      },
    },
    {
      name: "firstPublishedAt",
      type: "date",
      label: "首次发布时间",
      admin: { readOnly: true, position: "sidebar" },
    },
    {
      name: "publishedAt",
      type: "date",
      label: "最近发布时间",
      admin: { readOnly: true, position: "sidebar" },
    },
    {
      name: "title",
      type: "text",
      label: "标题",
      required: true,
      maxLength: 120,
    },
    { name: "subtitle", type: "text", label: "副标题", maxLength: 120 },
    { name: "summary", type: "textarea", label: "简介", maxLength: 1000 },
    { name: "category", type: "text", label: "学科 / 分类", maxLength: 60 },
    { name: "issue", type: "text", label: "专题号", maxLength: 40 },
    {
      name: "coverCatalog",
      type: "relationship",
      relationTo: "catalogs",
      label: "封面（引用资料记录）",
    },
    {
      name: "members",
      type: "array",
      label: "成员（有序）",
      maxRows: 200,
      fields: [
        {
          name: "kind",
          type: "select",
          label: "类型",
          required: true,
          defaultValue: "article",
          options: [
            { label: "文章", value: "article" },
            { label: "资料记录", value: "catalog" },
          ],
        },
        {
          name: "article",
          type: "relationship",
          relationTo: "articles",
          label: "文章",
          admin: { condition: (_, sibling) => sibling?.kind === "article" },
        },
        {
          name: "catalogId",
          type: "text",
          label: "资料记录 catalogId",
          maxLength: 160,
          admin: { condition: (_, sibling) => sibling?.kind === "catalog" },
        },
      ],
    },
  ],
};
