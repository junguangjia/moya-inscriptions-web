import { useMemo } from "react";

import { resolveStageAspect } from "../../../authors/feed-post-strip-geometry";
import { useEditorMediaSources } from "../editor/preview";
import { editedSize } from "./media-geometry";

import type { FeedStagePreviewSlide } from "../../../media-composer/feed-stage-preview";
import type { UploadManagerSnapshot } from "../../upload-manager";
import type { EditorSessionState } from "../editor/editor-session-state";
import type { EditorMediaScope } from "../editor/preview";

/**
 * The feed shows at most this many of a post's images (the contract's
 * `CARD_GALLERY_MAXIMUM`; kept local so no contract runtime reaches the
 * client, and checked against it in the test).
 */
export const FEED_GALLERY_MAXIMUM = 10;

export interface FeedStageModel {
  readonly slides: readonly FeedStagePreviewSlide[];
  readonly total: number;
  /** The stage's height / width from the first slide's edited frame; 1 while unknown. */
  readonly stageRatio: number;
  /** Items whose edit could not be drawn (shown unedited). */
  readonly unedited: number;
}

/**
 * The composer's stage preview slides (#244) from the editor's own media
 * sources, in content order and capped at the feed's gallery size. Only the
 * items in `scope` get a picture (a screen without the stage asks for the
 * first one, whose size still sets the stage ratio). An item whose edited
 * frame is still being drawn keeps its edited shape as a placeholder, so the
 * stage never jumps when the picture lands.
 */
export const useFeedStageSlides = (
  state: EditorSessionState,
  uploads: UploadManagerSnapshot | null,
  localStill: (key: string) => Blob | null,
  scope: EditorMediaScope,
): FeedStageModel => {
  const media = useEditorMediaSources(state, uploads, localStill, scope);
  const idle = scope === "none";
  return useMemo(() => {
    const sources = new Map(
      media.sources.map((source) => [source.key, source]),
    );
    const views = new Map(
      (uploads?.items ?? []).map((item) => [item.key, item]),
    );
    const slides = state.items
      .slice(0, FEED_GALLERY_MAXIMUM)
      .map((item, index): FeedStagePreviewSlide => {
        const alt = `第 ${index + 1} 项`;
        const source = sources.get(item.key);
        if (source !== undefined && source.pending !== true)
          return {
            key: item.key,
            alt,
            src: source.src,
            size: { width: source.width, height: source.height },
            status: "ready",
          };
        if (source !== undefined)
          return {
            key: item.key,
            alt,
            src: null,
            size: editedSize(
              { width: source.width, height: source.height },
              item.edit,
            ),
            status: "loading",
          };
        const server =
          views.get(item.key)?.serverItem ??
          (item.itemId === null
            ? null
            : (state.serverItems[item.itemId] ?? null));
        const presentation = server?.presentation;
        return {
          key: item.key,
          alt,
          src: null,
          size:
            presentation === undefined || presentation === null
              ? null
              : editedSize(presentation, item.edit),
          status:
            idle || localStill(item.key) !== null || server?.media
              ? "loading"
              : "unavailable",
        };
      });
    return {
      slides,
      total: state.items.length,
      stageRatio: resolveStageAspect(slides[0]?.size ?? undefined),
      unedited: media.unedited,
    };
  }, [media, state.items, state.serverItems, uploads, localStill, idle]);
};
