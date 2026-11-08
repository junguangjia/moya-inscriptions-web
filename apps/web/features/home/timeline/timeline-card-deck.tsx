"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { motion } from "@moya/design-tokens";
import { Icon } from "@moya/ui";

import { useOptionalAuthors } from "../../authors/author-context";
import { AuthorDialog } from "../../authors/author-dialog";
import { UNTITLED_WORK_LABEL } from "../../authors/content-card";
import {
  ownWorkAudienceLabel,
  ownWorkAudienceNote,
  ownWorkAudienceOf,
} from "../../authors/own-work-audience";
import { workCard } from "../../authors/profile-list";
import {
  localCatalogMediaSrc,
  localCatalogRenditions,
} from "../../detail/local-catalog-media";
import {
  placeholderStyle,
  responsiveImage,
} from "../../media/responsive-media";
import { TimelineAttachPicker } from "./timeline-attach-picker";
import { useTimelinePosts } from "./timeline-entry-posts";
import { timelineEntryDate } from "./timeline-model";
import styles from "./timeline-card-deck.module.css";

import type {
  CSSProperties,
  KeyboardEvent,
  PointerEvent,
  RefObject,
  WheelEvent,
} from "react";
import type { TimelineEntry, UserWork } from "@moya/contracts";
import type { AuthorDialogNavigationHandle } from "../../authors/author-dialog";
import type { TimelineEntryPostsActions } from "./timeline-entry-posts";
import type { TimelineRowLayout } from "./timeline-model";

/*
 * Issue #422 (timeline-deck-v1): an entry with a Catalog page or with posts
 * opens as a deck of floating cards over the blurred page. Owner direction
 * (2026-11-07):
 *
 *   点开一个词条后应该悬浮展示卡片，背景做高斯模糊。如果有多个用户上传的卡片
 *   就做成左右滑动可以切换卡片，做成扇形切换的动画。右下角放上传按钮来让用户
 *   上传词条。点开某一个卡片后不要再显示上传
 *
 * The Catalog card leads, then the posts in their list's order; the upload
 * button belongs to the deck alone, so a card that opens takes it away.
 */

/** Cards on each side of the front one that the reader sees. */
export const DECK_WINDOW = 2;
/**
 * One more on each side is drawn, hidden exactly under the outermost card
 * the reader sees, so a card enters and leaves the fan by sliding out from
 * under it or back under it, never appearing or vanishing.
 */
export const DECK_EDGE = DECK_WINDOW + 1;
/**
 * After a switch the cards of the window it left stay drawn until their
 * move has settled, so a jump of two never drops a card mid-move.
 */
const SETTLE_MS = Number.parseFloat(motion.duration.slow) + 60;
/** The deck's short fade on Back, Escape, × or a tap beside the cards. */
const LEAVE_MS = Number.parseFloat(motion.duration.fast);
/**
 * A card's height over its width: a 3:4 window in its mat over the caption
 * is about 1.42 (tablet) to 1.51 (phone), 1.6 at the 160px floor. The lift
 * below takes 1.4, under all of them, so a turned card rises a little more
 * than it must, never less. Only a very short window, which hides the label
 * (about 1.25), lets a turned corner dip up to 1.2% of a card (some 2px)
 * into the gap above the cue's row, never into the row.
 */
const CARD_ASPECT = 1.4;
/** The fan's pivot, in card heights from the top: transform-origin 50% 220%. */
const PIVOT_DEPTH = 2.2;
/** Per card from the front: the turn, the shrink and the travel along the fan. */
const TURN_PER_CARD = 9;
const SHRINK_PER_CARD = 0.07;
/** A share of the card's own width (%). */
const TRAVEL_PER_CARD = 22;
/** A pointer travels this far before it is a swipe (or the page's scroll). */
const SWIPE_SLOP_PX = 8;
/** A swipe past this share of a card's width moves to the next card. */
const SWITCH_FRACTION = 0.2;
/** A flick this fast (px per ms) and this long moves even when short. */
const FLICK_SPEED = 0.5;
const FLICK_MIN_PX = 24;
/** Past either end the cards follow the finger this much, then spring back. */
const EDGE_RESISTANCE = 0.3;
/** The width used before a card has been measured (a server or test render). */
const FALLBACK_CARD_PX = 300;
/** The phone card is ~76% of the viewport; tablet and wide 480 at most. */
const CARD_SIZES = "(min-width: 768px) 480px, 76vw";

