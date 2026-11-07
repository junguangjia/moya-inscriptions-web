"use client";

import { useEffect, useRef, useState } from "react";
import type { ContentCard as Card } from "@moya/contracts";
import { Icon } from "@moya/ui";

import {
  localCatalogMediaSrc,
  localCatalogRenditions,
} from "../detail/local-catalog-media";
import { desktopCardTitleParts } from "../home/desktop-card-frame";
import { mediaLoading, responsiveImage } from "../media/responsive-media";
import type { MediaPriority } from "../media/responsive-media";
import { QuickActionCardAction } from "../quick-actions/quick-action-card-action";
import { useProductShell } from "../product-shell/product-shell";
import type { PresentationPlatform } from "../shell/device-platform";
import { useContentActions } from "./content-actions";
import { useAuthors } from "./author-context";
import { ownWorkAudienceNote, useOwnWorkAudience } from "./own-work-audience";
import { contentLabel } from "./content-card";
import { VerticalText } from "./vertical-text";
import styles from "./profile-reading.module.css";

export interface ProfileReadingCardProps {
  readonly item: Card;
  /** One-based order among works, excluding the separate drafts entry. */
  readonly position: number;
  readonly platform: PresentationPlatform;
  readonly priority?: MediaPriority | undefined;
}

/** A complete cover in a bounded reading leaf, never a re-cropped thumbnail. */
const ReadingImage = ({
  item,
  label,
  priority,
}: Pick<ProfileReadingCardProps, "item" | "priority"> & {
  readonly label: string;
}) => {
  const media = item.media;
  const imageRef = useRef<HTMLImageElement>(null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const source =
    media === null
      ? null
      : item.target.type === "catalog"
        ? localCatalogMediaSrc(media.src, item.target.id, media.id)
        : media.src;

  useEffect(() => {
    const image = imageRef.current;
    if (source !== null && image?.complete && image.naturalWidth === 0)
      setFailedSource(source);
  }, [source, attempt]);

  if (media === null || source === null) return null;
  if (failedSource === source)
    return (
      <div className={styles.failedImage} data-reading-media-state="failed">
        <div
          className={styles.failureMessage}
          role="img"
          aria-label={`图像无法加载：${label}`}
        >
          <Icon aria-hidden="true" name="error" />
          <span>图像无法加载</span>
        </div>
        <button
          type="button"
          className={styles.retry}
          aria-label={`重试图像：${label}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setFailedSource(null);
            setAttempt((value) => value + 1);
          }}
        >
          重试
        </button>
      </div>
    );
  const candidates =
    item.target.type === "catalog"
      ? localCatalogRenditions(media.renditions)
      : media.renditions;
  const image = responsiveImage(
    {
      ...media,
      src: source,
      ...(candidates === undefined ? {} : { renditions: candidates }),
    },
    // Upper bounds of the two-column leaves; responsiveImage still caps candidates
    // at the supplied card anchor, never at a Viewer's larger zoom renditions.
    "(min-width: 896px) min(42vw, 560px), calc((100vw - 44px) / 2)",
  );
  return (
    <img
      key={`${source}:${attempt}`}
      ref={imageRef}
      className={styles.image}
      alt={label}
      width={media.width}
      height={media.height}
      decoding="async"
      {...mediaLoading(priority)}
      {...image}
      onError={() => setFailedSource(source)}
      data-reading-media-state="valid"
    />
  );
};

export const ProfileReadingCard = ({
  item,
  position,
  platform,
  priority,
}: ProfileReadingCardProps) => {
  const shell = useProductShell();
  const label = contentLabel(item);
  const actions = useContentActions(item.target, label);
  const author = useAuthors();
  const viewerId = author.viewer?.id ?? null;
  const audience = useOwnWorkAudience(
    !author.checking &&
      !author.sessionError &&
      viewerId !== null &&
      viewerId === item.authorId
      ? viewerId
      : null,
    item.target.type === "work" ? item.target.id : null,
  );
  const audienceNote =
    audience?.publiclyVisible === false ? ownWorkAudienceNote(audience) : null;
  const audienceLabel =
    audienceNote === null
      ? null
      : audience?.visibility === "self"
        ? "仅自己可见"
        : "暂不公开";
  const excerpt = item.excerpt?.trim() ?? "";
  const textOnly = item.target.type === "work" && item.media === null;
  const title = desktopCardTitleParts(item.title);
  const copy = item.title || excerpt;
  // A Latin title gets its own horizontal line; mixed Chinese/Latin text keeps
  // real vertical layout and the browser's mixed-script orientation.
  const verticalTitle = platform === "pc" || /\p{Script=Han}/u.test(copy);
  const verticalBody = textOnly && platform === "pc";
  const hasCaption = item.title !== "" || excerpt !== "";
  const count =
    item.mediaCount ?? item.gallery?.length ?? (item.media === null ? 0 : 1);
  const kind =
    item.target.type === "work"
      ? "作品"
      : item.kind === "calligraphy"
        ? "书帖"
        : item.kind === "inscription"
          ? "碑刻"
          : "";
  const display = (value: string) =>
    (!textOnly && verticalTitle) || verticalBody ? (
      <VerticalText text={value} />
    ) : (
      value
    );

  return (
    <article
      className={`${styles.card}${textOnly ? ` ${styles.textOnly}` : ""}${!verticalTitle && !textOnly ? ` ${styles.horizontalTitle}` : ""}${!hasCaption ? ` ${styles.noCaption}` : ""}`}
      role="listitem"
      data-profile-reading-card=""
      data-reading-platform={platform}
      data-reading-position={position}
      data-reading-text-only={textOnly ? "" : undefined}
      data-content-type={item.target.type}
      data-content-id={item.target.id}
      data-catalog-id={
        item.target.type === "catalog" ? item.target.id : undefined
      }
    >
      <div className={styles.leaf}>
        {textOnly && !hasCaption ? (
          <p className={styles.empty}>暂无可预览的内容</p>
        ) : null}
        {item.media !== null ? (
          <div className={styles.media}>
            <ReadingImage
              key={`${item.target.type}:${item.target.id}:${item.media.src}`}
              item={item}
              label={label}
              priority={priority}
            />
          </div>
        ) : !textOnly ? (
          <div
            className={styles.failedImage}
            role="img"
            aria-label={`暂无公开图像：${label}`}
            data-reading-media-state="missing"
          >
            <Icon aria-hidden="true" name="image" />
            <span>暂无公开图像</span>
          </div>
        ) : null}
        {hasCaption ? (
          <div className={styles.caption}>
            {item.title !== "" ? (
              <h3
                className={styles.title}
                title={item.title}
                aria-label={item.title}
              >
                <span>{display(title.primary)}</span>
                {title.suffix !== "" ? (
                  <span className={styles.titleSuffix}>
                    {display(title.suffix)}
                  </span>
                ) : null}
              </h3>
            ) : null}
            {excerpt !== "" && (textOnly || item.title === "") ? (
              <p className={styles.excerpt} data-card-excerpt="">
                {display(excerpt)}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className={styles.footer}>
        <span className={styles.ordinal} aria-label={`第 ${position} 项`}>
          {String(position).padStart(2, "0")}
        </span>
        {item.target.type === "catalog" && kind !== "" ? (
          <span className={styles.kind}>{kind}</span>
        ) : null}
        {audienceLabel !== null ? (
          <span
            className={styles.audience}
            title={audienceNote ?? undefined}
            data-reading-audience=""
          >
            {audienceLabel}
          </span>
        ) : null}
        <div className={styles.badges}>
          {item.media !== null && item.live === true ? (
            <span className={styles.badge} role="img" aria-label="实况照片">
              LIVE
            </span>
          ) : null}
          {count > 1 ? (
            <span
              className={styles.badge}
              role="img"
              aria-label={`${count} 张图像`}
            >
              {count} 图
            </span>
          ) : null}
        </div>
      </div>
      {shell.browseOnly === true ? (
        <button
          type="button"
          className={styles.action}
          aria-label={`打开${label}`}
          onClick={(event) =>
            shell.openContent(item.target, event.currentTarget)
          }
        />
      ) : (
        <QuickActionCardAction
          className={styles.action}
          content={{ kind: item.target.type, id: item.target.id, title: label }}
          environment={actions.environment}
          onActivate={(opener) => shell.openContent(item.target, opener)}
        />
      )}
    </article>
  );
};
