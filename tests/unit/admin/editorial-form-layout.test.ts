import type { Field } from "payload";
import { describe, expect, it } from "vitest";
import { editorialFields } from "admin/fields";
import { Articles, ArticleCollections } from "admin/editorial-content";
import { Users } from "admin/users";

/** Enumerate real storage paths, treating unnamed layout fields as transparent. */
const paths = (fields: Field[], prefix = ""): string[] =>
  fields.flatMap((field) => {
    if (field.type === "tabs")
      return field.tabs.flatMap((tab) => {
        expect("name" in tab).toBe(false);
        return paths(tab.fields, prefix);
      });
    if (field.type === "row" || field.type === "collapsible")
      return paths(field.fields, prefix);
    if (!("name" in field) || field.type === "ui") return [];
    const path = `${prefix}${field.name}`;
    return "fields" in field
      ? [path, ...paths(field.fields, `${path}.`)]
      : [path];
  });

const findField = (fields: Field[], name: string): Field | undefined => {
  for (const field of fields) {
    if ("name" in field && field.name === name) return field;
    const nested =
      field.type === "tabs"
        ? field.tabs.flatMap((tab) => tab.fields)
        : "fields" in field
          ? field.fields
          : [];
    const found = findField(nested, name);
    if (found) return found;
  }
};

describe("native editorial form presentation", () => {
  it("groups Catalog fields into five unnamed tabs without introducing storage prefixes", () => {
    const tabs = editorialFields[0];
    expect(tabs?.type).toBe("tabs");
    if (tabs?.type !== "tabs") throw new Error("Expected native tabs");
    expect(tabs.tabs.map((tab) => tab.label)).toEqual([
      "基本资料",
      "文字内容",
      "图片",
      "资料来源",
      "筛选信息",
    ]);
    const actual = paths(editorialFields);
    expect(actual).toEqual(
      expect.arrayContaining([
        "catalogId",
        "sourceId",
        "transcription.state",
        "transcription.value",
        "media.mediaId",
        "media.objectKey",
        "media.width",
        "media.height",
        "media.position",
        "media.isRepresentative",
        "media.rights",
        "media.orderConfidence",
        "sourceCitations.appliesTo",
        "filterMetadata.dynasty.state",
        "filterMetadata.dynasty.tokens",
      ]),
    );
    expect(new Set(actual).size).toBe(actual.length);
    const media = findField(editorialFields, "media");
    if (media?.type !== "array") throw new Error("Expected native media array");
    expect(
      media.fields.find((field) => field.type === "collapsible"),
    ).toMatchObject({
      admin: { initCollapsed: true },
      fields: expect.arrayContaining([
        expect.objectContaining({
          name: "width",
          type: "number",
          required: true,
          min: 1,
          admin: { readOnly: true },
        }),
        expect.objectContaining({
          name: "position",
          type: "number",
          required: true,
          min: 0,
          max: 2_147_483_647,
        }),
      ]),
    });
  });

  it("keeps article and collection storage fields and publication metadata at their original paths", () => {
    expect(paths(Articles.fields)).toEqual(
      expect.arrayContaining([
        "articleId",
        "revision",
        "lastEditedBy",
        "firstPublishedAt",
        "publishedAt",
        "presentation",
        "title",
        "byline",
        "coverCatalog",
        "sections.body",
        "sections.imageCatalog",
        "citations.url",
      ]),
    );
    expect(paths(ArticleCollections.fields)).toEqual(
      expect.arrayContaining([
        "collectionId",
        "revision",
        "lastEditedBy",
        "firstPublishedAt",
        "publishedAt",
        "title",
        "coverCatalog",
        "members.kind",
        "members.article",
        "members.catalogId",
      ]),
    );
    expect(findField(Articles.fields, "title")).toMatchObject({
      required: true,
      maxLength: 120,
    });
    expect(findField(Articles.fields, "body")).toMatchObject({
      required: true,
      maxLength: 20_000,
    });
    expect(findField(ArticleCollections.fields, "members")).toMatchObject({
      maxRows: 200,
    });
  });

  it("keeps the two existing operator roles while distinguishing them from website users", () => {
    expect(Users.labels).toEqual({ singular: "后台账号", plural: "后台账号" });
    expect(findField(Users.fields, "role")).toMatchObject({
      defaultValue: "automation",
      options: [
        { label: "管理员", value: "owner" },
        { label: "自动化账号", value: "automation" },
      ],
    });
    expect(paths(Users.fields)).toEqual([
      "role",
      "agentPrincipal",
      "scopeCatalogIds",
    ]);
    expect(Users.access?.delete).toBeTypeOf("function");
  });
});