/**
 * What the deck may do. The post actions are the 词条卡's; the host closes
 * the deck first and acts from its own opener, as the timeline's sheets do.
 */
export interface TimelineDeckActions extends TimelineEntryPostsActions {
  /** The Catalog card: the record's Detail. */
  readonly openCatalog: (catalogId: string, opener: HTMLElement) => void;
}

/**
 * The open rule: a Catalog page or at least one post opens the deck; an
 * entry with neither keeps its 词条卡, which is where its first upload starts.
 */
export const timelineDeckOpens = (
  entry: Pick<TimelineEntry, "catalogId">,
  postCount: number,
): boolean => entry.catalogId !== null || postCount > 0;

export interface TimelineDeckPose {
  /** Along the fan, as a share of the card's own width (%). */
  readonly x: number;
  /**
   * Up, as a share of the card's own height (%, zero or negative): a turned
   * card rises until its lowest corner is on the front card's bottom line.
   */
  readonly y: number;
  /** Degrees around the pivot under the deck. */
  readonly rotate: number;
  readonly scale: number;
  /**
   * How much of the dimming layer inside the card shows, 0 to 1. A card is
   * never see-through: no words of a card behind show through one in front.
   */
  readonly dim: number;
  /** Reduced motion only: the front card shows and the others fade out. */
  readonly opacity: number;
  readonly layer: number;
  /** DECK_EDGE or more away: hidden under the outermost card that shows. */
  readonly far: boolean;
}

/** Two decimals, and never a negative zero. */
const rounded = (value: number) => Math.round(value * 100) / 100 + 0;

/**
 * How far a card turned by `rotate` and drawn at `scale` rises, as a share of
 * its height, so that none of its corners reaches below the front card's
 * bottom line: the cue's row under the cards stays clear at every pose.
 */
const liftOf = (rotate: number, scale: number): number => {
  const turn = (Math.abs(rotate) * Math.PI) / 180;
  const halfWidth = 0.5 / CARD_ASPECT;
  const lowest =
    PIVOT_DEPTH +
    scale * halfWidth * Math.sin(turn) -
    scale * (PIVOT_DEPTH - 1) * Math.cos(turn);
  return Math.max(0, lowest - 1);
};

/**
 * Where a card stands in the fan at `offset` cards from the front (a drag
 * adds its fraction). Neighbours turn out around a pivot under the deck,
 * smaller and dimmer the further they are; past DECK_WINDOW a card keeps the
 * outermost pose, under that card, and hides at DECK_EDGE. The layer follows
 * the distance, so the card coming to the front passes over the one leaving
 * it: halfway through a drag, or at once on a tap, an arrow or a key. With
 * reduced motion nothing turns or travels and only the front card shows, so
 * a switch is a cross-fade.
 */
export const timelineDeckPose = (
  offset: number,
  reduced: boolean,
): TimelineDeckPose => {
  const distance = Math.abs(offset);
  const layer = Math.max(1, 100 - Math.round(distance * 10));
  const far = distance >= DECK_EDGE;
  if (reduced)
    return {
      x: 0,
      y: 0,
      rotate: 0,
      scale: 1,
      dim: 0,
      opacity: distance < 0.5 ? 1 : 0,
      layer,
      far,
    };
  const reach = Math.sign(offset) * Math.min(distance, DECK_WINDOW);
  const rotate = rounded(reach * TURN_PER_CARD);
  const scale = rounded(1 - Math.abs(reach) * SHRINK_PER_CARD);
  return {
    x: rounded(reach * TRAVEL_PER_CARD),
    y: rounded(-liftOf(rotate, scale) * 100),
    rotate,
    scale,
    dim: rounded(Math.abs(reach) / DECK_WINDOW),
    opacity: 1,
    layer,
    far,
  };
};

type DeckCard =
  | { readonly kind: "catalog"; readonly key: string; readonly id: string }
  | { readonly kind: "post"; readonly key: string; readonly work: UserWork };

/** The deck itself, its upload menu, or the attach sheet over it. */
type DeckStep = "deck" | "menu" | "attach";

const usePrefersReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const change = () => setReduced(query.matches);
    query.addEventListener?.("change", change);
    return () => query.removeEventListener?.("change", change);
  }, []);
  return reduced;
};

const stopWheel = (event: WheelEvent<HTMLElement>) => event.stopPropagation();

