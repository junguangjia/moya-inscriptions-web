"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type {
  ArticleBlock,
  ArticleInlineContent,
  MediaCrop,
} from "@moya/contracts";
import type { ArticlePendingPreview } from "./api";
import { articleLineHeight, lightTheme } from "@moya/ui";
import styles from "./community.module.css";

/** Never render managed public DTO URLs: pending bytes use the Owner-only relay. */
export const articleSubmissionMediaSrc = (
  candidate: ArticlePendingPreview,
  refId: string,
  variant: "display" | "motion",
) =>
  `/api/community-moderation/article-submission-media/${encodeURIComponent(candidate.articleId)}?${new URLSearchParams(
    {
      expectedVersion: String(candidate.expectedVersion),
      candidateVersion: String(candidate.candidateVersion),
      fingerprint: candidate.fingerprint,
      refId,
      variant,
    },
  )}`;

const textColors = {
  default: lightTheme["text-primary"],
  gray: lightTheme["text-secondary"],
  red: lightTheme["seal-red"],
  brown: lightTheme["ink-gray"],
} as const;
const backgroundColors = {
  default: "transparent",
  gray: lightTheme["background-muted"],
  red: lightTheme["seal-red-muted"],
  brown: lightTheme["border-default"],
} as const;

const text = (
  part: Extract<ArticleInlineContent, { type: "text" }>,
): ReactNode => {
  let value: ReactNode = part.text;
  if (part.styles.bold) value = <strong>{value}</strong>;
  if (part.styles.italic) value = <em>{value}</em>;
  if (part.styles.underline) value = <u>{value}</u>;
  return (
    <span
      data-article-text-color={part.styles.textColor}
      data-article-background-color={part.styles.backgroundColor}
      style={{
        ...(part.styles.textColor === undefined
          ? {}
          : { color: textColors[part.styles.textColor] }),
        ...(part.styles.backgroundColor === undefined
          ? {}
          : { backgroundColor: backgroundColors[part.styles.backgroundColor] }),
      }}
    >
      {value}
    </span>
  );
};
const inline = (content: readonly ArticleInlineContent[]) =>
  content.map((part, i) =>
    part.type === "text" ? (
      <span key={i}>{text(part)}</span>
    ) : (
      <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">
        {part.content.map((span, j) => (
          <span key={j}>{text(span)}</span>
        ))}
      </a>
    ),
  );

/** Still and motion use the same crop frame; playback controls stay outside it. */
const CandidateMedia = ({
  src,
  motion,
  alt,
  width,
  height,
  crop,
  onLoad,
  onMotionReady,
  onFailure,
}: {
  readonly src: string;
  readonly motion: string | null;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
  readonly crop: MediaCrop | null;
  readonly onLoad: () => void;
  readonly onMotionReady: () => void;
  readonly onFailure: () => void;
}) => {
  const video = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const effective = crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const frame: CSSProperties = {
    position: "absolute",
    width: `${100 / effective.width}%`,
    height: `${100 / effective.height}%`,
    maxWidth: "none",
    objectFit: "fill",
    left: `${(-effective.x / effective.width) * 100}%`,
    top: `${(-effective.y / effective.height) * 100}%`,
  };
  return (
    <>
      <div
        data-article-media-frame=""
        style={{
          position: "relative",
          overflow: "hidden",
          width: "100%",
          aspectRatio: `${width * effective.width} / ${height * effective.height}`,
        }}
      >
        <img
          src={src}
          alt={alt}
          referrerPolicy="no-referrer"
          style={frame}
          onLoad={onLoad}
          onError={onFailure}
        />
        {motion === null ? null : (
          <video
            ref={video}
            preload="metadata"
            playsInline
            src={motion}
            aria-label={alt || "实况图片"}
            style={{ ...frame, visibility: playing ? "visible" : "hidden" }}
            onLoadedMetadata={onMotionReady}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onError={() => {
              setPlaying(false);
              onFailure();
            }}
          />
        )}
      </div>
      {motion === null ? null : (
        <button
          type="button"
          aria-pressed={playing}
          onClick={async () => {
            const element = video.current;
            if (element === null) return;
            if (playing) element.pause();
            else
              try {
                await element.play();
              } catch {
                setPlaying(false);
                onFailure();
              }
          }}
        >
          {playing ? "暂停实况" : "播放实况"}
        </button>
      )}
    </>
  );
};

