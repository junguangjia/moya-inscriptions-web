import type { ReactNode } from "react";
import type {
  ArticleBlock,
  ArticleDocument,
  ArticleInlineContent,
  ArticleMediaReference,
  CatalogId,
  MediaCrop,
} from "@moya/contracts";
import styles from "./article-rich-body.module.css";
import { getArticleImageCrop } from "./article-image-layout";

interface ReaderProps {
  readonly document: ArticleDocument;
  /**
   * `share` is the figure's width as a share of the body column (a resized
   * image's display width; 1 otherwise), so a reader can size the image.
   */
  readonly renderMedia: (
    reference: ArticleMediaReference,
    alt: string,
    crop: MediaCrop | null,
    share: number,
  ) => ReactNode;
  readonly renderCatalog: (id: CatalogId) => ReactNode;
}
const inlineText = (content: readonly ArticleInlineContent[]): string =>
  content
    .map((part) =>
      part.type === "text"
        ? part.text
        : part.content.map((span) => span.text).join(""),
    )
    .join("");

export const articleHeadingNavigation = (document: ArticleDocument) =>
  document.blocks.flatMap((block) =>
    block.type === "heading"
      ? [
          {
            id: `article-block-${block.id}`,
            title: inlineText(block.content),
            level: block.props.level,
          },
        ]
      : [],
  );

const styledText = (
  part: Extract<ArticleInlineContent, { type: "text" }>,
): ReactNode => {
  let value: ReactNode = part.text;
  if (part.styles.italic) value = <em>{value}</em>;
  if (part.styles.bold) value = <strong>{value}</strong>;
  if (part.styles.underline) value = <u>{value}</u>;
  if (part.styles.textColor)
    value = (
      <span data-article-text-color={part.styles.textColor}>{value}</span>
    );
  if (part.styles.backgroundColor)
    value = (
      <span data-article-background-color={part.styles.backgroundColor}>
        {value}
      </span>
    );
  return value;
};
const inline = (content: readonly ArticleInlineContent[]) =>
  content.map((part, index) =>
    part.type === "text" ? (
      <span key={index}>{styledText(part)}</span>
    ) : (
      <a key={index} href={part.href} target="_blank" rel="noreferrer noopener">
        {part.content.map((span, child) => (
          <span key={child}>{styledText(span)}</span>
        ))}
      </a>
    ),
  );

const blockFormatting = (
  block: Extract<
    ArticleBlock,
    {
      type:
        | "paragraph"
        | "heading"
        | "quote"
        | "bulletListItem"
        | "numberedListItem";
    }
  >,
) => ({
  "data-article-text-alignment": block.props.textAlignment ?? "left",
  "data-article-line-spacing": block.props.lineSpacing ?? "normal",
});

/** Semantic reader content. No BlockNote, Tiptap or ProseMirror import path. */
export const ArticleRichBody = ({
  document,
  renderMedia,
  renderCatalog,
}: ReaderProps) => {
  const reference = (
    id: string,
    alt: string,
    crop: MediaCrop | null = null,
    share = 1,
  ): ReactNode => {
    const value = Object.hasOwn(document.references, id)
      ? document.references[id]
      : undefined;
    return value === undefined ? (
      <p role="status">图片引用不可用。</p>
    ) : (
      renderMedia(value, alt, crop, share)
    );
  };
  const render = (block: ArticleBlock): ReactNode => {
    const id = `article-block-${block.id}`;
    switch (block.type) {
      case "paragraph":
        return (
          <p id={id} key={block.id} {...blockFormatting(block)}>
            {inline(block.content)}
          </p>
        );
      case "heading":
        return block.props.level === 2 ? (
          <h3 id={id} key={block.id} {...blockFormatting(block)}>
            {inline(block.content)}
          </h3>
        ) : (
          <h4 id={id} key={block.id} {...blockFormatting(block)}>
            {inline(block.content)}
          </h4>
        );
      case "quote":
        return (
          <blockquote id={id} key={block.id} {...blockFormatting(block)}>
            <p>{inline(block.content)}</p>
          </blockquote>
        );
      case "divider":
        return <hr id={id} key={block.id} />;
      case "managedImage":
        return (
          <figure
            id={id}
            key={block.id}
            className={styles.resizedImage}
            style={{ width: `${(block.props.displayWidth ?? 1) * 100}%` }}
            data-article-image-wrap={
              (block.props.displayWidth ?? 1) < 0.99 ? "true" : "false"
            }
          >
            {reference(
              block.props.refId,
              block.props.alt,
              getArticleImageCrop(block.props),
              block.props.displayWidth ?? 1,
            )}
            {block.props.caption ? (
              <figcaption>{block.props.caption}</figcaption>
            ) : null}
          </figure>
        );
      case "imageGallery": {
        const gallery = Object.hasOwn(document.galleries, block.props.groupId)
          ? document.galleries[block.props.groupId]
          : undefined;
        return (
          <div
            id={id}
            key={block.id}
            className={styles.gallery}
            aria-label="图片组"
          >
            {gallery === undefined ? (
              <p role="status">图片组不可用。</p>
            ) : (
              gallery.referenceIds.map((refId) => (
                <figure key={refId}>{reference(refId, "")}</figure>
              ))
            )}
          </div>
        );
      }
      case "catalogReference":
        return (
          <aside id={id} key={block.id} aria-label="藏品引用">
            {renderCatalog(block.props.catalogId)}
          </aside>
        );
      case "bulletListItem":
      case "numberedListItem":
        return (
          <li
            id={id}
            key={block.id}
            {...blockFormatting(block)}
            {...(block.type === "numberedListItem" &&
            block.props.start !== undefined
              ? { value: block.props.start }
              : {})}
          >
            {inline(block.content)}
            {sequence(block.children)}
          </li>
        );
    }
  };
  const sequence = (blocks: readonly ArticleBlock[]): ReactNode[] => {
    const output: ReactNode[] = [];
    for (let index = 0; index < blocks.length;) {
      const block = blocks[index]!;
      if (
        block.type !== "bulletListItem" &&
        block.type !== "numberedListItem"
      ) {
        output.push(render(block));
        index++;
        continue;
      }
      const group: ArticleBlock[] = [block];
      index++;
      while (index < blocks.length && blocks[index]!.type === block.type)
        group.push(blocks[index++]!);
      const items = group.map(render);
      output.push(
        block.type === "bulletListItem" ? (
          <ul key={`list-${block.id}`}>{items}</ul>
        ) : (
          <ol key={`list-${block.id}`} start={block.props.start ?? 1}>
            {items}
          </ol>
        ),
      );
    }
    return output;
  };
  return (
    <div className={styles.body} data-article-rich-body="">
      {sequence(document.blocks)}
    </div>
  );
};
