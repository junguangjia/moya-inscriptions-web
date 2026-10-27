import type {
  AccountCapacityClass,
  OperatorSubmissionMedia,
  OperatorWorkSubmission,
  PublishingJobAction,
  PublishingJobState,
} from "./api";

/**
 * The decisions the work publishing views offer, as plain functions so the
 * rules are testable without rendering. The Backend still decides finally;
 * these only keep the Owner from being offered something that cannot apply.
 */

/**
 * Only the work's latest explicit submission, still awaiting a decision, on a
 * work that is not in the recycle bin, can be approved or rejected.
 */
export const submissionDecidable = (
  submission: Pick<
    OperatorWorkSubmission,
    "disposition" | "latest" | "workTrashed"
  >,
): boolean =>
  submission.disposition === "pending" &&
  submission.latest &&
  !submission.workTrashed;

/** Why a pending submission offers no decision; null when it does, or is already decided. */
export const submissionUndecidableReason = (
  submission: Pick<
    OperatorWorkSubmission,
    "disposition" | "latest" | "workTrashed"
  >,
): string | null =>
  submission.disposition !== "pending" || submissionDecidable(submission)
    ? null
    : !submission.latest
      ? "已有更新的提交，只能审核最新提交"
      : "作品在回收站，不能审核；作者恢复作品后可再处理";

/** A failed or abandoned job can be queued again; a queued or failed job can be abandoned. */
export const publishingJobActions = (
  state: PublishingJobState,
): readonly PublishingJobAction[] =>
  state === "failed"
    ? ["retry", "abandon"]
    : state === "abandoned"
      ? ["retry"]
      : state === "queued"
        ? ["abandon"]
        : [];

export interface CapacityDesignationState {
  /** The account id the page is currently for (from the URL). */
  readonly account: string | null;
  /** The capacity on screen, which may still belong to a previous account. */
  readonly capacity: {
    readonly accountId: string;
    readonly capacityClass: AccountCapacityClass;
  } | null;
  readonly choice: AccountCapacityClass | null;
  readonly verified: boolean;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly retryPending: boolean;
}

/**
 * A class change is offered only for the account the page is for, once its
 * capacity has loaded, when the class actually changes, nothing else is in
 * flight, and an Owner designation was explicitly verified.
 */
export const capacityDesignationAllowed = (
  state: CapacityDesignationState,
): boolean =>
  state.account !== null &&
  state.capacity !== null &&
  state.capacity.accountId === state.account &&
  !state.loading &&
  !state.busy &&
  !state.retryPending &&
  state.choice !== null &&
  state.choice !== state.capacity.capacityClass &&
  (state.choice !== "owner" || state.verified);

type StillVariant = "thumb" | "display" | "cover";

export interface SubmissionPreview {
  readonly variant: StillVariant;
  /** The edit key that addresses `variant` of this item. */
  readonly editKey: string;
  /** Draw the cover crop over the image: it is the uncropped edited still. */
  readonly outline: boolean;
}

type CoverContext = Pick<OperatorWorkSubmission, "coverItemId" | "coverCrop">;

/**
 * Display, full and motion are keyed by the item's edit (`editKey`). Thumb
 * and cover are keyed by `coverEditKey` for the revision's cover item (its
 * edit and the cover crop, design §9.2) and by `editKey` for every other
 * item. Null when that key is not described (never guessed).
 */
export const submissionVariantKey = (
  submission: CoverContext,
  item: Pick<OperatorSubmissionMedia, "itemId" | "editKey" | "coverEditKey">,
  variant: OperatorSubmissionMedia["variants"][number],
): string | null => {
  if (variant !== "thumb" && variant !== "cover") return item.editKey;
  if (item.itemId !== submission.coverItemId) return item.editKey;
  return (
    item.coverEditKey ?? (submission.coverCrop === null ? item.editKey : null)
  );
};

/** The item's thumb is its album still only when no cover crop is keyed into it. */
const croppedCover = (
  submission: CoverContext,
  item: Pick<OperatorSubmissionMedia, "itemId">,
): boolean =>
  submission.coverCrop !== null && item.itemId === submission.coverItemId;

/**
 * The still for a numbered tile, or the larger preview of one item. Tiles
 * show the album image, so a cropped cover item (whose thumb is cropped to
 * the card cover) shows its display still.
 */
export const itemPreviewVariant = (
  submission: CoverContext,
  item: Pick<OperatorSubmissionMedia, "itemId" | "variants">,
  purpose: "tile" | "preview",
): "thumb" | "display" | null => {
  const thumb =
    item.variants.includes("thumb") && !croppedCover(submission, item);
  const display = item.variants.includes("display");
  if (purpose === "tile") return thumb ? "thumb" : display ? "display" : null;
  return display ? "display" : thumb ? "thumb" : null;
};

/**
 * The card cover: the author's chosen item, or the first item when none was
 * chosen. Its own cover derivative (or thumb) under the cover edit key, which
 * already applies the cover crop; otherwise the display still, outlined when
 * a crop was chosen.
 */
export const coverPreview = (
  submission: CoverContext & Pick<OperatorWorkSubmission, "items">,
): {
  readonly item: OperatorSubmissionMedia;
  readonly chosen: boolean;
  readonly preview: SubmissionPreview | null;
} | null => {
  const chosen = submission.coverItemId !== null;
  const item = chosen
    ? submission.items.find(
        (candidate) => candidate.itemId === submission.coverItemId,
      )
    : [...submission.items].sort((a, b) => a.position - b.position)[0];
  if (item === undefined) return null;
  const coverKey = submissionVariantKey(submission, item, "cover");
  const preview: SubmissionPreview | null =
    coverKey !== null && item.variants.includes("thumb")
      ? { variant: "thumb", editKey: coverKey, outline: false }
      : coverKey !== null && item.variants.includes("cover")
        ? { variant: "cover", editKey: coverKey, outline: false }
        : item.variants.includes("display")
          ? {
              variant: "display",
              editKey: item.editKey,
              outline: croppedCover(submission, item),
            }
          : null;
  return { item, chosen, preview };
};
