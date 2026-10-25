import { normalizeFeed, sameEdit, sameFeed } from "../media/media-geometry";

import type {
  PublishingDeviceClass,
  PublishingDraftSummary,
  WorkAuthorship,
  WorkDraftContent,
  WorkSnapshotKind,
  WorkVisibility,
} from "@moya/contracts";

/**
 * Presentation-only wording for drafts, history, conflicts and the recycle
 * bin. Nothing here is stored: the unnamed placeholder, excerpts and time
 * labels exist only on these surfaces (C07).
 */

export const UNNAMED_WORK = "未命名作品";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The stored title as shown, or the UI-only placeholder when it is empty. */
export const displayTitle = (title: string): string => {
  const trimmed = title.trim();
  return trimmed === "" ? UNNAMED_WORK : trimmed;
};

/** 新作品 / 编辑「标题」: what a draft is about to become. */
export const draftKindLabel = (
  draft: Pick<PublishingDraftSummary, "kind" | "title">,
): string =>
  draft.kind === "new" ? "新作品" : `编辑「${displayTitle(draft.title)}」`;

/** A name that identifies exactly one draft in confirmation text. */
export const draftName = (
  draft: Pick<PublishingDraftSummary, "kind" | "title">,
): string =>
  draft.kind === "new"
    ? `新作品草稿「${displayTitle(draft.title)}」`
    : `「${displayTitle(draft.title)}」的编辑草稿`;

/**
 * Plain-text excerpt: line breaks normalized, outer whitespace trimmed, cut
 * at a code-point boundary so a character is never split.
 */
export const textExcerpt = (text: string, maximum = 80): string => {
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  const points = [...normalized];
  return points.length <= maximum
    ? normalized
    : `${points.slice(0, maximum).join("").trimEnd()}…`;
};

/** Relative for the first week, then the calendar date; never a guessed time. */
export const relativeTime = (iso: string, now: Date): string => {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const elapsed = now.getTime() - at;
  if (elapsed < MINUTE) return "刚刚";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} 分钟前`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} 小时前`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(at));
};

/** Full local date and time for a `title` attribute or screen readers. */
export const absoluteTime = (iso: string): string => {
  const at = Date.parse(iso);
  return Number.isNaN(at)
    ? ""
    : new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(at));
};

export const mediaCountText = (count: number): string =>
  count === 0 ? "无图片" : `${count} 项图片`;

export const snapshotKindLabels = {
  saved: "已保存",
  submitted: "已提交",
  published: "已发布",
  conflict: "冲突副本",
  restored: "已恢复",
  legacy_draft: "早期草稿",
} as const satisfies Record<WorkSnapshotKind, string>;

export const deviceClassLabels = {
  phone: "手机",
  tablet: "平板",
  desktop: "电脑",
} as const satisfies Record<PublishingDeviceClass, string>;

export const visibilityLabels = {
  public: "公开",
  self: "仅自己可见",
} as const satisfies Record<WorkVisibility, string>;

export const authorshipLabels = {
  original: "原创",
  copy_practice: "临摹或练习",
  material_sharing: "素材分享",
} as const satisfies Record<WorkAuthorship["kind"], string>;

/** How an undeclared 作品性质 reads; nothing defaults to 原创 (C05). */
export const AUTHORSHIP_UNSET_LABEL = "未设置";

/** The label of a declared authorship, or 未设置 when the author set none. */
export const authorshipLabel = (authorship: WorkAuthorship | null): string =>
  authorship === null
    ? AUTHORSHIP_UNSET_LABEL
    : authorshipLabels[authorship.kind];

/** The optional reference fields of a copy/practice or material-sharing work. */
export const authorshipDetails = (
  authorship: WorkAuthorship | null,
): readonly { readonly label: string; readonly value: string }[] => {
  if (authorship === null || authorship.kind === "original") return [];
  return [
    { label: "参考作品", value: authorship.referenceTitle?.trim() ?? "" },
    { label: "原作者", value: authorship.originalAuthor?.trim() ?? "" },
    { label: "来源", value: authorship.sourceNote?.trim() ?? "" },
  ].filter((detail) => detail.value !== "");
};

