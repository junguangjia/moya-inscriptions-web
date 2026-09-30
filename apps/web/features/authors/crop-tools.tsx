"use client";
import { cropHint } from "./crop-gestures";
import media from "../publishing/ui/media/media.module.css";
import styles from "./crop-tools.module.css";

/**
 * The row under a crop surface: 还原 (the publishing crop dialog's word and
 * pill) and the gesture hint. Shared by the cover and avatar editors.
 */
export const CropTools = ({
  hintId,
  coarse,
  pristine,
  locked,
  onReset,
}: {
  hintId: string;
  coarse: boolean;
  pristine: boolean;
  locked: boolean;
  onReset: () => void;
}) => (
  <div className={media.dialogRow}>
    <button
      type="button"
      className={`${media.actionButton} ${styles.reset}`}
      disabled={locked}
      aria-disabled={pristine}
      onClick={onReset}
    >
      还原
    </button>
    <p id={hintId} className={`${media.dialogNote} ${styles.hint}`}>
      {cropHint(coarse)}
    </p>
  </div>
);
