"use client";

import mediaStyles from "../media/media.module.css";

/**
 * The media section's last notice (a cover composition that followed an
 * edit, a file that could not be read, a removal still cleaning up), with
 * 知道了, drawn the way the section draws it. Every phone screen shows it, so
 * a notice raised on 编辑 or on the way to 发布 is seen where the author is,
 * not later on 选择照片.
 */
export const MediaNotice = ({
  notice,
  onDismiss,
}: {
  readonly notice: string | null;
  readonly onDismiss: () => void;
}) =>
  notice === null ? null : (
    <div className={mediaStyles.notice} data-media-notice="">
      <p>{notice}</p>
      <button
        className={mediaStyles.textButton}
        onClick={onDismiss}
        type="button"
      >
        知道了
      </button>
    </div>
  );
