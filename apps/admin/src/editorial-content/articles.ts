import type { CollectionConfig, Field } from "payload";

import {
  assertPublishedCatalog,
  createEditorialContentHooks,
  editorialContentAccess,
} from "./hooks";
import { EditorialError } from "../editorial/errors";

const httpsUrl = (value: unknown): true | string => {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value !== "string") return "仅接受 https 链接";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? true
      : "仅接受 https 链接";
  } catch {
    return "仅接受 https 链接";
  }
};

/** A published Catalog record supplies cover and section images (approved media only). */
const catalogReference = (name: string, label: string): Field => ({
  name,
  type: "relationship",
  relationTo: "catalogs",
  label,
  admin: {
    description:
      "引用已发布的资料记录；图片来自该记录已批准的代表媒体。不支持上传或外链图片。",
  },
});

export const Articles: CollectionConfig = {
  slug: "articles",
  disableBulkEdit: true,
  labels: { singular: "编辑文章", plural: "编辑文章" },
  admin: {
    useAsTitle: "title",
    defaultColumns: ["title", "presentation", "byline", "_status", "updatedAt"],
    group: "内容",
    description: "编辑近闻和学术文章，保存草稿后预览并发布。",
  },
  access: editorialContentAccess,
  hooks: createEditorialContentHooks({
    slug: "articles",
    identityField: "articleId",
    identityPrefix: "article",
    validatePublication: async (req, candidate) => {
      if (typeof candidate.title !== "string" || !candidate.title.trim())
        throw new EditorialError("CONTENT_INVALID", 422, ["title"]);
      if (typeof candidate.byline !== "string" || !candidate.byline.trim())
        throw new EditorialError("CONTENT_INVALID", 422, ["byline"]);
      const sections = Array.isArray(candidate.sections)
        ? (candidate.sections as Record<string, unknown>[])
        : [];
      if (sections.length === 0)
        throw new EditorialError("CONTENT_INVALID", 422, ["sections"]);
      if (
        candidate.presentation === "academic" &&
        sections.some(
          (section) =>
            typeof section.heading !== "string" || !section.heading.trim(),
        )
      )
        throw new EditorialError("CONTENT_INVALID", 422, ["sections"]);
      await assertPublishedCatalog(req, candidate.coverCatalog, "coverCatalog");
      for (const section of sections)
        await assertPublishedCatalog(req, section.imageCatalog, "sections");
    },
  }),
  versions: {
    drafts: { autosave: { interval: 1500 }, validate: true },
    maxPerDoc: 100,
  },
  fields: [
    {
      type: "tabs",
      admin: { className: "editorial-form-tabs" },
      tabs: [
        {
          label: "基本资料",
          fields: [
            {
              name: "presentation",
              type: "select",
              label: "呈现方式",
              required: true,
              defaultValue: "news",
              options: [
                { label: "近闻（图文）", value: "news" },
                { label: "学术专题（分章）", value: "academic" },
              ],
            },
            {
              name: "title",
              type: "text",
              label: "标题",
              required: true,
              maxLength: 120,
            },
            { name: "subtitle", type: "text", label: "副标题", maxLength: 120 },
            {
              name: "summary",
              type: "textarea",
              label: "摘要",
              maxLength: 400,
            },
            {
              name: "section",
              type: "text",
              label: "栏目 / 学科标签",
              maxLength: 40,
              admin: {
                description: "近闻卡片的栏目名，或学术文章的学科标注。",
              },
            },
            {
              name: "issue",
              type: "text",
              label: "期号 / 专题号",
              maxLength: 40,
            },
            {
              name: "byline",
              type: "text",
              label: "署名",
              required: true,
              maxLength: 60,
              admin: {
                description:
                  "编辑署名，仅用于展示；不是公开用户账号，不接收通知，不能登录。",
              },
            },
            catalogReference("coverCatalog", "封面（引用资料记录）"),
            {
              name: "coverAlt",
              type: "text",
              label: "封面说明",
              maxLength: 200,
            },
            {
              type: "collapsible",
              label: "文章详细信息",
              admin: { initCollapsed: true },
              fields: [
                {
                  name: "lastEditedBy",
                  type: "relationship",
                  relationTo: "users",
                  label: "最近编辑人",
                  admin: { readOnly: true },
                },
                {
                  name: "revision",
                  type: "number",
                  label: "版本号",
                  defaultValue: 0,
                  admin: { readOnly: true },
                },
                {
                  name: "articleId",
                  type: "text",
                  label: "文章编号",
                  unique: true,
                  index: true,
                  admin: { readOnly: true, description: "由系统生成。" },
                },
                {
                  name: "firstPublishedAt",
                  type: "date",
                  label: "首次发布时间",
                  admin: { readOnly: true },
                },
                {
                  name: "publishedAt",
                  type: "date",
                  label: "最近发布时间",
                  admin: { readOnly: true },
                },
              ],
            },
          ],
        },
        {
          label: "正文",
          fields: [
            { name: "intro", type: "textarea", label: "导语", maxLength: 2000 },
            {
              name: "sections",
              type: "array",
              labels: { singular: "段落或章节", plural: "段落与章节" },
              label: "正文段落 / 章节",
              minRows: 0,
              maxRows: 40,
              admin: {
                description:
                  "近闻：可不填章节标题；学术：每章须有标题。正文以空行分段，纯文本，不解析 HTML。",
              },
              fields: [
                {
                  name: "heading",
                  type: "text",
                  label: "章节标题",
                  maxLength: 80,
                },
                {
                  name: "body",
                  type: "textarea",
                  label: "正文",
                  required: true,
                  maxLength: 20000,
                },
                catalogReference("imageCatalog", "插图（引用资料记录）"),
                {
                  name: "imageCaption",
                  type: "text",
                  label: "插图说明",
                  maxLength: 200,
                },
              ],
            },
          ],
        },
        {
          label: "引用与参考",
          fields: [
            {
              name: "citations",
              type: "array",
              labels: { singular: "引用", plural: "引用" },
              label: "引用与参考",
              maxRows: 50,
              fields: [
                {
                  name: "text",
                  type: "text",
                  label: "引用文字",
                  required: true,
                  maxLength: 500,
                },
                {
                  name: "url",
                  type: "text",
                  label: "链接（可选，仅 https）",
                  maxLength: 500,
                  validate: httpsUrl,
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};
