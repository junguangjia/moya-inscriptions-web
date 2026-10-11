"use client";

import { useRef } from "react";

import { FeedStagePreview } from "../../../media-composer/feed-stage-preview";
import composer from "../../../media-composer/media-composer.module.css";
import { useEditorSession } from "../editor/editor-session-provider";
import { CoverCropDialog } from "./cover-crop-dialog";
import { MediaEditDialog } from "./media-edit-dialog";
import { MediaPicker } from "./media-picker";
import { MediaStrip } from "./media-strip";
import styles from "./media.module.css";
import { SELECTION_UNAVAILABLE, useMediaActions } from "./use-media-actions";

import type { MediaDialog } from "./media-ui-store";
import type { EditorSessionHandle } from "../editor/editor-session-provider";

/**
 * Step 1 of the phone editor, or the media column of the desktop editor
 * (§11 items 3 and 4): selected static photos enter the upload queue under
 * the selection-stage quality choice. The ordered strip carries upload state,
 * cover, edits and removal; unsupported compression still needs a choice.
 *
 * The album lives in the editor session (`useEditorSession(sessionKey)`);
 * this section changes it only through the session's media actions. Upload
 * identities follow the manager through `syncManagedItems` (never an edit).
 * Removing an item cancels it through the runtime first, so the runtime
 * never puts it back. The open dialog, a pending re-selection and the last
 * notice belong to the session too (media-ui-store.ts): the section is
 * unmounted by every phone step change and layout swap. What the section
 * does lives in use-media-actions.ts, shared with the phone screens; this
 * file only draws it.
 */

export type MediaSectionLayout = "phone" | "desktop";

export interface MediaSectionProps {
  readonly sessionKey: string;
  readonly layout: MediaSectionLayout;
  /** 跳过，只发布文字 for the phone steps, when the step shows it here. */
  readonly onSkip?: () => void;
}

