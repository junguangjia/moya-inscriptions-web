"use client";

import { useEffect, useId, useState } from "react";

import { KEYBOARD_ATTRIBUTE } from "../editor/editor-layout";
import { bodyRule, checkEditorText, titleRule } from "../editor/editor-text";
import editorStyles from "../editor/editor.module.css";
import styles from "./publish-screen.module.css";

import type { ConfirmationSheetProps } from "../editor/confirmation-sheet";
import type { ReactNode, RefObject } from "react";

/**
 * The line above 发布 (mockup A `.ready[data-tone]`): why it cannot go,
 * what it is doing, or that every photo is ready. `status` while
 * submitting, `error` for the empty work, an issue or a failure, `blocking`
 * and `pending` for readiness, `ok` once every photo is ready.
 */
export interface PublishReason {
  readonly text: string;
  readonly tone: "status" | "error" | "blocking" | "pending" | "ok";
}

/** What the reason line reads; the confirmation sheet's own inputs. */
export type PublishReasonInput = Pick<
  ConfirmationSheetProps,
  "state" | "readiness" | "issues" | "submission" | "resolving"
>;

/**
 * The line kept directly above the sticky 发布 (design-language S3.8, VF:11:
 * a disabled button never carries the reason alone). The submission's
 * progress comes first; otherwise, while `blocked`, the first blocking
 * reason in the scroll area's reading order; once 发布 can go, 「全部 N 项已
 * 就绪」 for a work with photos (mockup A `renderReady`) and nothing for a
 * text-only one. The wording is the confirmation sheet's
 * (confirmation-sheet.tsx), so both say the same thing.
 */
export const publishReason = (
  {
    state,
    readiness,
    issues,
    submission,
    resolving = false,
  }: PublishReasonInput,
  label: string,
  blocked: boolean,
): PublishReason | null => {
  const edit = state.kind === "edit";
  const status =
    submission.status === "reconciling"
      ? "正在确认结果…"
      : submission.status === "confirmed"
        ? edit
          ? "更新已保存"
          : "作品已提交"
        : resolving || submission.status === "submitting"
          ? edit
            ? "正在保存更新…"
            : "正在发布…"
          : submission.status === "not_ready" && readiness.blocking > 0
            ? `${submission.itemKeys.length} 项正在处理，完成后可再${label}`
            : "";
  if (status !== "") return { text: status, tone: "status" };
  const hasItems = state.items.length > 0;
  if (!blocked)
    return hasItems && readiness.blocking === 0 && readiness.confirmed
      ? { text: `全部 ${readiness.ready} 项已就绪`, tone: "ok" }
      : null;
  if (hasItems && readiness.blocking > 0 && readiness.text !== null)
    return {
      text: `${readiness.text}。全部就绪或移除后才能${label}`,
      tone: "blocking",
    };
  if (hasItems && !readiness.confirmed)
    return { text: "正在确认图片状态…", tone: "pending" };
  if (
    !hasItems &&
    checkEditorText(state.title, titleRule).value === "" &&
    checkEditorText(state.body, bodyRule).value === ""
  )
    return { text: "标题、正文和图片不能都为空", tone: "error" };
  const issue = issues.find((entry) => entry.message !== null);
  if (issue?.message != null) return { text: issue.message, tone: "error" };
  const general = state.fieldErrors.general;
  if (general !== undefined) return { text: general, tone: "error" };
  if (submission.status === "unconfirmed")
    return { text: submission.message, tone: "error" };
  return null;
};

const textInputTypes: ReadonlySet<string> = new Set([
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url",
]);

/** A control that brings up the keyboard (not a radio, switch or button). */
const isTextEntry = (target: EventTarget | null): boolean =>
  target instanceof HTMLTextAreaElement
    ? !target.readOnly
    : target instanceof HTMLInputElement
      ? textInputTypes.has(target.type) && !target.readOnly
      : target instanceof HTMLElement && target.isContentEditable === true;

/**
 * Whether a text field of the screen around `anchorRef` (its
 * `[data-editor-screen]` root) has focus. With the keyboard up
 * (`useKeyboardShown`) the 发布 bar hides, so the keyboard keeps the
 * viewport for the text (G22); a real blur, or focus moving to anything that
 * is not a text field, brings it back at once.
 */
export const useTextEntryFocus = (
  anchorRef: RefObject<HTMLElement | null>,
): boolean => {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const anchor = anchorRef.current;
    const root = anchor?.closest<HTMLElement>("[data-editor-screen]") ?? anchor;
    if (root == null) return undefined;
    const typingIn = (target: EventTarget | null) =>
      target instanceof Node && root.contains(target) && isTextEntry(target);
    setTyping(typingIn(document.activeElement));
    const focusIn = (event: FocusEvent) => setTyping(typingIn(event.target));
    const focusOut = (event: FocusEvent) =>
      setTyping(typingIn(event.relatedTarget));
    root.addEventListener("focusin", focusIn);
    root.addEventListener("focusout", focusOut);
    return () => {
      root.removeEventListener("focusin", focusIn);
      root.removeEventListener("focusout", focusOut);
    };
  }, [anchorRef]);
  return typing;
};

/**
 * Whether the on-screen keyboard is up, as the editor's viewport frame
 * measures it on its host (`useVisualViewportFrame`). Focus alone is not
 * enough: a keyboard dismissed by the system Back or a hardware keyboard
 * leaves focus in the field with no keyboard taking the viewport.
 */
