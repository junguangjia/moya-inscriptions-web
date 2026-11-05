"use client";

import { memo, useEffect, useState } from "react";
import { Icon } from "@moya/ui";

import {
  localCatalogMediaSrc,
  localCatalogRenditions,
} from "../../detail/local-catalog-media";
import {
  MEDIA_SIZES,
  mediaLoading,
  placeholderStyle,
  responsiveImage,
} from "../../media/responsive-media";
import { formatGap, formatYear, formatYearRange } from "./timeline-format";
import {
  TIMELINE_NOW_YEAR,
  timelineChapterInfo,
  timelineEntryMeta,
  timelineEntryTag,
  timelineMediaBox,
} from "./timeline-model";
import styles from "./timeline.module.css";

import type { RefCallback } from "react";
import type { TimelineChapter, TimelineEntry } from "@moya/contracts";
import type {
  TimelineEntryRow,
  TimelineGroupRow,
  TimelineMark,
  TimelineRow,
  TimelineRowLayout,
} from "./timeline-model";

export interface TimelineRowActions {
  readonly mediaFailed: () => void;
  /** Detail for a linked entry, otherwise its 词条卡. */
  readonly openEntry: (entry: TimelineEntry, opener: HTMLElement) => void;
  readonly openShelf: (chapter: TimelineChapter, opener: HTMLElement) => void;
  readonly toggleGroup: (row: TimelineGroupRow) => void;
  readonly expandMore: (key: string) => void;
}

export const TimelineMarkGlyph = ({ mark }: { readonly mark: TimelineMark }) =>
  mark === "none" ? null : (
    <span className={styles.mark} data-mark={mark}>
      {mark === "multi" ? (
        <>
          <i />
          <i />
          <i />
        </>
      ) : null}
    </span>
  );

/** The attributes the shell needs to return focus to a Detail opener. */
const catalogAttributes = (entry: TimelineEntry) =>
  entry.catalogId === null
    ? {}
    : { "data-open-catalog": "", "data-catalog-id": entry.catalogId };

const YearGutter = ({
  lines,
}: {
  readonly lines: readonly string[] | null;
}) => (
  <span className={styles.gutter}>
    {lines?.map((line) => (
      <span key={line}>{line}</span>
    ))}
  </span>
);

const TimelineRowMedia = ({
  entry,
  held,
  layout,
  listWidth,
  onFailed,
}: {
  readonly entry: TimelineEntry;
  readonly onFailed: () => void;
  readonly held: boolean;
  readonly layout: TimelineRowLayout;
  readonly listWidth: number;
}) => {
  const [failed, setFailed] = useState(false);
  // During a rail drag new rows keep an empty box; rows already on screen
  // keep their image. Loading resumes when the drag has stopped.
  const [armed, setArmed] = useState(!held);
  useEffect(() => {
    if (!held) setArmed(true);
  }, [held]);
  const { media, catalogId } = entry;
  if (media === null) return null;
  const box = timelineMediaBox(media, layout, listWidth);
  const content = () => {
    if (!armed) return null;
    if (failed) return null;
    const image = responsiveImage(
      {
        ...media,
        src:
          catalogId === null
            ? media.src
            : localCatalogMediaSrc(media.src, catalogId, media.id),
        renditions: localCatalogRenditions(media.renditions),
      },
      MEDIA_SIZES.timelineRow(media),
    );
    return (
      <img
        alt={media.alt}
        decoding="async"
        height={media.height}
        {...mediaLoading(undefined)}
        onError={() => {
          setFailed(true);
          onFailed();
        }}
        sizes={image.sizes}
        src={image.src}
        srcSet={image.srcSet}
        style={placeholderStyle(media.placeholderColor)}
        width={media.width}
      />
    );
  };
  return (
    <span
      className={styles.media}
      data-timeline-media={armed ? (failed ? "failed" : "image") : "held"}
      style={{ width: box.width, height: box.height }}
    >
      {content()}
    </span>
  );
};