const poseStyle = (pose: TimelineDeckPose): CSSProperties =>
  ({
    "--deck-x": `${pose.x}%`,
    "--deck-y": `${pose.y}%`,
    "--deck-rotate": `${pose.rotate}deg`,
    "--deck-scale": String(pose.scale),
    "--deck-dim": String(pose.dim),
    "--deck-opacity": String(pose.opacity),
    zIndex: pose.layer,
  }) as CSSProperties;

/** Set on html while a deck is open; the shell's dock reads it. */
const FLOATING_ACTIONS_HIDDEN = "data-floating-actions-hidden";
let floatingActionsHidden = 0;
/**
 * Asks the shell to hide its dock and create action while a deck is open:
 * the deck draws its own 「上传」, and theirs would show through the blur as
 * a second 「+」. Counted, so the last deck to go gives them back.
 */
const useHideFloatingActions = () => {
  useEffect(() => {
    const html = document.documentElement;
    floatingActionsHidden += 1;
    html.setAttribute(FLOATING_ACTIONS_HIDDEN, "");
    return () => {
      floatingActionsHidden -= 1;
      if (floatingActionsHidden === 0)
        html.removeAttribute(FLOATING_ACTIONS_HIDDEN);
    };
  }, []);
};

/**
 * The deck covers the whole window. A desktop page keeps a stable scrollbar
 * gutter while a modal holds its scroll, and a dialog sized to the page's
 * viewport would leave that strip bright; the dialog grows by the gutter,
 * read again on resize.
 */
