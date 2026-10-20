"use client";

import { Icon } from "@moya/ui";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  FEED_POST_CLICK_SUPPRESSION_MS,
  FEED_POST_SETTLE_MS,
  FEED_POST_TAP_TOLERANCE_PX,
  isLegacyRtlScroll,
  readStripOffset,
  resolveStageAspect,
  slideFit,
  stripScrollLeft,
} from "../../../authors/feed-post-strip-geometry";
import { MentionControl } from "../../../notifications/mention-control";
import {
  ConfirmationSheet,
  confirmationBlocked,
} from "../editor/confirmation-sheet";
import {
  bodyRule,
  checkEditorText,
  issueMessage,
  titleRule,
} from "../editor/editor-text";
import editorStyles from "../editor/editor.module.css";
import { PhoneScreen } from "./phone-screen";
import { needsAttention } from "./photo-tile";
import {
  PublishBar,
  PublishDoneButton,
  publishReason,
  useKeyboardShown,
  useTextEntryFocus,
} from "./publish-bar";
import {
  AuthorshipSection,
  ReferenceSheet,
  VisibilitySection,
  hasReferences,
} from "./publish-options";
import selectStyles from "./select-screen.module.css";
import styles from "./publish-screen.module.css";

import type { FeedStagePreviewSlide } from "../../../media-composer/feed-stage-preview";
import type { ConfirmationSheetProps } from "../editor/confirmation-sheet";
import type { EditorSessionHandle } from "../editor/editor-session-provider";
import type {
  EditorField,
  EditorSessionState,
  EditorSessionStore,
  ReferenceField,
} from "../editor/editor-session-state";
import type { EditorTextRule } from "../editor/editor-text";
import type { ItemStatus } from "../media/media-status";
import type { CSSProperties, ReactNode, Ref } from "react";

/** A counter shows once the text reaches this share of its limit (mockup A `setCounter`). */
const COUNTER_FROM = 0.8;

/**
 * The 14px glyph that leads a card's status chip (mockup A `chipHtml`): a
 * ring of the upload's progress, the loading glyph turning while the item
 * is processed, or the error glyph when it needs the author.
 */
export type PublishChipGlyph =
  | { readonly kind: "progress"; readonly percent: number }
  | { readonly kind: "loading" }
  | { readonly kind: "error" };

/** The status chip of an item that is not ready yet (S1.8), as 编辑 names it. */
export interface PublishPreviewChip {
  /** `chipLabel`: 上传中 42%, 等待上传, 处理中, 上传失败, 缺少文件… */
  readonly label: string;
  /** `needsAttention`: the chip is drawn as needing the author. */
  readonly attention: boolean;
  /**
   * What leads the label (`publishChipGlyph`). Absent, the error glyph
   * leads a chip that needs attention and nothing leads the others.
   */
  readonly glyph?: PublishChipGlyph | null | undefined;
}

/**
 * The glyph a status leads its 发布 chip with (mockup A `chipHtml`): the
 * error glyph whenever the photo needs the author, the progress ring while
 * it uploads, the turning loading glyph while it is processed; none for the
 * quieter waits (正在读取, 准备中, 等待上传, 等待处理).
 */
export const publishChipGlyph = (
  status: ItemStatus,
): PublishChipGlyph | null =>
  needsAttention(status)
    ? { kind: "error" }
    : status.kind === "uploading"
      ? { kind: "progress", percent: status.percent }
      : status.kind === "processing" ||
          (status.kind === "ready" && status.background === "pending")
        ? { kind: "loading" }
        : null;

/** The progress ring's radius in its 24-unit box (mockup A `ring`). */
const RING_RADIUS = 9;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** A chip's lead glyph, 14px (mockup A `ring(…, 14)`, `ic(…, 'xs')`). */
const ChipGlyph = ({ glyph }: { readonly glyph: PublishChipGlyph }) => {
  if (glyph.kind !== "progress")
    return (
      <Icon
        aria-hidden="true"
        className={styles.chipGlyph}
        data-publish-glyph={glyph.kind}
        name={glyph.kind}
        size="sm"
      />
    );
  const share = Math.min(100, Math.max(0, glyph.percent)) / 100;
  return (
    <svg
      aria-hidden="true"
      className={styles.chipGlyph}
      data-publish-glyph="progress"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <circle className={styles.ringTrack} cx="12" cy="12" r={RING_RADIUS} />
      <circle
        className={styles.ringBar}
        cx="12"
        cy="12"
        r={RING_RADIUS}
        strokeDasharray={RING_LENGTH}
        strokeDashoffset={RING_LENGTH * (1 - share)}
        transform="rotate(-90 12 12)"
      />
    </svg>
  );
};

