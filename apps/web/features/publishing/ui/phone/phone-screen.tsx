"use client";

import { Icon } from "@moya/ui";
import { useCallback, useEffect, useState } from "react";

import detailStyles from "../../../detail/catalog-detail.module.css";
import hostStyles from "../../publishing-entry.module.css";
import editorStyles from "../editor/editor.module.css";
import styles from "./phone-screen.module.css";

import type { ComponentProps, ReactNode, Ref } from "react";

/** The three phone publishing screens (#244), as `data-editor-screen` names them. */
export type PhoneScreenName = "select" | "edit" | "publish";

/**
 * The bar's bottom hairline (`data-bar-line`). Both mockups draw it only once
 * the content has scrolled under the bar (`scrolled`); the edit stage draws
 * its own top edge, so a screen without a scroller has none (`none`).
 * `always` is the permanent line the bar had before r3.
 */
export type PhoneBarLine = "scrolled" | "none" | "always";

/**
 * How the pinned bottom bar lays out what a screen puts in it.
 * - `spread`: the editor's step bar, items pushed to both ends.
 * - `toolbar`: mockup B's 选择照片 bar, the start screen's since r4. One
 *   row packed from the start; its first control (the 原图画质 switch)
 *   brings its own 44px target, so the start inset is 4px and the end inset
 *   16px. Top hairline.
 * - `stacked`: mockup A's 发布 bar. A reason line above one row of
 *   actions, 8px apart, no hairline.
 */
export type PhoneFooterLayout = "spread" | "toolbar" | "stacked";

export interface PhoneScreenProps {
  /** `data-editor-screen`: one of the three, or 封面构图 drawn over 编辑. */
  readonly screen: PhoneScreenName | "cover";
  /** 发布作品 / 编辑作品 / 参与话题, or the edit screen's 「3 / 6」. */
  readonly title: string;
  /**
   * What a screen reader hears instead of `title` when the title is a
   * counter: 「3 / 6」 is drawn with steady digits and read as 「第 3 项，共 6 项」.
   */
  readonly titleLabel?: string | undefined;
  /**
   * The line under the title. A string is drawn as the bar caption; a node
   * (SaveStatus, or a `PhoneBarCaption` carrying a data hook, as the start
   * screen's 选择照片 · 最多 50 项) is drawn as given.
   */
  readonly secondLine?: ReactNode;
  /** The icon-only Back's name: 返回, 返回选择照片, 返回编辑照片. */
  readonly backLabel: string;
  readonly onBack: () => void;
  /**
   * Back is held (the start screen while 专题 creates its draft, r4 D3): it
   * says `aria-disabled="true"` and a click does nothing. It stays focusable
   * and keeps focus, unlike a disabled button.
   */
  readonly backHeld?: boolean | undefined;
  /** The shell's Back target (`controls.backButtonRef`) when this bar is the editor's. */
  readonly backButtonRef?: Ref<HTMLButtonElement> | undefined;
  /**
   * The bar's end: an icon button (更多操作), `PhoneNextButton`, or a text
   * action (完成, the start screen's 草稿箱). Without one, a 44px spacer keeps
   * the title in place.
   */
  readonly action?: ReactNode;
  /** The bar's hairline; `scrolled` with a scroller, `none` without one. */
  readonly barLine?: PhoneBarLine | undefined;
  /**
   * The body under the bar.
   * - `true`: a scroller holding the reading column (`.stepContent`).
   * - `"bleed"`: a scroller whose children run edge to edge (the start
   *   screen): no reading width, side padding or gap.
   * - `false`: no scroller; the children fill the screen and size
   *   themselves (the edit stage).
   */
  readonly scroll?: boolean | "bleed" | undefined;
  /** The scroller, when there is one (`scroll` is not false). */
  readonly scrollerRef?: Ref<HTMLDivElement> | undefined;
  /**
   * Added to the reading column (`scroll` true only). `.stepContent` sets
   * padding and gap, so an override needs a more specific selector
   * (`div.content`).
   */
  readonly contentClassName?: string | undefined;
  /** The pinned bottom bar; none when absent. */
  readonly footer?: ReactNode;
  /** The bottom bar's layout; `spread`, or `stacked` with `footerStacked`. */
  readonly footerLayout?: PhoneFooterLayout | undefined;
  /** Shorthand for `footerLayout="stacked"` (the 发布 bar). */
  readonly footerStacked?: boolean | undefined;
  /** Hides the bottom bar at once (a text field has the keyboard). */
  readonly footerHidden?: boolean | undefined;
  /**
   * The screen's own layers, drawn last over the whole screen: the toast
   * host and the bottom sheets. The screen is their positioning box and
   * stacking context.
   */
  readonly overlay?: ReactNode;
  readonly children: ReactNode;
}

/** Both mockups draw the hairline once the scroller is past 2px. */
const SCROLLED_AFTER_PX = 2;

/** Whether a slot draws anything (`condition && node` leaves `false` behind). */
const filled = (node: ReactNode) =>
  node !== undefined && node !== null && typeof node !== "boolean";

const assignRef = <T,>(ref: Ref<T> | undefined, value: T | null) => {
  if (typeof ref === "function") ref(value);
  else if (ref !== null && ref !== undefined) ref.current = value;
};

