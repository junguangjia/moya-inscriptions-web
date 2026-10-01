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
    render: ({ block, editor }) => {
      const { attachments, media, disabled } = useArticleAttachments();
      const reference = referenceEntry(attachments, block.props.refId);
      return (
        <figure className={styles.imageBlock} contentEditable={false}>
          {reference === undefined ? (
            <p role="alert">图片引用不可用，请重新选择。</p>
          ) : (
            media.render(reference, { alt: block.props.alt, active: !disabled })
          )}
          <label>
            <span>图片说明</span>
            <input
              disabled={disabled}
              aria-label="图片说明"
              maxLength={articleAuthoringLimits.captionCodePoints * 2}
              value={block.props.caption}
              onChange={(event) =>
                editor.updateBlock(block, {
                  props: { caption: event.currentTarget.value },
                })
              }
            />
          </label>
          {articleTextLength(block.props.caption) >
          articleAuthoringLimits.captionCodePoints ? (
            <p role="alert">图片说明最多 200 字。</p>
          ) : null}
          <label>
            <span>图片替代文字</span>
            <input
              disabled={disabled}
              aria-label="图片替代文字"
              maxLength={articleAuthoringLimits.captionCodePoints * 2}
              value={block.props.alt}
              onChange={(event) =>
                editor.updateBlock(block, {
                  props: { alt: event.currentTarget.value },
                })
              }
            />
          </label>
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
      const { attachments, media, disabled, moveGalleryImage } =
        useArticleAttachments();
      const gallery = galleryEntry(attachments, block.props.groupId);
      return gallery === undefined ? (
        <p role="alert">图组引用不可用，请重新选择。</p>
      ) : (
        <div
          className={styles.gallery}
          contentEditable={false}
          aria-label="图片组"
        >
          {gallery.referenceIds.map((id, index) => {
            const reference = referenceEntry(attachments, id);
            return (
              <figure key={id}>
                {reference === undefined ? (
                  <p>图片不可用</p>
                ) : (
                  media.render(reference, { alt: "", active: !disabled })
                )}
                <div>
                  <button
                    type="button"
                    aria-label={`第 ${index + 1} 张图片上移`}
                    disabled={disabled || index === 0}
                    onClick={() =>
                      moveGalleryImage(block.id, block.props.groupId, index, -1)
                    }
                  >
                    上移
                  </button>
                  <button
                    type="button"
                    aria-label={`第 ${index + 1} 张图片下移`}
                    disabled={
                      disabled || index === gallery.referenceIds.length - 1
                    }
                    onClick={() =>
                      moveGalleryImage(block.id, block.props.groupId, index, 1)
                    }
                  >
                    下移
                  </button>
                </div>
              </figure>
            );
          })}
        </div>
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