/** One card of the 发布 strip: the feed stage's slide, with its status. */
export interface PublishPreviewSlide extends FeedStagePreviewSlide {
  /** Drawn at the card's bottom-left; none (or absent) once the item is ready. */
  readonly chip?: PublishPreviewChip | null | undefined;
  /** The full status (`ItemStatus.label`) for the card's name; none when ready. */
  readonly statusText?: string | null | undefined;
}

/** The work as the feed will show it: one card per slide, in content order. */
export interface PublishPreview {
  /** At most the feed's gallery cap (`useFeedStageSlides`). */
  readonly slides: readonly PublishPreviewSlide[];
  readonly total: number;
  /** The shown card, shared with the other screens (`media.activeSlide`). */
  readonly activeIndex: number;
  readonly onActiveIndexChange: (index: number) => void;
  /** A tapped card: 编辑 opens at that item. */
  readonly onOpenItem: (index: number) => void;
}

/** What the editor passes `TextSettings` today, for the fields drawn here. */
export interface PublishTextProps {
  readonly state: EditorSessionState;
  readonly store: EditorSessionStore;
  /** Marks 标题 as the field to focus (`data-editor-autofocus`). */
  readonly autoFocusTitle?: boolean | undefined;
}

export interface PublishAction {
  /** 发布, or 保存更新 when editing. */
  readonly label: string;
  /**
   * Disabled for a reason of the caller's own (the session ended); the
   * confirmation gate (`confirmationBlocked`) always applies as well.
   */
  readonly disabled?: boolean | undefined;
  readonly busy: boolean;
  readonly onSubmit: () => void;
}

/**
 * The confirmation sheet's inputs; the screen draws it without card or
 * 发布, and moves `onResolveMedia` (前往处理) to the line above 发布.
 */
export type PublishConfirmation = Omit<
  ConfirmationSheetProps,
  "summary" | "primary"
>;

export interface PublishScreenProps {
  readonly editor: EditorSessionHandle;
  /** 发布作品 / 编辑作品 / 参与话题. */
  readonly title: string;
  /** The bar's second line: `SaveStatus`, always. */
  readonly saveStatus: ReactNode;
  /** 保存草稿 (saved mode only), drawn in the bottom bar beside 预览. */
  readonly saveAction?: ReactNode;
  /** 更多操作 and its menu (历史版本), alone at the bar's end. */
  readonly menu?: ReactNode;
  /** The shell's Back target (`controls.backButtonRef`). */
  readonly backButtonRef?: Ref<HTMLButtonElement> | undefined;
  /** To 编辑 when the work has photos, else to the start screen (the label says which). */
  readonly onBack: () => void;
  /** null (or no slides) leaves the strip out; a work without photos gets 添加照片. */
  readonly preview: PublishPreview | null;
  readonly textProps: PublishTextProps;
  /**
   * The reference sheet is open, focusing this field first
   * (`ui.phone.references`); null while it is closed.
   */
  readonly references: ReferenceField | null;
  readonly onReferences: (field: ReferenceField | null) => void;
  /** 预览: opens `PhonePreview`, which returns focus to `opener`. */
  readonly onOpenPreview: (opener: HTMLElement) => void;
  /** The editor's notices (recovery, cover reset, ended session). */
  readonly notices?: ReactNode;
  readonly confirmation: PublishConfirmation;
  readonly publish: PublishAction;
}

const reducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** One card's step along the strip: its width plus the strip's gap. */
const stepOf = (strip: HTMLElement): number => {
  const card = strip.querySelector<HTMLElement>("[data-publish-card]");
  if (card === null) return 0;
  const gap = Number.parseFloat(window.getComputedStyle(strip).columnGap);
  return card.getBoundingClientRect().width + (Number.isFinite(gap) ? gap : 0);
};

/**
 * The card a settled strip rests on. Cards narrower than the strip cannot
 * all reach its start, so the far end always reads as the last card.
 */
export const stripCardIndex = (
  offset: number,
  maxOffset: number,
  step: number,
  count: number,
): number => {
  if (count <= 1) return 0;
  if (maxOffset > 0 && offset >= maxOffset - 1) return count - 1;
  if (step <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(offset / step)));
};