const MediaSectionBody = ({
  editor,
  layout,
  onSkip,
}: {
  readonly editor: EditorSessionHandle;
  readonly layout: MediaSectionLayout;
  readonly onSkip: (() => void) | undefined;
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const { state } = editor;
  const {
    session,
    ui,
    dialog,
    notice,
    selecting,
    selectedKeys,
    uploads,
    staging,
    maxItems,
    value,
    views,
    derivations,
    activeSlide,
    setActiveIndex,
    feed,
    announcement,
    canSelect,
    loaded,
    paused,
    dialogItem,
    dialogServer,
    dialogNumber,
    dialogDerivative,
    reselectInput,
    refuse,
    stage,
    move,
    reorder,
    removeMany,
    remove,
    chooseCover,
    applyEdit,
    applyCoverCrop,
    retry,
    reselect,
    chooseOriginal,
  } = useMediaActions(editor, rootRef);

  const showSkip =
    layout === "phone" &&
    onSkip !== undefined &&
    value.items.length === 0 &&
    staging === null;
  const openDialog = (next: MediaDialog) => ui.openDialog(next);

  return (
    <div
      ref={rootRef}
      className={styles.section}
      data-layout={layout}
      data-media-section={state.key}
    >
      <p className={styles.count}>
        {`已添加 ${value.items.length} 项，最多 ${maxItems} 项`}
      </p>

      <MediaPicker
        disabled={!canSelect}
        disabledReason={SELECTION_UNAVAILABLE}
        layout={layout}
        onFiles={(files, origin) => stage(files, origin)}
        onRefused={refuse}
      />
      <input {...reselectInput} />
      {(staging?.identifying ?? 0) > 0 && <p role="status">正在读取照片…</p>}

      {paused && (
        <div className={styles.notice} data-media-paused="">
          <p>
            {uploads?.pauseReason === "account"
              ? "账户状态已变化，上传已暂停"
              : "上传已暂停，确认网络正常后可继续"}
          </p>
          <button
            className={styles.secondaryButton}
            onClick={() => void session.continueUploads()}
            type="button"
          >
            继续上传
          </button>
        </div>
      )}

      {notice !== null && (
        <div className={styles.notice} data-media-notice="">
          <p>{notice}</p>
          <button
            className={styles.textButton}
            onClick={() => ui.setNotice(null)}
            type="button"
          >
            知道了
          </button>
        </div>
      )}

      {selecting && (
        <div className={styles.selectionBar} aria-label="图片多选">
          <span>已选择 {selectedKeys.length} 项</span>
          <button
            className={styles.actionButton}
            disabled={selectedKeys.length === 0}
            onClick={() => removeMany(selectedKeys)}
            type="button"
          >
            移除所选
          </button>
          <button
            className={styles.textButton}
            onClick={() => ui.clearSelection()}
            type="button"
          >
            完成
          </button>
        </div>
      )}
      {/* The order is the strip's alone (plan v2): the stage only previews. */}
      {value.items.length > 0 && (
        <section
          aria-label="动态预览"
          className={composer.stagePreview}
          data-layout={layout}
          data-media-composer=""
        >
          <FeedStagePreview
            activeIndex={activeSlide}
            layout={layout}
            onActiveIndexChange={setActiveIndex}
            slides={feed.slides}
            total={feed.total}
          />
        </section>
      )}
      {value.items.length > 0 && (
        <MediaStrip
          selecting={selecting}
          selectedKeys={selectedKeys}
          onSelect={(key) => ui.select(key)}
          onToggleSelection={(key) => ui.toggleSelection(key)}
          coverKey={value.coverKey}
          derivations={derivations}
          id={`media-strip-${state.key}`}
          items={value.items}
          label="已添加的图片，可调整顺序"
          loaded={loaded}
          localStill={session.localStill}
          onChooseOriginal={chooseOriginal}
          onComposeCover={(key) => openDialog({ type: "cover", key })}
          onEdit={(key) => openDialog({ type: "edit", key })}
          onMove={move}
          onRemove={remove}
          onReorder={reorder}
          onReselect={reselect}
          onRetry={retry}
          onSetCover={chooseCover}
          serverItems={state.serverItems}
          views={views}
        />
      )}

      {showSkip && (
        <button
          className={styles.skipButton}
          data-media-skip=""
          onClick={onSkip}
          type="button"
        >
          跳过，只发布文字
        </button>
      )}

      <div
        aria-live="polite"
        className={styles.visuallyHidden}
        data-media-announcer=""
        role="status"
      >
        {announcement}
      </div>

      {dialog?.type === "edit" && dialogItem !== null && (
        <MediaEditDialog
          blob={session.localStill(dialogItem.key)}
          derivativeExpected={dialogDerivative}
          edit={dialogItem.edit}
          feedStage={{
            first: dialogNumber === 1,
            stageRatio: feed.slides[0]?.size ? feed.stageRatio : null,
          }}
          initialDraft={ui.draftFor(dialog)}
          itemKey={dialogItem.key}
          itemNumber={dialogNumber}
          kind={dialogItem.kind}
          knownSize={dialogServer?.presentation ?? null}
          onApply={(edit) => applyEdit(dialogItem.key, edit)}
          onClose={() => ui.closeDialog()}
          onDraftChange={(draft) => ui.saveDraft(dialog, draft)}
          src={dialogServer?.media?.displaySrc ?? null}
        />
      )}
      {dialog?.type === "cover" && dialogItem !== null && (
        <CoverCropDialog
          blob={session.localStill(dialogItem.key)}
          coverCrop={value.coverKey === dialogItem.key ? value.coverCrop : null}
          derivativeExpected={dialogDerivative}
          edit={dialogItem.edit}
          initialDraft={ui.draftFor(dialog)}
          itemKey={dialogItem.key}
          itemNumber={dialogNumber}
          onApply={(crop) => applyCoverCrop(dialogItem.key, crop)}
          onClose={() => ui.closeDialog()}
          onDraftChange={(draft) => ui.saveDraft(dialog, draft)}
          src={dialogServer?.media?.displaySrc ?? null}
        />
      )}
    </div>
  );
};

export const MediaSection = ({
  sessionKey,
  layout,
  onSkip,
}: MediaSectionProps) => {
  const editor = useEditorSession(sessionKey);
  // The session ended (submitted or discarded): nothing to show.
  if (editor === null) return null;
  return (
    <MediaSectionBody
      key={sessionKey}
      editor={editor}
      layout={layout}
      onSkip={onSkip}
    />
  );
};