/**
 * The account's drafts, newest edited first (D03). The Backend already
 * answers in this order; merged pages keep it even when a draft was edited
 * between two page reads.
 */
export const newestEditedFirst = (
  a: Pick<PublishingDraftSummary, "id" | "updatedAt">,
  b: Pick<PublishingDraftSummary, "id" | "updatedAt">,
): number => {
  const order = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  if (order !== 0 && !Number.isNaN(order)) return order;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
};

/**
 * Items that never reached the account (no item id). Their files exist only
 * where they were chosen and no local copy can bring them back, so the
 * author chooses them again. Items registered but not fully received are
 * found only when the draft opens.
 */
export const missingLocalText = (count: number): string =>
  `${count} 项尚未上传，打开后需重新选择文件`;

/**
 * A rotation, crop or feed framing the thumbnails cannot show (they are the
 * unedited image). A framing is named only when it is the author's choice
 * and not the photo's default (whole when uncropped, else a centred cover).
 */
export const itemEditText = (
  edit: WorkDraftContent["items"][number]["edit"],
): string | null => {
  const feed = normalizeFeed(edit.feed, edit);
  const parts = [
    edit.rotation === 0 ? null : `已旋转 ${edit.rotation}°`,
    edit.crop === null ? null : "已裁剪",
    feed === undefined
      ? null
      : feed.fit === "contain"
        ? "动态流整张显示"
        : "动态流显示局部",
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join("、");
};

/** Text notes for every edit in one version, in item order, then the cover crop. */
export const mediaEditNotes = (content: WorkDraftContent): string[] => [
  ...content.items.flatMap((item, index) => {
    const text = itemEditText(item.edit);
    return text === null ? [] : [`第 ${index + 1} 项${text}`];
  }),
  ...(content.coverCrop === null || content.coverKey === null
    ? []
    : ["封面已裁剪"]),
];

/**
 * What the draft deletion removes, naming exactly this draft: its history,
 * its conflict copies and the media only they reference. Other drafts and
 * any work revision are never part of it (D06).
 */
export const draftDeletionScopeText = (
  draft: Pick<PublishingDraftSummary, "kind" | "title" | "updatedAt">,
  now: Date,
): string => {
  const when = relativeTime(draft.updatedAt, now);
  const edited = when === "" ? "" : `（${when}编辑）`;
  const keeps =
    draft.kind === "edit"
      ? "其他草稿和已发布的作品不受影响，作品当前的内容保持不变。"
      : "其他草稿和已发布的作品不受影响。";
  return `将删除${draftName(draft)}${edited}，以及它的历史版本、冲突副本和只被它使用的图片。${keeps}删除后无法恢复。`;
};

export interface ContentComparison {
  readonly title: boolean;
  readonly body: boolean;
  readonly media: boolean;
  readonly cover: boolean;
  readonly settings: boolean;
}

const sameAuthorship = (
  a: WorkAuthorship | null,
  b: WorkAuthorship | null,
): boolean =>
  (a?.kind ?? null) === (b?.kind ?? null) &&
  JSON.stringify(authorshipDetails(a)) === JSON.stringify(authorshipDetails(b));

/**
 * Which parts of two versions differ, for the conflict chooser's markers.
 * An item's edit differs by its pixels or its feed framing, both of which
 * the chooser names (`itemEditText`).
 */
export const compareContent = (
  a: WorkDraftContent,
  b: WorkDraftContent,
): ContentComparison => ({
  title: a.title.trim() !== b.title.trim(),
  body:
    a.body.replace(/\r\n?/gu, "\n").trim() !==
    b.body.replace(/\r\n?/gu, "\n").trim(),
  media:
    a.items.length !== b.items.length ||
    a.items.some((item, index) => {
      const other = b.items[index];
      return (
        other === undefined ||
        other.key !== item.key ||
        other.itemId !== item.itemId ||
        !sameEdit(other.edit, item.edit) ||
        !sameFeed(other.edit.feed, item.edit.feed, item.edit)
      );
    }),
  cover:
    a.coverKey !== b.coverKey ||
    JSON.stringify(a.coverCrop) !== JSON.stringify(b.coverCrop),
  settings:
    a.visibility !== b.visibility ||
    !sameAuthorship(a.authorship, b.authorship),
});