const cardOf = (target: EventTarget | null): number | null => {
  const card =
    target instanceof Element ? target.closest("[data-publish-card]") : null;
  const index = Number(card?.getAttribute("data-publish-card") ?? Number.NaN);
  return Number.isInteger(index) ? index : null;
};

/**
 * The work as the feed will show it (#244 r3, mockup A `.hs`): cards at the
 * feed stage's ratio (the first image's, between 1:1 and 4:5), about three
 * quarters of the width and never taller than 40% of the screen, so the next
 * card peeks. It reads right to left like the feed, photo 1 rightmost (a
 * single card too), and snaps card by card; 首图 and each item's status chip
 * sit on the card, and the caption under it says which way it
 * reads. A tap on any card opens 编辑 at it; a tap that moved the strip was
 * part of the swipe. The shown card is the owner's (`activeIndex`): a
 * settled swipe and a tapped card report it, so 发布 comes back at the card
 * 编辑 opened, and a new one is scrolled in.
 */
export const PublishPreviewStrip = ({
  slides,
  total,
  activeIndex,
  onActiveIndexChange,
  onOpenItem,
}: PublishPreview) => {
  const count = slides.length;
  const current = Math.max(0, Math.min(activeIndex, count - 1));
  const ratio = resolveStageAspect(slides[0]?.size ?? undefined);
  const captionId = useId();
  const stripRef = useRef<HTMLDivElement>(null);
  const legacyRef = useRef(false);
  const indexRef = useRef(current);
  const settleTimerRef = useRef<number | null>(null);
  const touchRef = useRef({ active: false, startOffset: 0 });
  const suppressUntilRef = useRef(0);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const change = useRef(onActiveIndexChange);
  change.current = onActiveIndexChange;

  const leftFor = useCallback((strip: HTMLElement, index: number) => {
    const target = Math.max(0, index);
    return stripScrollLeft(strip, target * stepOf(strip), legacyRef.current);
  }, []);

  const scrollToIndex = useCallback(
    (index: number) => {
      const strip = stripRef.current;
      if (strip === null) return;
      const left = leftFor(strip, Math.min(index, count - 1));
      const behavior = reducedMotion() ? "auto" : "smooth";
      if (typeof strip.scrollTo === "function")
        strip.scrollTo({ left, behavior });
      else strip.scrollLeft = left;
    },
    [count, leftFor],
  );

  const settle = useCallback(() => {
    settleTimerRef.current = null;
    const strip = stripRef.current;
    if (strip === null) return;
    const index = stripCardIndex(
      readStripOffset(strip, legacyRef.current),
      Math.max(0, strip.scrollWidth - strip.clientWidth),
      stepOf(strip),
      count,
    );
    if (index === indexRef.current) return;
    indexRef.current = index;
    change.current(index);
  }, [count]);

  // Returning from 编辑 at photo 3 shows photo 3 at once.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (strip === null) return;
    legacyRef.current = isLegacyRtlScroll(strip);
    if (indexRef.current > 0)
      strip.scrollLeft = leftFor(strip, indexRef.current);
  }, [leftFor]);

  // The owner chose a card (another screen, the keyboard): bring it in.
  useEffect(() => {
    if (current === indexRef.current) return;
    indexRef.current = current;
    scrollToIndex(current);
  }, [current, scrollToIndex]);

  // A width change (rotation, resize) keeps the shown card.
  useEffect(() => {
    const strip = stripRef.current;
    if (strip === null || typeof ResizeObserver !== "function")
      return undefined;
    const observer = new ResizeObserver(() => {
      const left = leftFor(strip, indexRef.current);
      if (Math.abs(strip.scrollLeft - left) > 1) strip.scrollLeft = left;
    });
    observer.observe(strip);
    return () => observer.disconnect();
  }, [count, leftFor]);

  useEffect(
    () => () => {
      if (settleTimerRef.current !== null)
        window.clearTimeout(settleTimerRef.current);
    },
    [],
  );

  if (count === 0) return null;

  return (
    <div data-publish-preview="">
      <div
        ref={stripRef}
        aria-describedby={captionId}
        aria-label="动态预览"
        className={styles.strip}
        data-count={count}
        data-local-horizontal=""
        data-publish-strip=""
        onClickCapture={(event) => {
          if (
            event.detail !== 0 &&
            performance.now() < suppressUntilRef.current
          ) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onKeyDown={(event) => {
          const from = cardOf(event.target);
          if (from === null) return;
          const next =
            event.key === "ArrowLeft"
              ? Math.min(count - 1, from + 1)
              : event.key === "ArrowRight"
                ? Math.max(0, from - 1)
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? count - 1
                    : null;
          if (next === null) return;
          event.preventDefault();
          if (next === from) return;
          stripRef.current
            ?.querySelector<HTMLElement>(`[data-publish-card="${next}"]`)
            ?.focus({ preventScroll: true });
          scrollToIndex(next);
          if (next === indexRef.current) return;
          indexRef.current = next;
          change.current(next);
        }}
        onScroll={() => {
          const strip = stripRef.current;
          if (
            strip !== null &&
            touchRef.current.active &&
            Math.abs(
              readStripOffset(strip, legacyRef.current) -
                touchRef.current.startOffset,
            ) >= FEED_POST_TAP_TOLERANCE_PX
          )
            suppressUntilRef.current =
              performance.now() + FEED_POST_CLICK_SUPPRESSION_MS;
          if (settleTimerRef.current !== null)
            window.clearTimeout(settleTimerRef.current);
          settleTimerRef.current = window.setTimeout(
            settle,
            FEED_POST_SETTLE_MS,
          );
        }}
        onTouchCancelCapture={() => {
          touchRef.current.active = false;
        }}
        onTouchEndCapture={() => {
          touchRef.current.active = false;
        }}
        onTouchStartCapture={(event) => {
          const strip = stripRef.current;
          if (event.touches.length !== 1 || strip === null) return;
          touchRef.current = {
            active: true,
            startOffset: readStripOffset(strip, legacyRef.current),
          };
        }}
        role="group"
        style={{ "--publish-stage-aspect": String(ratio) } as CSSProperties}
      >
        {slides.map((slide, index) => {
          const broken = slide.src !== null && failed.has(slide.key);
          const fit =
            slide.size === null ? "contain" : slideFit(slide.size, ratio);
          const chip = slide.chip ?? null;
          const glyph: PublishChipGlyph | null =
            chip === null
              ? null
              : (chip.glyph ?? (chip.attention ? { kind: "error" } : null));
          const statusText = slide.statusText ?? null;
          const shown =
            broken || slide.src === null
              ? statusText === null
                ? broken
                  ? "图像无法加载"
                  : slide.status === "unavailable"
                    ? "暂时无法预览"
                    : "正在准备预览"
                : null
              : null;
          const name = [
            `编辑第 ${index + 1} 张`,
            index === 0 ? "首图" : null,
            statusText,
            shown,
          ]
            .filter((part) => part !== null)
            .join("，");
          return (
            <button
              key={slide.key}
              aria-label={name}
              className={styles.card}
              data-feed-slide-edit={index}
              data-fit={fit}
              data-publish-card={index}
              onClick={() => {
                // The shown card from now on: back from 编辑, 发布 opens at it.
                if (index !== indexRef.current) {
                  indexRef.current = index;
                  change.current(index);
                }
                onOpenItem(index);
              }}
              onContextMenu={(event) => event.preventDefault()}
              type="button"
            >
              {broken ? (
                <span
                  className={styles.cardPlaceholder}
                  data-publish-placeholder="failed"
                >
                  <Icon aria-hidden="true" name="error" />
                  图像无法加载
                </span>
              ) : slide.src === null ? (
                <span
                  className={styles.cardPlaceholder}
                  data-publish-placeholder={slide.status}
                >
                  {slide.status === "unavailable" ? "无法预览" : "准备中"}
                </span>
              ) : (
                <img
                  alt=""
                  className={styles.cardImage}
                  decoding="async"
                  draggable={false}
                  loading={index === 0 ? "eager" : "lazy"}
                  onError={() =>
                    setFailed((previous) => new Set(previous).add(slide.key))
                  }
                  src={slide.src}
                  style={
                    fit === "cover" && slide.placeholderColor !== undefined
                      ? { backgroundColor: slide.placeholderColor }
                      : undefined
                  }
                />
              )}
              {index === 0 ? (
                <span aria-hidden="true" className={styles.cardBadge}>
                  <span className={styles.firstBadge}>首图</span>
                </span>
              ) : null}
              {chip === null ? null : (
                <span aria-hidden="true" className={styles.cardStatus}>
                  <span
                    className={selectStyles.tileChip}
                    data-attention={chip.attention ? "true" : undefined}
                    data-publish-chip=""
                  >
                    {glyph === null ? null : <ChipGlyph glyph={glyph} />}
                    <span className={selectStyles.tileChipText}>
                      {chip.label}
                    </span>
                  </span>
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className={styles.caption} data-feed-preview-caption="" id={captionId}>
        第 1 张在最右，向右滑看下一张
        {total > count
          ? `；动态最多显示前 ${count} 张，其余 ${total - count} 张仅在作品页显示`
          : ""}
      </p>
    </div>
  );
};

interface BareTextProps {
  readonly field: Extract<EditorField, "title" | "body">;
  /** 标题 or 正文: the hidden label and the issue messages' subject. */
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly rule: EditorTextRule;
  /** A failure the account reported for this field. */
  readonly error: string | null;
  readonly placeholder: string;
  readonly autoFocus?: boolean | undefined;
  /** 正文's note, shown while it has focus (mockup A `.fHint`). */
  readonly hint?: string | undefined;
  /** 正文's tools row, before its counter (「@ 提醒用户」). */
  readonly tools?: ReactNode;
}

/**
 * 标题 or 正文 without a box (mockup A `.canvas`): the shared counting rule
 * and messages of `TextField` and its data hooks (`data-editor-field`,
 * `data-editor-input`, `data-editor-autofocus`), with a hidden label and a
 * counter that shows from 80% of the limit and turns red past it. 正文 grows
 * with its text and keeps its line breaks.
 */
const BareText = ({
  field,
  label,
  value,
  onChange,
  rule,
  error,
  placeholder,
  autoFocus = false,
  hint,
  tools,
}: BareTextProps) => {
  const id = useId();
  const counterId = useId();
  const errorId = useId();
  const hintId = useId();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const multiline = field === "body";
  const checked = checkEditorText(value, rule);
  const local =
    checked.issue === null
      ? null
      : issueMessage(label, checked.issue, rule.maximum);
  const message = error ?? local;
  const over = checked.length > rule.maximum;
  const describedBy = [
    counterId,
    message === null ? null : errorId,
    hint === undefined ? null : hintId,
  ]
    .filter((entry): entry is string => entry !== null)
    .join(" ");

  // 正文 grows with its text (as `TextField` does).
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (area === null) return;
    area.style.height = "auto";
    if (area.scrollHeight > 0) area.style.height = `${area.scrollHeight}px`;
  }, [value]);

  const common = {
    "aria-required": field === "title" || undefined,
    "aria-describedby": describedBy,
    "aria-invalid": message === null ? undefined : true,
    "data-editor-autofocus": autoFocus ? "" : undefined,
    "data-editor-input": field,
    id,
    placeholder,
    value,
  } as const;

  const counter = (
    <span
      className={styles.counter}
      data-over={over ? "true" : undefined}
      id={counterId}
    >
      <span
        aria-hidden="true"
        hidden={!over && checked.length < rule.maximum * COUNTER_FROM}
      >
        {checked.length}/{rule.maximum}
      </span>
      <span className={editorStyles.visuallyHidden}>
        已输入 {checked.length} 字，最多 {rule.maximum} 字
      </span>
    </span>
  );

  return (
    <div className={styles.bareField} data-editor-field={field}>
      <label className={editorStyles.visuallyHidden} htmlFor={id}>
        {label}
        {multiline ? "（可选）" : "（必填）"}
      </label>
      {multiline ? (
        <textarea
          {...common}
          ref={areaRef}
          className={styles.bodyInput}
          onChange={(event) => onChange(event.currentTarget.value)}
          rows={4}
        />
      ) : (
        <div className={styles.titleRow}>
          <input
            {...common}
            autoComplete="off"
            className={styles.titleInput}
            onChange={(event) => onChange(event.currentTarget.value)}
            type="text"
          />
          {counter}
        </div>
      )}
      {hint === undefined ? null : (
        <p className={styles.bareHint} id={hintId}>
          {hint}
        </p>
      )}
      {message === null ? null : (
        <p className={`${editorStyles.error} ${styles.bareError}`} id={errorId}>
          {message}
          {checked.issue === "line_break" ? (
            <button
              className={`${styles.inlineAction} ${styles.lineAction}`}
              onClick={() => onChange(value.replace(/[\r\n]+/gu, " ").trim())}
              type="button"
            >
              移除换行
            </button>
          ) : null}
        </p>
      )}
      {multiline ? (
        <div className={styles.bodyTools}>
          {tools}
          {counter}
        </div>
      ) : null}
    </div>
  );
};

/**
 * Screen 3 · 发布 (#244 r3, mockup A's 发布: the Owner chose the last screen
 * of the mockup titled 「方向 A · Instagram 式」). Under the bar (Back,
 * 发布作品 over the save status, ≡ 更多操作 alone at the end; 完成 while a
 * field has the keyboard): the work as cards at the feed ratio, right to
 * left, a tap opening 编辑 at that photo; 标题 and 正文 without boxes, with
 * 「@ 提醒用户」 and their counters; one hairline; then 作品性质 as chips and
 * 可见范围 as a segment, each with its description, the references in a
 * sheet; then the confirmation sheet's hints, issues and announcements. The
 * pinned bar holds the line saying why 发布 cannot go yet (or that every
 * photo is ready), then 预览, 保存草稿 and the seal-red 发布, and hides while
 * a field has the keyboard. Everything arrives through props; the screen
 * holds no state of its own beyond that focus and keyboard.
 */
export const PublishScreen = ({
  editor,
  title,
  saveStatus,
  saveAction,
  menu,
  backButtonRef,
  onBack,
  preview,
  textProps,
  references,
  onReferences,
  onOpenPreview,
  notices,
  confirmation,
  publish,
}: PublishScreenProps) => {
  const fieldsRef = useRef<HTMLDivElement>(null);
  // Hidden while a field has the keyboard (§6 G22, S3.8): typing into one
  // with the on-screen keyboard up, never focus alone.
  const typing = useTextEntryFocus(fieldsRef);
  const keyboard = useKeyboardShown(fieldsRef);
  const keyboardUp = typing && keyboard;
  const { state } = editor;
  const { state: text, store } = textProps;
  const blocked =
    publish.disabled === true || confirmationBlocked(confirmation);
  const reason = publishReason(confirmation, publish.label, blocked);
  // 前往处理 belongs to the line above 发布; the sheet only announces.
  const { onResolveMedia, ...sheet } = confirmation;
  const slides = preview?.slides ?? [];
  const referencesOpen =
    references !== null && hasReferences(text.authorshipKind);

  return (
    <PhoneScreen
      action={keyboardUp ? <PublishDoneButton /> : menu}
      backButtonRef={backButtonRef}
      backLabel={state.items.length > 0 ? "返回编辑照片" : "返回选择照片"}
      barLine="scrolled"
      contentClassName={styles.content}
      footer={
        <PublishBar
          busy={publish.busy}
          disabled={blocked}
          label={publish.label}
          onPreview={onOpenPreview}
          onResolveMedia={onResolveMedia}
          onSubmit={publish.onSubmit}
          reason={reason}
          saveAction={saveAction}
        />
      }
      footerHidden={keyboardUp}
      footerLayout="stacked"
      onBack={onBack}
      overlay={
        referencesOpen ? (
          <ReferenceSheet
            focus={references}
            onClose={() => onReferences(null)}
            state={text}
            store={store}
          />
        ) : null
      }
      screen="publish"
      secondLine={saveStatus}
      title={title}
    >
      <div className={styles.status} data-publish-status="">
        {notices}
      </div>
      {preview !== null && slides.length > 0 ? (
        <PublishPreviewStrip
          activeIndex={preview.activeIndex}
          onActiveIndexChange={preview.onActiveIndexChange}
          onOpenItem={preview.onOpenItem}
          slides={slides}
          total={preview.total}
        />
      ) : state.items.length === 0 ? (
        <div className={styles.addRow} data-publish-add="">
          <button className={styles.addTile} onClick={onBack} type="button">
            添加照片
          </button>
        </div>
      ) : null}
      <div
        className={styles.writing}
        data-editor-text-settings=""
        ref={fieldsRef}
      >
        <BareText
          autoFocus={textProps.autoFocusTitle === true}
          error={text.fieldErrors.title ?? null}
          field="title"
          label="标题"
          onChange={store.setTitle}
          placeholder="添加标题"
          rule={titleRule}
          value={text.title}
        />
        <BareText
          error={text.fieldErrors.body ?? null}
          field="body"
          hint="保留换行；首尾的空白不计入字数"
          label="正文"
          onChange={store.setBody}
          placeholder="写下作品的说明、释文或心得"
          rule={bodyRule}
          tools={
            <MentionControl
              mentions={text.mentions}
              onChange={store.setBody}
              text={text.body}
            />
          }
          value={text.body}
        />
      </div>
      <hr className={styles.divider} data-publish-divider="" />
      <AuthorshipSection
        onOpenReferences={() => onReferences("referenceTitle")}
        state={text}
        store={store}
      />
      <VisibilitySection state={text} store={store} />
      <div className={styles.confirmation}>
        <ConfirmationSheet {...sheet} primary="hidden" summary="hidden" />
      </div>
    </PhoneScreen>
  );
};
