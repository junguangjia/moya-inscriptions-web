"use client";

import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
} from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import {
  articleAuthoringLimits,
  articleTextLength,
  parseArticleCatalogIdentity,
} from "../../../lib/public-api/article-authoring-client";
import {
  galleryEntry,
  referenceEntry,
  useArticleAttachments,
} from "./article-attachments";
import styles from "./article-authoring.module.css";
import { ArticleToolIcon } from "./article-tools";

const fixedColors = {
  backgroundColor: { default: "default", values: ["default"] },
  textColor: { default: "default", values: ["default"] },
} as const;
const fixedProps = {
  ...fixedColors,
  textAlignment: { default: "left", values: ["left"] },
} as const;
const paragraph = defaultBlockSpecs.paragraph;
const bullet = defaultBlockSpecs.bulletListItem;
const numbered = defaultBlockSpecs.numberedListItem;
const quote = defaultBlockSpecs.quote;
const heading = createReactBlockSpec(
  {
    type: "heading",
    propSchema: { ...fixedProps, level: { default: 2, values: [2, 3] } },
    content: "inline",
  },
  {
    meta: { isolating: false },
    parse: (element) =>
      element.tagName === "H2"
        ? { level: 2 }
        : element.tagName === "H3"
          ? { level: 3 }
          : undefined,
    render: ({ block, contentRef }) =>
      block.props.level === 2 ? (
        <h2 ref={contentRef} />
      ) : (
        <h3 ref={contentRef} />
      ),
    toExternalHTML: ({ block, contentRef }) =>
      block.props.level === 2 ? (
        <h2 ref={contentRef} />
      ) : (
        <h3 ref={contentRef} />
      ),
  },
)();

const managedImage = createReactBlockSpec(
  {
    type: "managedImage",
    propSchema: {
      refId: { default: "" },
      caption: { default: "" },
      alt: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block }) => {
      const { attachments, media, disabled, editImage } =
        useArticleAttachments();
      const reference = referenceEntry(attachments, block.props.refId);
      return (
        <figure className={styles.imageBlock} contentEditable={false}>
          {reference === undefined ? (
            <p role="alert">图片引用不可用，请重新选择。</p>
          ) : (
            media.render(reference, { alt: block.props.alt, active: !disabled })
          )}
          <div className={styles.imageDetails}>
            {block.props.caption === "" ? null : (
              <figcaption>{block.props.caption}</figcaption>
            )}
            <button
              type="button"
              className={styles.blockAction}
              aria-label="编辑图片说明"
              disabled={disabled}
              onClick={() => editImage(block.id)}
            >
              <ArticleToolIcon name="settings" />
              <span>
                {block.props.caption === "" ? "添加说明" : "编辑说明"}
              </span>
            </button>
          </div>
          {articleTextLength(block.props.caption) >
          articleAuthoringLimits.captionCodePoints ? (
            <p role="alert">图片说明最多 200 字。</p>
          ) : null}
        </figure>
      );
    },
    // Clipboard HTML has no authority to resolve private media. Preserve text;
    // managed identity is carried only in the authenticated canonical envelope.
    toExternalHTML: ({ block }) => (
      <figure>
        <figcaption>{block.props.caption}</figcaption>
      </figure>
    ),
  },
)();
const imageGallery = createReactBlockSpec(
  {
    type: "imageGallery",
    propSchema: { groupId: { default: "" } },
    content: "none",
  },
  {
    render: ({ block }) => {
      const { attachments, media, disabled, editGallery } =
        useArticleAttachments();
      const gallery = galleryEntry(attachments, block.props.groupId);
      return gallery === undefined ? (
        <p role="alert">图组引用不可用，请重新选择。</p>
      ) : (
        <figure
          className={styles.galleryBlock}
          contentEditable={false}
          aria-label="图片组"
        >
          <div className={styles.gallery}>
            {gallery.referenceIds.map((id) => {
              const reference = referenceEntry(attachments, id);
              return (
                <figure key={id}>
                  {reference === undefined ? (
                    <p>图片不可用</p>
                  ) : (
                    media.render(reference, { alt: "", active: !disabled })
                  )}
                </figure>
              );
            })}
          </div>
          <figcaption className={styles.imageDetails}>
            <span>{gallery.referenceIds.length} 张图片</span>
            <button
              type="button"
              className={styles.blockAction}
              disabled={disabled}
              onClick={() => editGallery(block.id)}
            >
              <ArticleToolIcon name="gallery" />
              调整图组
            </button>
          </figcaption>
        </figure>
      );
    },
    toExternalHTML: () => <p>图片组</p>,
  },
)();
const catalogReference = createReactBlockSpec(
  {
    type: "catalogReference",
    propSchema: { catalogId: { default: "" } },
    content: "none",
  },
  {
    render: ({ block }) => {
      const { media } = useArticleAttachments();
      // Actual Catalog identity is validated by the shared command/schema and
      // authorized picker. A typed UI renderer never grants publication rights.
      const id = parseArticleCatalogIdentity(block.props.catalogId);
      return (
        <aside contentEditable={false} className={styles.catalogReference}>
          {id === null ? (
            <p role="alert">藏品引用不可用，请重新选择。</p>
          ) : (
            media.renderCatalog(id)
          )}
        </aside>
      );
    },
    toExternalHTML: () => <p>藏品引用</p>,
  },
)();

/** A real restricted schema, not merely a hidden menu of unrestricted nodes. */
export const articleBlockNoteSchema = BlockNoteSchema.create({
  blockSpecs: {
    paragraph: {
      ...paragraph,
      config: { ...paragraph.config, propSchema: fixedProps },
    },
    heading,
    bulletListItem: {
      ...bullet,
      config: { ...bullet.config, propSchema: fixedProps },
    },
    numberedListItem: {
      ...numbered,
      config: {
        ...numbered.config,
        propSchema: { ...fixedProps, start: numbered.config.propSchema.start },
      },
    },
    quote: { ...quote, config: { ...quote.config, propSchema: fixedColors } },
    divider: defaultBlockSpecs.divider,
    managedImage,
    imageGallery,
    catalogReference,
  },
  inlineContentSpecs: defaultInlineContentSpecs,
  styleSpecs: {
    bold: defaultStyleSpecs.bold,
    italic: defaultStyleSpecs.italic,
  },
});

export type ArticleBlockNoteEditor =
  typeof articleBlockNoteSchema.BlockNoteEditor;
