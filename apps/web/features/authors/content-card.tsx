"use client";
import {
  localCatalogMediaSrc,
  localCatalogRenditions,
} from "../detail/local-catalog-media";
import type { ContentCard as Card } from "@moya/contracts";
import { CatalogCardMedia, CatalogProvinceBadge } from "../home/catalog-card";
import type { CatalogCardVariant } from "../home/catalog-card";
import { useFeedPostSlot } from "../home/catalog-masonry";
import type { MediaPriority } from "../media/responsive-media";
import { QuickActionCardAction } from "../quick-actions/quick-action-card-action";
import { useProductShell } from "../product-shell/product-shell";
import { useContentActions } from "./content-actions";
import { FeedPost } from "./feed-post";
import styles from "../home/home-screen.module.css";

/**
 * The UI-only name of an untitled work where a label is required (action
 * labels, share text); the stored title stays empty (C07).
 */
export const UNTITLED_WORK_LABEL = "未命名作品";

export const contentLabel = (item: Pick<Card, "target" | "title">) =>
  item.target.type === "work" && item.title === ""
    ? UNTITLED_WORK_LABEL
    : item.title;

export const ContentCard = ({
  item,
  onMediaSettled,
  priority,
  variant = "feed",
}: {
  item: Card;
  onMediaSettled?: () => void;
  /** Set by the list for the first cards of the first visible page only. */
  priority?: MediaPriority | undefined;
  variant?: CatalogCardVariant;
}) => {
  const label = contentLabel(item);
  const shell = useProductShell(),
    actions = useContentActions(item.target, label);
  const post = useFeedPostSlot() && variant === "feed";
  const excerpt = item.excerpt?.trim() ?? "";
  // A work without media is its text: no placeholder cover is invented (C07).
  const textOnly =
    item.target.type === "work" &&
    item.media === null &&
    (item.title !== "" || excerpt !== "");
  const metadata = variant === "inscription" && item.kind === "inscription";
  if (post)
    return (
      <FeedPost
        actions={actions}
        excerpt={excerpt}
        item={item}
        label={label}
        priority={priority}
        textOnly={textOnly}
        {...(onMediaSettled ? { onMediaSettled } : {})}
      />
    );
  return (
    <div>
      <article
        className={`${styles.card} ${variant === "inscription" ? styles.inscriptionCard : styles.feedCard}`}
        data-card-live={item.live === true && item.media ? "" : undefined}
        data-card-text-only={textOnly ? "" : undefined}
        data-catalog-card-variant={variant}
        data-catalog-id={
          item.target.type === "catalog" ? item.target.id : undefined
        }
        data-content-type={item.target.type}
        data-content-id={item.target.id}
        role={variant === "feed" ? "listitem" : undefined}
      >
        {textOnly ? (
          <div className={styles.cardText} data-card-text="">
            {item.title === "" ? null : (
              <h3 className={styles.cardTitle}>{item.title}</h3>
            )}
            {excerpt === "" ? null : (
              <p className={styles.cardExcerpt} data-card-excerpt="">
                {excerpt}
              </p>
            )}
          </div>
        ) : (
          <>
            <CatalogCardMedia
              live={item.live === true}
              media={
                item.media
                  ? {
                      ...item.media,
                      ...(item.target.type === "catalog"
                        ? {
                            src: localCatalogMediaSrc(
                              item.media.src,
                              item.target.id,
                              item.media.id,
                            ),
                            renditions: localCatalogRenditions(
                              item.media.renditions,
                            ),
                          }
                        : {}),
                      alt: label,
                    }
                  : undefined
              }
              priority={priority}
              title={label}
              variant={variant}
              {...(onMediaSettled ? { onMediaSettled } : {})}
            />
            {/* A media-only work omits its empty title rather than inventing one. */}
            {item.title === "" && excerpt === "" && !metadata ? null : (
              <div className={styles.cardBody}>
                {item.title !== "" ? (
                  <h3 className={styles.cardTitle}>{item.title}</h3>
                ) : excerpt === "" ? null : (
                  <p className={styles.cardSummary} data-card-excerpt="">
                    {excerpt}
                  </p>
                )}
                {metadata && <p className={styles.cardMetadata}>碑刻</p>}
              </div>
            )}
          </>
        )}
        {item.target.type === "catalog" ? (
          <CatalogProvinceBadge province={item.province} />
        ) : null}
        <QuickActionCardAction
          className={styles.cardAction}
          content={{
            kind: item.target.type,
            id: item.target.id,
            title: label,
          }}
          environment={actions.environment}
          onActivate={(opener) => shell.openContent(item.target, opener)}
        />
      </article>
    </div>
  );
};
