"use client";

import {
  BlockNoteSchema,
  type BlockSpecs,
  createStyleSpec,
  createHeadingBlockSpec,
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
import { getArticleImageCrop } from "./article-image-layout";
import { ArticleImageResize } from "./article-image-resize";

/** Keep native marks, with a bounded parser for clipboard/internal HTML. */
const textColorBase = createStyleSpec(
  { type: "textColor", propSchema: "string" },
  {
    render: (value) => {
      const dom = document.createElement("span");
      dom.dataset.articleTextColor = value;
      return { dom, contentDOM: dom };
    },
  },
);
const allowedTextColor = (value: string | null) =>
  value !== null && ["default", "gray", "red", "brown"].includes(value);
const textColor = {
  ...textColorBase,
  implementation: {
    ...textColorBase.implementation,
    mark: textColorBase.implementation.mark.extend({
      parseHTML: () => [
        {
          tag: '[data-style-type="textColor"]',
          getAttrs: (element) => {
            const value = element.getAttribute("data-value");
            return allowedTextColor(value) ? { stringValue: value } : false;
          },
        },
        {
          style: "color",
          getAttrs: (value) =>
            typeof value === "string" && allowedTextColor(value)
              ? { stringValue: value }
              : false,
        },
      ],
    }),
  },
};

/** Reuse BlockNote's native string-mark machinery with the canonical palette. */
const backgroundColorBase = createStyleSpec(
  { type: "backgroundColor", propSchema: "string" },
  {
    render: (value) => {
      const dom = document.createElement("span");
      dom.dataset.articleBackgroundColor = value;
      return { dom, contentDOM: dom };
    },
  },
);
const backgroundColor = {
  ...backgroundColorBase,
  implementation: {
    ...backgroundColorBase.implementation,
    mark: backgroundColorBase.implementation.mark.extend({
      parseHTML: () => [
        {
          tag: '[data-style-type="backgroundColor"]',
          getAttrs: (element) => {
            const value = element.getAttribute("data-value");
            return allowedTextColor(value) ? { stringValue: value } : false;
          },
        },
        {
          style: "background-color",
          getAttrs: (value) =>
            typeof value === "string" && allowedTextColor(value)
              ? { stringValue: value }
              : false,
        },
      ],
    }),
  },
};

const fixedColors = {
  backgroundColor: { default: "default", values: ["default"] },
  textColor: { default: "default", values: ["default"] },
} as const;
const fixedProps = {
  ...fixedColors,
  textAlignment: {
    default: "left",
    values: ["left", "center", "right", "justify"],
  },
  lineSpacing: { default: "normal", values: ["normal", "compact", "relaxed"] },
} as const;
const paragraph = defaultBlockSpecs.paragraph;
const bullet = defaultBlockSpecs.bulletListItem;
const numbered = defaultBlockSpecs.numberedListItem;
const quote = defaultBlockSpecs.quote;
// Native factory retains heading input rules, shortcuts and serializers. Schema
// construction generates node attributes from the modified config via
// BlockNote's propsToAttributes; defaultBlockSpecs here are unresolved specs.
const nativeHeading = createHeadingBlockSpec({
  defaultLevel: 2,
  levels: [2, 3],
  allowToggleHeadings: false,
});
const parseHeading: NonNullable<typeof nativeHeading.implementation.parse> = (
  element,
) =>
  element.tagName === "H2" || element.tagName === "H3"
    ? {
        ...nativeHeading.implementation.parse?.(element),
        level: element.tagName === "H2" ? 2 : 3,
      }
    : undefined;
// BlockNote 0.55's erased registry declares parse as Partial<Props<PropSchema>>.
// Props' non-distributive primitive conditional maps that broad union to never,
// although actual concrete native parsers return primitive prop values. Bridge
// only this callback declaration: config/schema inference stays fully precise,
// and the canonical validator still checks every persisted property.
const registryHeadingParse = parseHeading as NonNullable<
  BlockSpecs[string]["implementation"]["parse"]
>;
const heading = {
  ...nativeHeading,
  config: {
    ...nativeHeading.config,
    propSchema: {
      ...fixedProps,
      level: { default: 2, values: [2, 3] },
    } as const,
  },
  implementation: {
    ...nativeHeading.implementation,
    // Retain the native runtime metadata without its declared optional
    // highlighting callback, whose props belong to the unrestricted schema.
    meta: { isolating: false },
    parse: registryHeadingParse,
  },
};

const managedImage = createReactBlockSpec(
  {
    type: "managedImage",
    propSchema: {
      refId: { default: "" },
      caption: { default: "" },
      alt: { default: "" },
      displayWidth: { default: 1 },
      cropX: { default: 0 },
      cropY: { default: 0 },
      cropWidth: { default: 1 },
      cropHeight: { default: 1 },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const {
        attachments,
        media,
        disabled,
        editImage,
        blockControls,
        applyImageCrop,
        applyImageWidth,
      } = useArticleAttachments();
      const reference = referenceEntry(attachments, block.props.refId);
      return (
        <figure className={styles.imageBlock} contentEditable={false}>
          {reference === undefined ? (
            <p role="alert">图片引用不可用，请重新选择。</p>
          ) : (
            <ArticleImageResize
              editor={editor}
              block={block}
              disabled={disabled || applyImageWidth === undefined}
              onApply={(width) =>
                applyImageWidth?.(block.id, block.props.refId, width) ?? false
              }
            >
              {media.render(reference, {
                alt: block.props.alt,
                active: !disabled,
                crop: getArticleImageCrop(block.props),
                ...(disabled || applyImageCrop === undefined
                  ? {}
                  : {
                      onCrop: (crop) =>
                        applyImageCrop(block.id, block.props.refId, crop),
                    }),
              })}
            </ArticleImageResize>
          )}
          <div className={styles.imageDetails}>
            {blockControls?.(block.id)}
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
      const { attachments, media, disabled, editGallery, blockControls } =
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
            {blockControls?.(block.id)}
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
    quote: { ...quote, config: { ...quote.config, propSchema: fixedProps } },
    divider: defaultBlockSpecs.divider,
    managedImage,
    imageGallery,
    catalogReference,
  },
  inlineContentSpecs: defaultInlineContentSpecs,
  styleSpecs: {
    bold: defaultStyleSpecs.bold,
    italic: defaultStyleSpecs.italic,
    underline: defaultStyleSpecs.underline,
    textColor,
    backgroundColor,
  },
});

export type ArticleBlockNoteEditor =
  typeof articleBlockNoteSchema.BlockNoteEditor;