const EntryRow = ({
  actions,
  layout,
  listWidth,
  mediaHeld,
  row,
}: {
  readonly actions: TimelineRowActions;
  readonly layout: TimelineRowLayout;
  readonly listWidth: number;
  readonly mediaHeld: boolean;
  readonly row: TimelineEntryRow;
}) => {
  const { entry } = row;
  const meta = timelineEntryMeta(entry, layout);
  const tag = timelineEntryTag(entry);
  return (
    <button
      className={styles.entry}
      onClick={(event) => actions.openEntry(entry, event.currentTarget)}
      type="button"
      {...catalogAttributes(entry)}
    >
      <YearGutter lines={row.yearLines} />
      <span className={styles.slot}>
        <TimelineMarkGlyph mark={row.mark} />
      </span>
      <span className={styles.content}>
        <span className={styles.text}>
          <span className={styles.title}>
            {entry.onAxis ? entry.title : entry.fullTitle}
          </span>
          {tag !== null || meta !== "" ? (
            <span className={styles.metaRow}>
              {tag === null ? null : (
                <span className={styles.tag} data-tag={tag.kind}>
                  {tag.text}
                </span>
              )}
              {meta === "" ? null : (
                <span
                  className={styles.metaText}
                  data-wraps={tag === null ? undefined : ""}
                >
                  {meta}
                </span>
              )}
            </span>
          ) : null}
        </span>
        <TimelineRowMedia
          entry={entry}
          held={mediaHeld}
          key={entry.media?.src}
          layout={layout}
          listWidth={listWidth}
          onFailed={actions.mediaFailed}
        />
      </span>
      {layout === "phone" ? null : (
        <>
          <span className={styles.column}>{entry.province}</span>
          <span className={styles.column}>{entry.holder}</span>
        </>
      )}
    </button>
  );
};

/**
 * The fold row and, once opened, the group's head. `pinned` is the copy the
 * wide chrome holds on a PC, where the row's own head cannot stay sticky.
 */
export const TimelineGroupToggle = ({
  actions,
  pinned = false,
  row,
}: {
  readonly actions: TimelineRowActions;
  readonly pinned?: boolean;
  readonly row: TimelineGroupRow;
}) => (
  <button
    aria-expanded={row.expanded}
    className={styles.groupToggle}
    onClick={() => actions.toggleGroup(row)}
    type="button"
    {...(pinned ? {} : { "data-timeline-group": row.groupKey })}
  >
    <YearGutter lines={row.yearLines} />
    <span className={styles.slot}>
      <TimelineMarkGlyph mark={row.mark} />
    </span>
    <span className={styles.groupBody}>
      <span className={styles.groupCard}>
        <span className={styles.groupTop}>
          <span className={styles.groupTitle}>{row.title}</span>
          <span className={styles.groupCount}>{row.entries.length} 件</span>
          {row.expanded ? (
            <span className={styles.groupCollapse}>收起</span>
          ) : (
            <Icon
              aria-hidden="true"
              className={styles.chevronDown}
              name="next"
            />
          )}
        </span>
        {row.expanded ? null : (
          <span className={styles.groupSummary}>{row.summary}</span>
        )}
      </span>
      {row.expanded ? null : (
        <>
          <span className={styles.groupEdge} data-edge="near" />
          <span className={styles.groupEdge} data-edge="far" />
        </>
      )}
    </span>
  </button>
);

const GroupRow = ({
  actions,
  row,
}: {
  readonly actions: TimelineRowActions;
  readonly row: TimelineGroupRow;
}) => (
  <div className={styles.group} data-expanded={row.expanded ? "" : undefined}>
    <TimelineGroupToggle actions={actions} row={row} />
    {row.expanded ? (
      <ul className={styles.members}>
        {row.entries.map((entry) => (
          <li key={entry.id}>
            <button
              className={styles.member}
              onClick={(event) => actions.openEntry(entry, event.currentTarget)}
              type="button"
              {...catalogAttributes(entry)}
            >
              {entry.onAxis ? entry.title : entry.fullTitle}
            </button>
          </li>
        ))}
      </ul>
    ) : null}
  </div>
);