export const useKeyboardShown = (
  anchorRef: RefObject<HTMLElement | null>,
): boolean => {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const host = anchorRef.current?.closest<HTMLElement>(
      `[${KEYBOARD_ATTRIBUTE}]`,
    );
    if (host == null) return undefined;
    const read = () =>
      setShown(host.getAttribute(KEYBOARD_ATTRIBUTE) === "true");
    read();
    const observer = new MutationObserver(read);
    observer.observe(host, {
      attributes: true,
      attributeFilter: [KEYBOARD_ATTRIBUTE],
    });
    return () => observer.disconnect();
  }, [anchorRef]);
  return shown;
};

export interface PublishBarProps {
  /** 发布, or 保存更新 when editing; it never changes while submitting. */
  readonly label: string;
  /**
   * 发布 cannot go now. The button stays focusable and named
   * (`aria-disabled`, mockup A `.pubBtn`): a press nudges the reason line
   * instead of submitting.
   */
  readonly disabled: boolean;
  /** A submission is in progress (`aria-busy`; the reason line says which). */
  readonly busy: boolean;
  /** The line above the buttons; none when there is nothing to say. */
  readonly reason: PublishReason | null;
  readonly onSubmit: () => void;
  /** 预览: opens the work page preview, which returns focus to `opener`. */
  readonly onPreview: (opener: HTMLElement) => void;
  /**
   * 保存草稿 (the editor's own button, saved mode only). Without one its
   * place stays empty and 发布 takes the room.
   */
  readonly saveAction?: ReactNode;
  /**
   * A photo needs the author on another screen: a blocking reason ends in
   * 前往处理, which goes to it (the confirmation sheet's own action).
   */
  readonly onResolveMedia?: (() => void) | undefined;
}

/** Whether a slot draws anything (`condition && node` leaves `false` behind). */
const filled = (node: ReactNode) =>
  node !== undefined && node !== null && typeof node !== "boolean";

/**
 * The sticky 发布 bar's content (S3.8, mockup A `.pubFoot`), for
 * `PhoneScreen`'s stacked footer: the reason line, then one row of 预览 and
 * 保存草稿 as borderless text actions (A `.footAct`) and the seal-red 发布
 * taking the rest (A `.pubBtn`), which the line describes. The line is not a
 * live region: the confirmation sheet in the scroll area already announces
 * the same text. A press while 发布 cannot go shakes the line once (mockup A
 * `.ready.nudge`); the key remounts it, so every press restarts the shake.
 */
export const PublishBar = ({
  label,
  disabled,
  busy,
  reason,
  onSubmit,
  onPreview,
  saveAction,
  onResolveMedia,
}: PublishBarProps) => {
  const reasonId = useId();
  const [nudge, setNudge] = useState({ count: 0, shown: false });
  return (
    <>
      {reason === null ? null : (
        <p
          key={nudge.count}
          className={styles.reason}
          data-blocking={reason.tone === "blocking" ? "true" : undefined}
          data-nudge={nudge.shown ? "true" : undefined}
          data-publish-reason={reason.tone}
          id={reasonId}
          onAnimationEnd={() =>
            setNudge((previous) => ({ ...previous, shown: false }))
          }
        >
          {reason.text}
          {reason.tone === "blocking" && onResolveMedia !== undefined ? (
            <button
              className={`${styles.inlineAction} ${styles.lineAction}`}
              data-editor-resolve-media=""
              onClick={onResolveMedia}
              type="button"
            >
              前往处理
            </button>
          ) : null}
        </p>
      )}
      <div className={styles.actions} data-publish-actions="">
        <button
          className={styles.footAction}
          data-editor-preview-open=""
          onClick={(event) => onPreview(event.currentTarget)}
          type="button"
        >
          预览
        </button>
        {filled(saveAction) ? (
          <span className={styles.footSave}>{saveAction}</span>
        ) : null}
        <button
          aria-busy={busy || undefined}
          aria-describedby={reason === null ? undefined : reasonId}
          aria-disabled={disabled || undefined}
          className={`${editorStyles.primaryButton} ${styles.publishButton}`}
          data-editor-submit=""
          onClick={() => {
            if (!disabled) onSubmit();
            else if (!busy)
              setNudge((previous) => ({
                count: previous.count + 1,
                shown: true,
              }));
          }}
          type="button"
        >
          {label}
        </button>
      </div>
    </>
  );
};

/**
 * 完成 at the end of the top bar while a text field has the keyboard
 * (Instagram's OK on its last step; the 发布 bar is hidden meanwhile). It
 * moves focus to the screen heading, which closes the keyboard and brings
 * the bar back. A press never takes focus first: on Android the field would
 * blur, 完成 would unmount and the click would be lost.
 */
export const PublishDoneButton = () => (
  <button
    className={styles.done}
    data-publish-done=""
    onClick={(event) => {
      const heading = event.currentTarget
        .closest("[data-editor-screen]")
        ?.querySelector<HTMLElement>("[data-editor-step-heading]");
      if (heading != null) heading.focus({ preventScroll: true });
      else if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    }}
    onPointerDown={(event) => event.preventDefault()}
    type="button"
  >
    完成
  </button>
);