const footerClassName = (layout: PhoneFooterLayout) => {
  switch (layout) {
    case "toolbar":
      return `${styles.footer} ${styles.toolbar}`;
    case "stacked":
      return `${editorStyles.stepFooter} ${styles.footer} ${styles.stepFooterStacked}`;
    case "spread":
      return `${editorStyles.stepFooter} ${styles.footer}`;
  }
};

/**
 * The line under the bar title (mockup B `.sub`, mockup A `.barTitle small`):
 * caption size, secondary text, steady digits, one line. A string
 * `secondLine` is drawn with it; a screen uses it directly to add a hook.
 */
export const PhoneBarCaption = ({
  children,
  ...props
}: Omit<ComponentProps<"span">, "className">) => (
  <span {...props} className={styles.caption}>
    {children}
  </span>
);

/**
 * 下一步 as mockup B draws it in the 编辑 bar (and 封面构图's 完成)
 * (`.textBtn.next`): the editor's outlined text button, bolder and wider,
 * muted while pressed. Data hooks pass through (`data-edit-next`).
 */
export const PhoneNextButton = ({
  children = "下一步",
  ...props
}: Omit<ComponentProps<"button">, "className" | "type">) => (
  <button
    {...props}
    className={`${editorStyles.textButton} ${styles.next}`}
    type="button"
  >
    {children}
  </button>
);

/**
 * The chrome the three phone screens share (#244 r3/r4: the start screen
 * and 编辑 after mockup B, 发布 after mockup A): the top bar with an
 * icon-only Back (held while `backHeld`), the title as the heading a step
 * change focuses (`data-editor-step-heading`), the caption or save status
 * under it and the actions at the end; then the body (a reading column, an
 * edge-to-edge scroller, or the screen's own layout), the pinned bottom bar
 * and the screen's overlay layers. Each screen owns its own bar, so Back
 * means "the previous screen" there; the editor host keeps the frame, theme
 * and keyboard insets.
 */
export const PhoneScreen = ({
  screen,
  title,
  titleLabel,
  secondLine,
  backLabel,
  onBack,
  backHeld = false,
  backButtonRef,
  action,
  barLine,
  scroll = true,
  scrollerRef,
  contentClassName,
  footer,
  footerLayout,
  footerStacked = false,
  footerHidden = false,
  overlay,
  children,
}: PhoneScreenProps) => {
  const line = barLine ?? (scroll === false ? "none" : "scrolled");
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [scrolled, setScrolled] = useState(false);

  const attachScroller = useCallback(
    (node: HTMLDivElement | null) => {
      setScroller(node);
      assignRef(scrollerRef, node);
    },
    [scrollerRef],
  );

  // The hairline follows the scroller; the state changes only at the threshold.
  useEffect(() => {
    if (scroller === null || line !== "scrolled") return;
    const sync = () => setScrolled(scroller.scrollTop > SCROLLED_AFTER_PX);
    sync();
    scroller.addEventListener("scroll", sync, { passive: true });
    return () => scroller.removeEventListener("scroll", sync);
  }, [scroller, line]);

  return (
    <div
      className={`${editorStyles.phone} ${styles.screen}`}
      data-editor-layout="phone"
      data-editor-screen={screen}
    >
      <header
        className={`${detailStyles.detailHeader} ${editorStyles.bar} ${styles.bar}`}
        data-bar-line={line}
        data-editor-bar=""
        data-scrolled={
          line === "scrolled"
            ? String(scroller !== null && scrolled)
            : undefined
        }
      >
        <button
          ref={backButtonRef}
          aria-disabled={backHeld ? true : undefined}
          aria-label={backLabel}
          onClick={backHeld ? undefined : onBack}
          type="button"
        >
          <Icon aria-hidden="true" name="back" />
        </button>
        <div className={editorStyles.barTitle}>
          <h2
            className={styles.heading}
            data-editor-step-heading=""
            tabIndex={-1}
          >
            {titleLabel === undefined ? (
              title
            ) : (
              <>
                <span aria-hidden="true" className={styles.barCounter}>
                  {title}
                </span>
                <span className={editorStyles.visuallyHidden}>
                  {titleLabel}
                </span>
              </>
            )}
          </h2>
          {typeof secondLine === "string" ? (
            secondLine === "" ? null : (
              <PhoneBarCaption>{secondLine}</PhoneBarCaption>
            )
          ) : (
            secondLine
          )}
        </div>
        <div className={editorStyles.barActions}>
          {filled(action) ? (
            action
          ) : (
            <span aria-hidden="true" className={hostStyles.balance} />
          )}
        </div>
      </header>
      {scroll === false ? (
        children
      ) : (
        <div
          ref={attachScroller}
          className={`${editorStyles.stepScroller} ${styles.scroller}`}
          data-editor-scroller=""
        >
          {scroll === "bleed" ? (
            children
          ) : (
            <div
              className={
                contentClassName === undefined
                  ? editorStyles.stepContent
                  : `${editorStyles.stepContent} ${contentClassName}`
              }
            >
              {children}
            </div>
          )}
        </div>
      )}
      {filled(footer) ? (
        <div
          className={footerClassName(
            footerLayout ?? (footerStacked ? "stacked" : "spread"),
          )}
          data-editor-footer=""
          hidden={footerHidden}
        >
          {footer}
        </div>
      ) : null}
      {overlay}
    </div>
  );
};