const useCoverScrollbarGutter = (rootRef: RefObject<HTMLElement | null>) => {
  useLayoutEffect(() => {
    const dialog = rootRef.current?.closest("dialog");
    if (!dialog) return undefined;
    const measure = () => {
      const page = document.documentElement.clientWidth;
      const gutter = page > 0 ? Math.max(0, window.innerWidth - page) : 0;
      dialog.style.setProperty("--deck-gutter", `${gutter}px`);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [rootRef]);
};

/** The Catalog card: the row's own image when it has one, else its title. */
const CatalogFace = ({ entry }: { readonly entry: TimelineEntry }) => {
  const { media, catalogId } = entry;
  const image =
    media === null || catalogId === null
      ? null
      : responsiveImage(
          {
            ...media,
            src: localCatalogMediaSrc(media.src, catalogId, media.id),
            renditions: localCatalogRenditions(media.renditions),
          },
          CARD_SIZES,
        );
  return (
    <>
      <span className={styles.cover} data-fit="contain">
        {media === null || image === null ? (
          <span className={styles.coverTitle}>{entry.title}</span>
        ) : (
          <img
            alt=""
            decoding="async"
            draggable={false}
            height={media.height}
            loading="lazy"
            sizes={image.sizes}
            src={image.src}
            srcSet={image.srcSet}
            /* No placeholder colour: on a contain surface its letterbox would stay tinted. */
            width={media.width}
          />
        )}
      </span>
      <span className={styles.foot}>
        {/* A card whose cover is its title does not say it twice. */}
        {image === null ? null : (
          <span className={styles.cardTitle}>{entry.title}</span>
        )}
        <span className={styles.cardMeta}>查看详情</span>
      </span>
    </>
  );
};

/**
 * A post card: the posts grid's cover, title and author. Without a cover the
 * card reads as its words: its excerpt, else its title (or 未命名作品), and
 * a title on the cover is not said again under it.
 */
const PostFace = ({ work }: { readonly work: UserWork }) => {
  const card = workCard(work);
  const label = work.title === "" ? UNTITLED_WORK_LABEL : work.title;
  const media = card.media;
  const image = media === null ? null : responsiveImage(media, CARD_SIZES);
  const words =
    media === null || image === null ? (card.excerpt ?? label) : null;
  const audience = ownWorkAudienceOf(work);
  const mark = audience === null ? null : ownWorkAudienceLabel(audience);
  return (
    <>
      <span className={styles.cover}>
        {media === null || image === null ? (
          <span className={styles.coverText}>{words}</span>
        ) : (
          <img
            alt=""
            decoding="async"
            draggable={false}
            height={media.height}
            loading="lazy"
            sizes={image.sizes}
            src={image.src}
            srcSet={image.srcSet}
            style={placeholderStyle(media.placeholderColor)}
            width={media.width}
          />
        )}
        {mark === null || audience === null ? null : (
          <span
            className={styles.audience}
            data-deck-post-audience=""
            title={ownWorkAudienceNote(audience) ?? undefined}
          >
            {mark}
          </span>
        )}
      </span>
      <span className={styles.foot}>
        {words === label ? null : (
          <span className={styles.cardTitle}>{label}</span>
        )}
        {work.authorName === "" ? null : (
          <span className={styles.cardMeta}>{work.authorName}</span>
        )}
      </span>
    </>
  );
};

/**
 * A card's accessible name. With more than one card it also says where the
 * card stands, which a screen reader cannot see from the fan.
 */
const cardLabel = (
  card: DeckCard,
  entry: TimelineEntry,
  index: number,
  total: number,
): string => {
  const place = total > 1 ? `第 ${index + 1} 张，共 ${total} 张` : null;
  if (card.kind === "catalog")
    return [entry.title, "查看详情", place]
      .filter((part) => part !== null)
      .join("，");
  const { work } = card;
  const label = work.title === "" ? UNTITLED_WORK_LABEL : work.title;
  const audience = ownWorkAudienceOf(work);
  const mark = audience === null ? null : ownWorkAudienceLabel(audience);
  return [label, work.authorName, mark, place]
    .filter((part) => part !== null && part !== "")
    .join("，");
};

/**
 * The bottom-right upload button and its two choices. The menu is a step of
 * the deck's own navigation, so Back closes it alone. It takes the focus
 * when it opens; ↑/↓, Home and End move in it; Escape, Tab or a tap outside
 * closes it, and the deck gives the focus back to the button.
 */
const DeckUpload = ({
  buttonRef,
  onAttach,
  onDismiss,
  onOpen,
  onUpload,
  open,
}: {
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
  readonly onAttach: (opener: HTMLElement) => void;
  readonly onDismiss: () => void;
  readonly onOpen: () => void;
  readonly onUpload: (opener: HTMLElement) => void;
  readonly open: boolean;
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) menuRef.current?.querySelector("button")?.focus();
  }, [open]);
  const choose = (action: (opener: HTMLElement) => void) => {
    const opener = buttonRef.current;
    if (opener !== null) action(opener);
  };
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      // The menu closes before the deck does, and the focus never falls
      // into a menu that is going.
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
      return;
    }
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ??
        []),
    ];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const target =
      event.key === "ArrowDown"
        ? (at + 1) % items.length
        : event.key === "ArrowUp"
          ? (at - 1 + items.length) % items.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : null;
    if (target === null) return;
    event.preventDefault();
    items[target]?.focus();
  };
  return (
    <>
      {open ? (
        <>
          <button
            aria-hidden="true"
            className={styles.menuCatcher}
            onClick={onDismiss}
            tabIndex={-1}
            type="button"
          />
          <div
            aria-label="上传"
            className={styles.menu}
            data-timeline-deck-menu=""
            onKeyDown={onMenuKey}
            ref={menuRef}
            role="menu"
          >
            <button
              className={styles.menuItem}
              data-timeline-deck-new=""
              onClick={() => choose(onUpload)}
              role="menuitem"
              type="button"
            >
              上传新帖子
            </button>
            <button
              className={styles.menuItem}
              data-timeline-deck-attach=""
              onClick={() => choose(onAttach)}
              role="menuitem"
              type="button"
            >
              关联我发过的帖子
            </button>
          </div>
        </>
      ) : null}
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="上传"
        className={styles.upload}
        data-timeline-deck-upload=""
        onClick={open ? onDismiss : onOpen}
        ref={buttonRef}
        type="button"
      >
        {/* Drawn locally, as the dock's create action draws its own. */}
        <svg
          aria-hidden="true"
          className={styles.uploadIcon}
          focusable="false"
          viewBox="0 0 24 24"
        >
          <path d="M12 5v14m-7-7h14" />
        </svg>
      </button>
    </>
  );
};

interface Gesture {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly startedAt: number;
  readonly width: number;
  axis: "x" | null;
  dx: number;
}

/** The deck's own keys never act from these: they keep their arrows. */
const KEEPS_ARROWS =
  "[role='menu'], input, textarea, select, [contenteditable='true']";

/**
 * The card deck of one timeline entry: a modal over the whole window at every
 * width, whose Back, Escape, × and background tap fade it out and give the
 * focus back to the row. Cards switch by swipe, by the arrows beside the
 * 「1 / N」 cue under the cards, and by ←/→ from anywhere in it; the front
 * card and two on each side show, and the posts page in as the reader nears
 * the end. The header and the cue keep their rows from the first frame, so
 * nothing moves when the posts arrive, and no card ever reaches the cue's
 * row. The 「上传」 button's menu starts a new post or attaches one of the
 * reader's own in a sheet over the deck; browse-only has no button. While
 * the deck is open the shell's dock and its create action are hidden.
 */
