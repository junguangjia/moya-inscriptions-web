import type { MouseEventHandler } from "react";
import styles from "./reporting.module.css";

/** Shared presentation only; the caller owns authentication or local QA state. */
export const CommentReportButton = ({
  sent = false,
  pending = false,
  disabled = false,
  onClick,
}: {
  readonly sent?: boolean;
  readonly pending?: boolean;
  readonly disabled?: boolean;
  readonly onClick: MouseEventHandler<HTMLButtonElement>;
}) => (
  <button
    type="button"
    className={styles.flag}
    aria-label={sent ? "已举报评论" : "举报评论"}
    aria-pressed={sent}
    aria-busy={pending || undefined}
    disabled={disabled}
    onClick={onClick}
    data-comment-report=""
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 21V3m0 1c5-4 9 4 15 0v11c-6 4-10-4-15 0" />
    </svg>
  </button>
);