const HeadRow = ({ chapter }: { readonly chapter: TimelineChapter }) => {
  const info = timelineChapterInfo(chapter);
  return (
    <div className={styles.head}>
      <span className={styles.gutter} />
      <span className={styles.slot} />
      <span className={styles.headBody}>
        <span className={styles.headName}>{info.name}</span>
        <span className={styles.headRange}>
          {formatYearRange(info.startYear, info.endYear)}
        </span>
      </span>
    </div>
  );
};

const EmptyRow = ({
  name,
  note,
  year,
}: {
  readonly name: string;
  readonly note: string | null;
  readonly year: string;
}) => (
  <div className={styles.empty}>
    <span className={styles.emptyYear}>{year}</span>
    <span className={styles.slot} data-spine="dotted" />
    <span className={styles.emptyBody}>
      <span className={styles.emptyName}>{name}</span>
      {note === null ? null : <span className={styles.emptyNote}>{note}</span>}
    </span>
  </div>
);

const TimelineRowBody = ({
  actions,
  layout,
  listWidth,
  mediaHeld,
  row,
}: {
  readonly actions: TimelineRowActions;
  readonly layout: TimelineRowLayout;
  readonly listWidth: number;
  readonly mediaHeld: boolean;
  readonly row: TimelineRow;
}) => {
  switch (row.kind) {
    case "head":
      return <HeadRow chapter={row.chapter} />;
    case "empty": {
      const info = timelineChapterInfo(row.chapter);
      return (
        <EmptyRow
          name={info.name}
          note={info.note}
          year={formatYear(info.startYear)}
        />
      );
    }
    case "marker":
      return (
        <EmptyRow name="今" note={null} year={String(TIMELINE_NOW_YEAR)} />
      );
    case "entry":
      return (
        <EntryRow
          actions={actions}
          layout={layout}
          listWidth={listWidth}
          mediaHeld={mediaHeld}
          row={row}
        />
      );
    case "group":
      return <GroupRow actions={actions} row={row} />;
    case "gap":
      return (
        <div className={styles.gap}>
          <span className={styles.gutter} />
          <span className={styles.slot} data-spine="dotted" />
          <span className={styles.gapText}>{formatGap(row.years)}</span>
        </div>
      );
    case "more":
      return (
        <button
          className={styles.more}
          onClick={() => actions.expandMore(row.moreKey)}
          type="button"
        >
          <span className={styles.gutter} />
          <span className={styles.slot} />
          <span className={styles.moreText}>另 {row.count} 条</span>
        </button>
      );
    case "shelf":
      return (
        <div className={styles.shelf}>
          <button
            className={styles.shelfPill}
            onClick={(event) =>
              actions.openShelf(row.chapter, event.currentTarget)
            }
            type="button"
          >
            <span>
              {timelineChapterInfo(row.chapter).shortName} · 其他 {row.count}
            </span>
            <Icon
              aria-hidden="true"
              className={styles.chevronRight}
              name="next"
            />
          </button>
        </div>
      );
  }
};

export const TimelineRowView = memo(function TimelineRowView({
  actions,
  index,
  layout,
  listWidth,
  mediaHeld,
  observeRow,
  row,
  rowCount,
  top,
}: {
  readonly actions: TimelineRowActions;
  readonly index: number;
  readonly layout: TimelineRowLayout;
  readonly listWidth: number;
  readonly mediaHeld: boolean;
  readonly observeRow: RefCallback<HTMLElement>;
  readonly row: TimelineRow;
  readonly rowCount: number;
  readonly top: number;
}) {
  return (
    <div
      aria-posinset={index + 1}
      aria-setsize={rowCount}
      className={styles.row}
      data-timeline-row={row.kind}
      data-timeline-row-size={"sizeKey" in row ? row.sizeKey : row.key}
      ref={observeRow}
      role="listitem"
      // Layout position, not a transform: a sticky group head resolves against it.
      style={{ top }}
    >
      <TimelineRowBody
        actions={actions}
        layout={layout}
        listWidth={listWidth}
        mediaHeld={mediaHeld}
        row={row}
      />
    </div>
  );
});