/** Semantic, read-only candidate document. React text nodes never interpret stored HTML. */
export const ArticleSubmissionPreview = ({
  candidate,
  onAvailabilityChange,
}: {
  readonly candidate: ArticlePendingPreview;
  readonly onAvailabilityChange?: (ready: boolean) => void;
}) => {
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  // The shared preview schema requires exactly the used document/cover refs.
  const required = Object.entries(candidate.resolvedReferences).flatMap(
    ([refId, resolved]) => [
      refId,
      ...(resolved.type === "managed" &&
      resolved.media.kind === "live" &&
      resolved.media.motionSrc !== undefined
        ? [`${refId}:motion`]
        : []),
    ],
  );
  const available = required.every(
    (refId) => loaded.has(refId) && !failed.has(refId),
  );
  useEffect(() => {
    onAvailabilityChange?.(available);
  }, [available, onAvailabilityChange]);
  const mark = (refId: string, ok: boolean) => {
    if (ok) setLoaded((prior) => new Set([...prior, refId]));
    else setFailed((prior) => new Set([...prior, refId]));
  };
  const media = (refId: string, alt: string, crop: MediaCrop | null = null) => {
    const resolved = candidate.resolvedReferences[refId];
    if (resolved === undefined || resolved.type === "unavailable")
      return <p role="alert">此版本的图片引用当前不可用，请刷新后再审核。</p>;
    const asset = resolved.media;
    const src =
      resolved.type === "managed"
        ? articleSubmissionMediaSrc(candidate, refId, "display")
        : asset.src;
    const motion =
      resolved.type === "managed" &&
      resolved.media.kind === "live" &&
      resolved.media.motionSrc !== undefined
        ? articleSubmissionMediaSrc(candidate, refId, "motion")
        : null;
    return (
      <>
        <CandidateMedia
          src={src}
          motion={motion}
          alt={alt}
          width={asset.width}
          height={asset.height}
          crop={crop}
          onLoad={() => mark(refId, true)}
          onMotionReady={() => mark(`${refId}:motion`, true)}
          onFailure={() => mark(refId, false)}
        />
        {failed.has(refId) ? (
          <p role="alert">图片加载失败。请刷新详情后再审核。</p>
        ) : null}
      </>
    );
  };
  const render = (block: ArticleBlock): ReactNode => {
    const children = sequence(block.children);
    if ("content" in block) {
      const content = inline(block.content);
      const formatting: CSSProperties = {
        textAlign: block.props.textAlignment ?? "left",
        lineHeight: articleLineHeight[block.props.lineSpacing ?? "normal"],
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      };
      switch (block.type) {
        case "heading":
          return (
            <section key={block.id}>
              {block.props.level === 2 ? (
                <h3 style={formatting}>{content}</h3>
              ) : (
                <h4 style={formatting}>{content}</h4>
              )}
              {children}
            </section>
          );
        case "quote":
          return (
            <blockquote key={block.id} style={formatting}>
              {content}
              {children}
            </blockquote>
          );
        case "bulletListItem":
        case "numberedListItem":
          return (
            <li
              key={block.id}
              style={formatting}
              value={
                block.type === "numberedListItem"
                  ? block.props.start
                  : undefined
              }
            >
              {content}
              {children}
            </li>
          );
        default:
          return (
            <div key={block.id}>
              <p style={formatting}>{content}</p>
              {children}
            </div>
          );
      }
    }
    switch (block.type) {
      case "divider":
        return (
          <div key={block.id}>
            <hr />
            {children}
          </div>
        );
      case "managedImage": {
        const p = block.props;
        const crop =
          p.cropX === undefined
            ? null
            : {
                x: p.cropX,
                y: p.cropY!,
                width: p.cropWidth!,
                height: p.cropHeight!,
              };
        return (
          <figure
            key={block.id}
            style={{
              width: `${(p.displayWidth ?? 1) * 100}%`,
              marginInline: 0,
            }}
          >
            {media(p.refId, p.alt, crop)}
            <figcaption>{p.caption}</figcaption>
            {children}
          </figure>
        );
      }
      case "imageGallery":
        return (
          <section key={block.id} aria-label="图片组">
            {candidate.document.galleries[
              block.props.groupId
            ]?.referenceIds.map((refId) => (
              <figure key={refId}>{media(refId, "")}</figure>
            ))}
            {children}
          </section>
        );
      case "catalogReference":
        return (
          <aside key={block.id} aria-label="藏品引用">
            藏品标识：{block.props.catalogId}
            {children}
          </aside>
        );
    }
  };
  const sequence = (blocks: readonly ArticleBlock[]): ReactNode[] => {
    const rendered: ReactNode[] = [];
    for (let i = 0; i < blocks.length;) {
      const block = blocks[i++]!;
      if (
        block.type !== "bulletListItem" &&
        block.type !== "numberedListItem"
      ) {
        rendered.push(render(block));
        continue;
      }
      const group = [block];
      while (i < blocks.length && blocks[i]!.type === block.type)
        group.push(blocks[i++]! as typeof block);
      rendered.push(
        block.type === "bulletListItem" ? (
          <ul key={block.id}>{group.map(render)}</ul>
        ) : (
          <ol key={block.id} start={block.props.start ?? 1}>
            {group.map(render)}
          </ol>
        ),
      );
    }
    return rendered;
  };
  return (
    <section
      className={styles.fullText}
      aria-label="提交版本正文"
      data-article-candidate={candidate.candidateVersion}
    >
      {candidate.coverRefId === null ? null : (
        <figure>
          {media(candidate.coverRefId, "文章封面")}
          <figcaption>文章封面</figcaption>
        </figure>
      )}
      {sequence(candidate.document.blocks)}
      {!available && required.length > 0 ? (
        <p role="status">
          图片尚未全部可见，暂不能通过。可刷新详情或拒绝本次提交。
        </p>
      ) : null}
    </section>
  );
};