export const TimelineCardDeck = ({
  actions,
  browseOnly = false,
  closeRequested = false,
  entry,
  layout,
  onClose,
}: {
  readonly actions: TimelineDeckActions;
  readonly browseOnly?: boolean;
  /** Finish the Back transition first, then `onClose` runs. */
  readonly closeRequested?: boolean;
  readonly entry: TimelineEntry;
  readonly layout: TimelineRowLayout;
  readonly onClose: () => void;
}) => {
  const authors = useOptionalAuthors();
  const viewerId = authors?.viewer?.id ?? null;
  const navigationRef = useRef<AuthorDialogNavigationHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const uploadRef = useRef<HTMLButtonElement>(null);
  const reduced = usePrefersReducedMotion();
  const { state: posts, showMore, reload } = useTimelinePosts(entry.id);
  const [current, setCurrent] = useState(0);
  /** The drag's share of a card's width; null while no swipe is under way. */
  const [drag, setDrag] = useState<number | null>(null);
  const [step, setStep] = useState<DeckStep>("deck");
  /** A menu choice was made: the menu goes while the host closes the deck. */
  const [chosen, setChosen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const swiped = useRef(false);
  const refocus = useRef(false);
  useHideFloatingActions();
  useCoverScrollbarGutter(rootRef);

  const cards: DeckCard[] = [];
  if (entry.catalogId !== null)
    cards.push({
      kind: "catalog",
      key: `catalog:${entry.catalogId}`,
      id: entry.catalogId,
    });
  if (posts.state === "ready")
    for (const work of posts.items)
      cards.push({ kind: "post", key: `work:${work.id}`, work });
  const last = Math.max(0, cards.length - 1);
  // An attachment's new preview may hold fewer posts than were shown.
  const at = Math.min(current, last);
  const total =
    (entry.catalogId === null ? 0 : 1) +
    (posts.state === "ready" ? Math.max(posts.total, posts.items.length) : 0);

  // The fronts since the cards last settled: their windows stay drawn.
  const [span, setSpan] = useState({ lo: at, hi: at });
  let spanLo = span.lo;
  let spanHi = span.hi;
  if (at < spanLo || at > spanHi) {
    spanLo = Math.min(spanLo, at);
    spanHi = Math.max(spanHi, at);
    setSpan({ lo: spanLo, hi: spanHi });
  }
  useEffect(() => {
    if (span.lo === at && span.hi === at) return undefined;
    const timer = window.setTimeout(
      () => setSpan({ lo: at, hi: at }),
      SETTLE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [at, span.lo, span.hi]);

  const back = useCallback(() => navigationRef.current?.back(), []);
  const go = (by: number, focusCard = false) => {
    const target = Math.max(0, Math.min(last, at + by));
    if (target === at) return;
    refocus.current = focusCard;
    setCurrent(target);
  };

  // An action's close hands over to the next view at once; Back, Escape, ×
  // and a tap beside the cards fade the deck out first. AuthorDialog has
  // already given up its history entry, so the next Back is the page's.
  const latest = useRef({ closeRequested, onClose, reduced });
  latest.current = { closeRequested, onClose, reduced };
  const leave = useCallback(() => {
    const { closeRequested: handingOver, onClose: close } = latest.current;
    if (handingOver || latest.current.reduced) close();
    else setLeaving(true);
  }, []);
  useEffect(() => {
    if (!leaving) return undefined;
    const timer = window.setTimeout(() => latest.current.onClose(), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  // The focus moves in: to the front card when there is one, else the title.
  // AuthorDialog (a child) has opened the modal by the time this runs.
  useEffect(() => {
    const card = stageRef.current?.querySelector<HTMLElement>(
      "button[data-deck-current]",
    );
    (card ?? titleRef.current)?.focus({ preventScroll: true });
  }, []);
  // A keyboard switch keeps the focus on the card in front.
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    stageRef.current
      ?.querySelector<HTMLElement>("button[data-deck-current]")
      ?.focus({ preventScroll: true });
  }, [at]);
  // ←/→ work wherever the focus is in the modal, the dialog itself and an
  // arrow at its end included; never in the upload menu, a field or the
  // attach sheet, which keep their own keys, nor while the deck fades out.
  const arrowKey = useRef<(event: globalThis.KeyboardEvent) => void>(
    () => undefined,
  );
  arrowKey.current = (event) => {
    if (event.defaultPrevented || event.altKey || event.metaKey) return;
    if (event.ctrlKey || step !== "deck" || leaving) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(KEEPS_ARROWS)) return;
    event.preventDefault();
    // From a card the focus follows to the new front card; from an arrow
    // or anywhere else it stays where it is.
    const onCard = (target?.closest("[data-deck-card]") ?? null) !== null;
    go(event.key === "ArrowRight" ? 1 : -1, onCard);
  };
  useEffect(() => {
    const dialog = rootRef.current?.closest("dialog");
    if (!dialog) return undefined;
    const listener = (event: globalThis.KeyboardEvent) =>
      arrowKey.current(event);
    dialog.addEventListener("keydown", listener);
    return () => dialog.removeEventListener("keydown", listener);
  }, []);
  // The next page is read while two cards are still ahead of the reader.
  const nearEnd = at >= last - DECK_WINDOW;
  const moreToRead =
    posts.state === "ready" &&
    posts.more === "idle" &&
    posts.items.length < posts.total;
  // A page that added nothing ends the reading, so a total the pages never
  // reach cannot keep asking; a fresh preview starts it again.
  const readFrom = useRef<number | null>(null);
  const loaded = posts.state === "ready" ? posts.items.length : 0;
  useEffect(() => {
    if (posts.state !== "ready") readFrom.current = null;
  }, [posts.state]);
  useEffect(() => {
    if (!nearEnd || !moreToRead) return;
    if (readFrom.current !== null && loaded <= readFrom.current) return;
    readFrom.current = loaded;
    showMore();
  }, [loaded, moreToRead, nearEnd, showMore]);
  // When the menu or the attach sheet closes, the focus returns to the
  // upload button (drawn again once the sheet has gone).
  const stepBefore = useRef(step);
  useEffect(() => {
    const before = stepBefore.current;
    stepBefore.current = step;
    // No scroll: where clip is not known the deck only hides its overflow.
    if (step === "deck" && before !== "deck")
      uploadRef.current?.focus({ preventScroll: true });
  }, [step]);

  const openCard = (card: DeckCard, opener: HTMLElement) => {
    if (card.kind === "catalog") actions.openCatalog(card.id, opener);
    else actions.openWork(card.work.id, opener);
  };
  const openMenu = () => {
    setChosen(false);
    setStep("menu");
  };
  const dismissMenu = () => {
    setChosen(false);
    setStep("deck");
  };
  // A choice that leaves the deck keeps the menu's history step: the host's
  // close then steps back over both at once.
  const upload = (opener: HTMLElement) => {
    setChosen(true);
    actions.upload(opener);
  };
  const attach = (opener: HTMLElement) => {
    if (authors?.checking) {
      dismissMenu();
      return;
    }
    if (!authors?.viewer) {
      setChosen(true);
      actions.signIn(opener);
      return;
    }
    setNotice(null);
    setChosen(false);
    setStep("attach");
  };

  const startSwipe = (event: PointerEvent<HTMLDivElement>) => {
    swiped.current = false;
    if (gesture.current !== null || cards.length < 2) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const front = stageRef.current?.querySelector<HTMLElement>(
      "[data-deck-current]",
    );
    gesture.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startedAt: event.timeStamp,
      width: front?.offsetWidth || FALLBACK_CARD_PX,
      axis: null,
      dx: 0,
    };
  };
  const moveSwipe = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (current === null || current.id !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (current.axis === null) {
      if (Math.abs(dx) < SWIPE_SLOP_PX && Math.abs(dy) < SWIPE_SLOP_PX) return;
      // A vertical start is the page's gesture: the deck lets it go.
      if (Math.abs(dy) >= Math.abs(dx)) {
        gesture.current = null;
        return;
      }
      current.axis = "x";
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    current.dx = dx;
    const pastEnd = (at === 0 && dx > 0) || (at === last && dx < 0);
    setDrag((pastEnd ? dx * EDGE_RESISTANCE : dx) / current.width);
  };
  const endSwipe = (event: PointerEvent<HTMLDivElement>) => {
    const ended = gesture.current;
    if (ended === null || ended.id !== event.pointerId) return;
    gesture.current = null;
    setDrag(null);
    if (ended.axis !== "x") return;
    // The click this release makes is not a tap; a later Enter is.
    swiped.current = true;
    window.setTimeout(() => {
      swiped.current = false;
    }, 0);
    const elapsed = Math.max(1, event.timeStamp - ended.startedAt);
    const distance = Math.abs(ended.dx);
    const far = distance > ended.width * SWITCH_FRACTION;
    const flick = distance >= FLICK_MIN_PX && distance / elapsed > FLICK_SPEED;
    if (far || flick) go(ended.dx < 0 ? 1 : -1);
  };
  const cancelSwipe = () => {
    gesture.current = null;
    setDrag(null);
  };

  const shown: { readonly card: DeckCard; readonly index: number }[] = [];
  const from = Math.max(0, Math.min(spanLo, at) - DECK_EDGE);
  const to = Math.min(last, Math.max(spanHi, at) + DECK_EDGE);
  for (let index = from; index <= to && index < cards.length; index += 1)
    shown.push({ card: cards[index]!, index });
  const fraction = reduced || drag === null ? 0 : drag;
  const failed =
    posts.state === "failed" ||
    (posts.state === "ready" && posts.more === "failed");
  const date = timelineEntryDate(entry);
  // 地点 and 保管 on one line, absent values left out, as the 词条卡.
  const place = [entry.province, entry.holder]
    .filter((part) => part !== null && part !== "")
    .join(" · ");
  const titleId = `timeline-deck-${entry.id}`;
  const attaching = step === "attach";

  return (
    <AuthorDialog
      className={`${styles.dialog} yoyi-blur-scrim yoyi-blur-scrim-paper${leaving ? ` ${styles.leaving}` : ""}`}
      closeRequested={closeRequested}
      headerHidden
      navigationDepth={step === "deck" ? 0 : 1}
      navigationRef={navigationRef}
      onBack={(depth) => {
        if (depth === 0) dismissMenu();
      }}
      onClose={leave}
      title={entry.fullTitle}
    >
      <div
        className={styles.root}
        data-deck-layout={layout}
        data-deck-leaving={leaving ? "" : undefined}
        data-deck-motion={reduced ? "reduced" : undefined}
        data-timeline-deck={entry.id}
        ref={rootRef}
      >
        {/* Local touches and wheels keep the home pager still under the modal. */}
        <div
          aria-labelledby={titleId}
          aria-roledescription="卡片组"
          className={styles.deck}
          data-local-horizontal=""
          inert={attaching}
          onWheel={stopWheel}
          role="group"
        >
          <button
            aria-hidden="true"
            className={styles.scrim}
            onClick={back}
            tabIndex={-1}
            type="button"
          />
          <header className={styles.header} data-timeline-deck-header="">
            <div className={styles.headerText}>
              <h2
                className={styles.title}
                id={titleId}
                ref={titleRef}
                tabIndex={-1}
              >
                {entry.fullTitle}
              </h2>
              {/* 年代 · 地点 · 保管 on one line, one separator throughout. */}
              {date === null && place === "" ? null : (
                <p className={styles.meta} data-timeline-deck-meta="">
                  {date}
                  {date !== null && place !== "" ? " · " : null}
                  {place === "" ? null : (
                    <span data-timeline-deck-place="">{place}</span>
                  )}
                </p>
              )}
            </div>
          </header>
          <div
            className={styles.stage}
            data-dragging={drag === null ? undefined : ""}
            data-timeline-deck-stage=""
            onClick={(event) => {
              // Beside the cards is the page behind them: a tap there closes.
              if (event.target === event.currentTarget && !swiped.current)
                back();
            }}
            onPointerCancel={cancelSwipe}
            onPointerDown={startSwipe}
            onPointerMove={moveSwipe}
            onPointerUp={endSwipe}
            ref={stageRef}
          >
            {cards.length === 0 && posts.state === "loading" ? (
              // The posts grid's placeholder until the first card is known.
              <div
                aria-busy="true"
                className={styles.card}
                data-deck-card="placeholder"
                data-deck-current=""
                style={poseStyle(timelineDeckPose(0, reduced))}
              />
            ) : cards.length === 0 ? (
              <div
                className={styles.card}
                data-deck-card="plain"
                data-deck-current=""
                style={poseStyle(timelineDeckPose(0, reduced))}
              >
                <span className={styles.cover}>
                  <span className={styles.coverTitle}>{entry.title}</span>
                </span>
                {posts.state === "ready" && !browseOnly ? (
                  <span className={styles.foot}>
                    <span className={styles.cardMeta}>
                      发布后会出现在这个词条下。
                    </span>
                  </span>
                ) : null}
              </div>
            ) : (
              shown.map(({ card, index }) => {
                const front = index === at;
                const pose = timelineDeckPose(index - at + fraction, reduced);
                return (
                  <button
                    aria-hidden={front ? undefined : "true"}
                    aria-label={cardLabel(card, entry, index, total)}
                    className={styles.card}
                    data-deck-card={card.kind}
                    data-deck-current={front ? "" : undefined}
                    data-deck-far={pose.far ? "" : undefined}
                    data-deck-index={index}
                    data-deck-post={
                      card.kind === "post" ? card.work.id : undefined
                    }
                    key={card.key}
                    onClick={(event) => {
                      if (swiped.current) {
                        swiped.current = false;
                        return;
                      }
                      if (front) openCard(card, event.currentTarget);
                      else {
                        refocus.current = true;
                        setCurrent(index);
                      }
                    }}
                    style={poseStyle(pose)}
                    tabIndex={front ? 0 : -1}
                    type="button"
                  >
                    {card.kind === "catalog" ? (
                      <CatalogFace entry={entry} />
                    ) : (
                      <PostFace work={card.work} />
                    )}
                  </button>
                );
              })
            )}
          </div>
          <div className={styles.below}>
            {/*
             * Its own row under the cards, clear of the fan, held from the
             * first frame and shown from two cards on.
             */}
            <div
              className={styles.nav}
              data-shown={total > 1 ? "" : undefined}
              data-timeline-deck-nav=""
            >
              {/* At an end an arrow stays where it is, focus included. */}
              <button
                aria-disabled={at === 0 ? "true" : undefined}
                aria-label="上一张"
                className={styles.arrow}
                data-direction="previous"
                onClick={() => go(-1)}
                type="button"
              >
                <Icon aria-hidden="true" name="previous" />
              </button>
              <p
                aria-live="polite"
                className={styles.position}
                data-timeline-deck-position=""
              >
                {total > 1 ? `${at + 1} / ${total}` : null}
              </p>
              <button
                aria-disabled={at === last ? "true" : undefined}
                aria-label="下一张"
                className={styles.arrow}
                data-direction="next"
                onClick={() => go(1)}
                type="button"
              >
                <Icon aria-hidden="true" name="next" />
              </button>
            </div>
            {/* Out of the column's flow, so the cards never move for them. */}
            {failed || notice !== null ? (
              <div className={styles.notes} data-timeline-deck-notes="">
                {failed ? (
                  <div className={styles.status}>
                    <p role="status">帖子载入失败</p>
                    <button
                      className={styles.statusAction}
                      onClick={posts.state === "failed" ? reload : showMore}
                      type="button"
                    >
                      重试
                    </button>
                  </div>
                ) : null}
                {notice === null ? null : (
                  <div className={styles.status}>
                    <p role="status">{notice}</p>
                  </div>
                )}
              </div>
            ) : null}
            {/*
             * In the cue's row: on phone at its end, level with the arrows
             * whatever the title's length; on tablet and wide in the
             * window's corner. The attach sheet takes the whole screen's
             * attention: no 「上传」 and no × beside or under it.
             */}
            {browseOnly || attaching ? null : (
              <DeckUpload
                buttonRef={uploadRef}
                onAttach={attach}
                onDismiss={dismissMenu}
                onOpen={openMenu}
                onUpload={upload}
                open={step === "menu" && !chosen}
              />
            )}
          </div>
          {attaching ? null : (
            <button
              aria-label="关闭"
              className={styles.close}
              data-timeline-deck-close=""
              onClick={back}
              type="button"
            >
              <Icon aria-hidden="true" name="close" />
            </button>
          )}
        </div>
        {attaching && viewerId !== null && !browseOnly ? (
          <div
            className={styles.attachLayer}
            data-local-horizontal=""
            onWheel={stopWheel}
          >
            <button
              aria-label="关闭"
              className={styles.attachScrim}
              onClick={back}
              tabIndex={-1}
              type="button"
            />
            <div
              className={styles.attachPanel}
              data-timeline-deck-attach-sheet=""
            >
              <TimelineAttachPicker
                authorId={viewerId}
                entryId={entry.id}
                entryTitle={entry.fullTitle}
                onAttached={(text) => {
                  setNotice(text);
                  readFrom.current = null;
                  reload();
                  actions.postsChanged?.();
                  back();
                }}
                onCancel={back}
              />
            </div>
          </div>
        ) : null}
      </div>
    </AuthorDialog>
  );
};
