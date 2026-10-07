"use client";
import { StudioName } from "./user-identity";
import { useAuthReturn, useAuthReturnView } from "../auth/auth-return";
import { Icon } from "@moya/ui";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type {
  AuthorProfile,
  DiscussionTarget,
  OwnComment,
} from "@moya/contracts";
import type { ProductShellProfileOverlayRenderProps } from "../product-shell/product-shell";
import { useProductShell } from "../product-shell/product-shell";
import { HorizontalPager } from "../shell/horizontal-pager";
import type { HorizontalPagerHandle } from "../shell/horizontal-pager";
import { authorClient } from "./author-data";
import { useAuthors } from "./author-context";
import { useDirectMessageEntry } from "../messages/direct-message-entry";
import { AvatarEntry } from "./avatar-editor";
import { ProfileEditor } from "./profile-editor";
import { ProfileSettings } from "./profile-settings";
import { ProfileList } from "./profile-list";
import { PeopleList } from "./people-list";
import { ProfileBackgroundEditor } from "./profile-background-editor";
import { coverCard, coverColors, decoded } from "./profile-cover-colors";
import type { CoverBox, CoverCardLayout } from "./profile-cover-colors";
import { requestIdentity } from "../shell/request-identity";
import media from "../publishing/ui/media/media.module.css";
import styles from "../user/user-presentation.module.css";
const tabs = ["works", "favorites", "likes", "history"] as const;
const publicTabs = tabs.slice(0, 3);
const labels = {
  works: "作品",
  favorites: "收藏",
  likes: "喜欢",
  history: "历史",
};
interface AuthorProfilePreview {
  readonly self?: boolean;
  readonly profile: AuthorProfile;
  readonly onFollowChange: (enabled: boolean) => void;
}
/**
 * In the collections stage the cover shrinks to a compact cover: the
 * identity rests this far below the top bar.
 */
const COVER_REST_GAP = 12;
/** Below the identity, the pinned tabs keep this much space. */
const COVER_PIN_GAP = 16;
/** A pinned identity must leave at least this much of the collections. */
const COVER_MIN_COLLECTIONS = 160;
/** The glass card reaches this far around the identity. */
const COVER_CARD_PAD = 10;

/** 屏蔽 lives behind ⋯ (the composer's 更多操作 menu pattern). */
const ProfileMoreMenu = ({
  name,
  onBlock,
}: {
  name: string;
  onBlock: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null),
    opener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Only claim Escape for the menu itself; a dialog keeps its own.
      const active = document.activeElement;
      if (!menu.current?.contains(active) && active !== opener.current) return;
      event.preventDefault();
      opener.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target) &&
        !opener.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);
  return (
    <div className={styles.moreActions}>
      <button
        type="button"
        ref={opener}
        className={styles.moreButton}
        aria-label="更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="5" cy="12" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="19" cy="12" r="1.75" />
        </svg>
      </button>
      {open && (
        <div
          className={styles.moreMenu}
          id={menuId}
          ref={menu}
          role="menu"
          aria-label={`对 ${name} 的更多操作`}
          onBlur={(event) => {
            // Tabbing away closes it; a press elsewhere (no new focus target)
            // is left to the outside-press handler.
            const next = event.relatedTarget;
            if (
              next instanceof Node &&
              !menu.current?.contains(next) &&
              !opener.current?.contains(next)
            )
              setOpen(false);
          }}
        >
          <button
            type="button"
            role="menuitem"
            data-profile-block=""
            onClick={() => {
              setOpen(false);
              // Keep focus on ⋯ through the confirmation and after a cancel.
              opener.current?.focus();
              onBlock();
            }}
          >
            屏蔽
          </button>
        </div>
      )}
    </div>
  );
};
interface AuthorProfilePresentationProps {
  /** Development-only local data; no runtime requests or account-cache writes. */
  readonly preview?: AuthorProfilePreview | undefined;
  /** Retain the overlay layout inside an already-owned modal surface. */
  readonly insideDialog?: boolean | undefined;
  /** Primary-page action; overlay profiles retain their Back button. */
  readonly headerStart?: ReactNode;
}
const ScopedAuthorProfile = ({
  state,
  backButtonRef,
  onClose,
  onViewChange,
  embedded = false,
  preview,
  insideDialog = false,
  headerStart,
}: ProductShellProfileOverlayRenderProps &
  AuthorProfilePresentationProps & { embedded?: boolean }) => {
  const directEntry = useDirectMessageEntry();
  const author = useAuthors(),
    shell = useProductShell(),
    isPreview = preview !== undefined,
    viewerId = isPreview ? null : author.viewer?.id,
    checking = isPreview ? false : author.checking,
    sessionError = isPreview ? false : author.sessionError,
    authorRevision = isPreview ? 0 : author.revision,
    id = preview?.profile.id ?? state.authorId ?? viewerId ?? null,
    owner = !isPreview && (id === viewerId || id === null),
    cacheKey = `profile:${id}`;
  const authReturn = useAuthReturn();
  const profileCapture = useRef({
    open: false,
    positions: {} as Record<string, number>,
  });
  const authReturnView = useAuthReturnView<{
    open: boolean;
    positions: Record<string, number>;
  }>(`profile-settings:${state.entryId}`, () => profileCapture.current);
  const [loadedProfile, setProfile] = useState<AuthorProfile | null>(() =>
      isPreview
        ? null
        : ((author.cache.get(cacheKey) as AuthorProfile | undefined) ?? null),
    ),
    [error, setError] = useState(""),
    [modal, setModal] = useState<"edit" | "settings" | "background" | null>(
      authReturnView?.open ? "settings" : null,
    ),
    [people, setPeople] = useState<"following" | "followers" | null>(null),
    [tint, setTint] = useState<{
      src: string;
      color: string;
      shade: string;
    } | null>(null),
    [card, setCard] = useState<{
      src: string;
      tint: string;
      alpha: number;
    } | null>(null),
    [chin, setChin] = useState<"cover" | "content">("cover"),
    [revision, setRevision] = useState(0),
    [progress, setProgress] = useState(
      Math.max(0, tabs.indexOf(state.tab as (typeof tabs)[number])),
    );

  const profile = preview?.profile ?? loadedProfile;
  const root = useRef<HTMLElement>(null),
    topBar = useRef<HTMLElement>(null),
    profileHeader = useRef<HTMLElement>(null),
    identityPanel = useRef<HTMLDivElement>(null),
    identityHead = useRef<HTMLDivElement>(null),
    scrollHint = useRef<HTMLButtonElement>(null),
    stage = useRef<"cover" | "content">("cover"),
    chinTimer = useRef(0),
    chinTarget = useRef<"cover" | "content">("cover"),
    cardTimer = useRef(0),
    cardRun = useRef(0),
    cardSampled = useRef(""),
    pendingScrollTop = useRef<number | null>(null),
    collapseHeight = useRef(0),
    pager = useRef<HorizontalPagerHandle<(typeof tabs)[number]>>(null),
    tabId = useId(),
    currentTab = state.tab === "comments" ? "works" : state.tab;
  const visibleTabs = owner ? tabs : publicTabs,
    viewTab = visibleTabs.includes(currentTab as (typeof tabs)[number])
      ? currentTab
      : "works";
  const ownProfile =
    !isPreview && !!profile?.isOwner && profile.id === viewerId;
  useEffect(() => {
    if ((modal === "edit" || modal === "background") && !ownProfile)
      setModal(null);
  }, [modal, ownProfile]);
  useEffect(() => {
    if (isPreview) return;
    let current = true;
    setError("");
    if (!id) {
      setProfile(null);
      return;
    }
    // Keep the loaded profile (and its editor) while the session is rechecked.
    // Cleanup retires any earlier read before a failed check invalidates it.
    if (checking || sessionError) return;
    void authorClient
      .profile(id)
      .then((result) => {
        if (current) {
          setProfile(result);
          author.cache.set(cacheKey, result);
        }
      })
      .catch((e) => {
        if (current) {
          setProfile(null);
          setError(e.message);
        }
      });
    return () => {
      current = false;
    };
  }, [
    id,
    viewerId,
    checking,
    sessionError,
    authorRevision,
    revision,
    isPreview,
  ]);
  const save = () => setRevision((v) => v + 1);
  useEffect(
    () => () => {
      window.clearTimeout(chinTimer.current);
      window.clearTimeout(cardTimer.current);
    },
    [],
  );
  // A web font arriving can rewrap the identity's text without resizing it:
  // the card's tint is sampled again for the new lines.
  useEffect(() => {
    let current = true;
    void document.fonts?.ready.then(() => {
      if (current) sampleCard();
    });
    return () => {
      current = false;
    };
  }, []);
  const positions = useRef<Record<string, number>>(
    isPreview
      ? {}
      : (authReturnView?.positions ??
          (author.cache.get(`profile-scroll:${state.entryId}`) as
            Record<string, number> | undefined) ??
          {}),
  );
  profileCapture.current = {
    open: modal === "settings",
    positions: { ...positions.current },
  };
  const scrollTab = viewTab;
  const departingTab = useRef<string | null>(null);
  const hasPhoto = () =>
    !!profileHeader.current?.querySelector(`.${styles.profileCover} img`);
  // The second resting place: a compact cover (the photo, frosted, behind the
  // identity right under the top bar) with the collections below it (the
  // first is the whole photo, at 0).
  const restTop = () => {
    const bar = topBar.current,
      panel = identityPanel.current,
      head = identityHead.current;
    if (!bar || !panel || !head) return 0;
    return Math.max(
      0,
      panel.offsetTop + head.offsetTop - bar.offsetHeight - COVER_REST_GAP,
    );
  };
  // The identity's bottom padding keeps the photo stage clear of the dock
  // and the scroll hint; in the collections stage the tabs slide up over it.
  const pinShift = () => {
    const panel = identityPanel.current;
    const padding = panel
      ? Number.parseFloat(getComputedStyle(panel).paddingBottom)
      : 0;
    return Number.isFinite(padding) ? Math.max(0, padding - COVER_PIN_GAP) : 0;
  };
  // A photo cover pins (compact cover, identity, tabs) only when the
  // collections still get room below; a taller identity (a long bio, a
  // landscape phone) scrolls freely instead.
  const coverFree = () => {
    const cover = profileHeader.current?.getBoundingClientRect().height ?? 0,
      tabs =
        root.current?.querySelector<HTMLElement>('[role="tablist"]')
          ?.offsetHeight ?? 0,
      port = scrollElement()?.clientHeight ?? 0;
    return (
      port > 0 &&
      cover - restTop() - pinShift() + tabs + COVER_MIN_COLLECTIONS > port
    );
  };
  const pinned = () => hasPhoto() && !coverFree();
  // The glass card at the collections stage, in the photo box (which then
  // spans the screen from the top down to the tabs): around the identity by
  // COVER_CARD_PAD, from under the top bar to just above the tabs.
  const cardBox = (
    rest = restTop(),
    shift = pinShift(),
  ): (CoverBox & { right: number }) | null => {
    const bar = topBar.current,
      panel = identityPanel.current,
      cover = profileHeader.current;
    if (!bar || !panel || !cover) return null;
    const style = getComputedStyle(panel);
    const inset = (value: string) => {
      const padding = Number.parseFloat(value);
      return Number.isFinite(padding)
        ? Math.max(0, padding - COVER_CARD_PAD)
        : 0;
    };
    const x = inset(style.paddingLeft),
      right = inset(style.paddingRight),
      y = bar.offsetHeight + COVER_REST_GAP - COVER_CARD_PAD,
      bottom =
        cover.getBoundingClientRect().height -
        rest -
        shift -
        (COVER_PIN_GAP - COVER_CARD_PAD);
    return {
      x,
      y,
      right,
      width: Math.max(0, cover.clientWidth - x - right),
      height: Math.max(0, bottom - y),
    };
  };
  // The card and the identity's text lines where they rest at the
  // collections stage, for sampling the card's tint.
  const cardLayout = (): CoverCardLayout | null => {
    const card = cardBox(),
      bar = topBar.current,
      cover = profileHeader.current,
      panel = identityPanel.current,
      head = identityHead.current;
    if (!card || !bar || !cover || !panel || !head) return null;
    const coverRect = cover.getBoundingClientRect(),
      // There the head rests COVER_REST_GAP under the bar.
      shift =
        bar.offsetHeight +
        COVER_REST_GAP -
        head.offsetTop -
        panel.getBoundingClientRect().top;
    // One box per line of text as laid out (a short name is a short box), or
    // the element's box where ranges cannot be measured.
    const texts: CoverBox[] = [];
    for (const element of panel.querySelectorAll<HTMLElement>(
      `h1, .${styles.coverMeta}, .${styles.coverBio}, .${styles.coverCount}`,
    )) {
      const lines: DOMRect[] = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        if (typeof range.getClientRects === "function")
          lines.push(...range.getClientRects());
      }
      const boxes = lines.filter((rect) => rect.width > 0 && rect.height > 0);
      for (const rect of boxes.length
        ? boxes
        : [element.getBoundingClientRect()])
        texts.push({
          x: rect.left - coverRect.left - 2,
          y: rect.top + shift - 2,
          width: rect.width + 4,
          height: rect.height + 4,
        });
    }
    return {
      width: cover.clientWidth,
      coverHeight: coverRect.height,
      card,
      texts,
    };
  };
  // Samples the card's tint from the decoded photo (an undecoded image can
  // draw nothing in WebKit); the stylesheet's default tint holds until then.
  // Only the latest request counts, and a layout already sampled is skipped.
  const sampleCard = () => {
    const image = profileHeader.current?.querySelector<HTMLImageElement>(
      `.${styles.profileCover} img`,
    );
    if (!image) return;
    const src = image.getAttribute("src") ?? "";
    const run = ++cardRun.current;
    void decoded(image).then(() => {
      if (run !== cardRun.current) return;
      const layout = cardLayout();
      const key = layout
        ? JSON.stringify([src, layout], (_, value: unknown) =>
            typeof value === "number" ? Math.round(value) : value,
          )
        : "";
      if (!layout || key === cardSampled.current) return;
      cardSampled.current = key;
      const next = coverCard(image, layout);
      setCard((previous) =>
        next
          ? previous?.src === src &&
            previous.tint === next.tint &&
            previous.alpha === next.alpha
            ? previous
            : { src, ...next }
          : previous?.src === src
            ? null
            : previous,
      );
    });
  };
  // The second resting place: the identity under the top bar with the tabs
  // pinned right below it.
  const restStage = () => restTop() + pinShift();
  // Where the collections pin. A pinned photo cover sticks at its second
  // resting place (compact cover, identity and tabs stay; only the
  // collections scroll). Otherwise the cover runs up under the top bar, so the
  // tabs pin once it has scrolled by its own height less the bar's.
  const coverCollapse = () =>
    pinned()
      ? restStage()
      : Math.max(
          0,
          (profileHeader.current?.getBoundingClientRect().height ?? 0) -
            (topBar.current?.offsetHeight ?? 0),
        );
  // Scroll-linked, written to the DOM (not state: it runs on every frame).
  // --cover-progress (0 photo → 1 collections) frosts the photo and turns its
  // dark shade into the page colour behind the collections. --cover-scroll
  // keeps the photo's box on screen down to the tabs, so the photo stays put
  // while the identity rises over it. The top bar wears the dark theme over
  // the photo; without a pinned photo it turns solid, in the page theme, once
  // the identity panel reaches it.
  const markCover = (top: number, instant = true) => {
    const bar = topBar.current,
      panel = identityPanel.current,
      page = root.current;
    if (!bar || !panel || !page) return;
    // Only scrolling animates the theme change; loading, restoring and
    // resizing apply it at once.
    if (instant) {
      page.setAttribute("data-cover-instant", "");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => page.removeAttribute("data-cover-instant")),
      );
    }
    const photo = hasPhoto(),
      free = photo && coverFree(),
      // Over a pinned photo the bar stays clear: the photo is always behind it.
      passed =
        (!photo || free) && top >= panel.offsetTop - bar.offsetHeight - 1;
    page.toggleAttribute("data-cover-free", free);
    bar.toggleAttribute("data-cover-passed", passed);
    const rest = restTop(),
      shift = pinShift();
    const cover = profileHeader.current?.getBoundingClientRect().height ?? 0;
    page.style.setProperty("--cover-rest", `${rest}px`);
    page.style.setProperty(
      "--cover-pinned",
      `${Math.max(0, cover - rest - shift)}px`,
    );
    // The photo keeps its full-cover size while its box shrinks, so the
    // compact cover shows its top part.
    page.style.setProperty("--cover-height", `${cover}px`);
    // The glass card waits where the identity rests; it does not move with
    // the scroll.
    const card = cardBox(rest, shift);
    if (card)
      for (const [name, value] of [
        ["top", card.y],
        ["left", card.x],
        ["right", card.right],
        ["height", card.height],
      ] as const)
        page.style.setProperty(`--cover-card-${name}`, `${value}px`);
    // A pinned cover stops scrolling at its second resting place; a free one
    // scrolls away whole after the first.
    page.style.setProperty(
      "--cover-scroll",
      `${photo ? Math.max(0, Math.min(top, free ? rest : rest + shift)) : 0}px`,
    );
    const progress = !photo
      ? 1
      : rest > 0
        ? Math.min(1, Math.max(0, top / rest))
        : top > 0
          ? 1
          : 0;
    page.style.setProperty("--cover-progress", progress.toFixed(3));
    const onPhoto = photo && progress < 0.5;
    stage.current = onPhoto ? "cover" : "content";
    page.setAttribute("data-profile-stage", stage.current);
    // Safari reads its bottom strip when a fixed element appears, not when a
    // colour changes mid-scroll: once scrolling rests, a fresh chin carries
    // the colour at the bottom edge, the identity's while it covers the edge.
    if (photo) {
      const port = scrollElement(),
        edge =
          !port || port === document.documentElement
            ? window.innerHeight
            : port.getBoundingClientRect().bottom;
      chinTarget.current = !free
        ? stage.current
        : panel.getBoundingClientRect().bottom > edge - 1
          ? "cover"
          : "content";
      window.clearTimeout(chinTimer.current);
      chinTimer.current = window.setTimeout(
        () => setChin(chinTarget.current),
        160,
      );
    }
    const hint = scrollHint.current;
    // A passed bar is solid in the reader's page colour, in their theme.
    for (const [element, dark] of [
      [bar, photo && !passed],
      [hint, onPhoto],
    ] as const)
      if (!element) continue;
      else if (dark) element.setAttribute("data-theme", "dark");
      else element.removeAttribute("data-theme");
    // A focused hint hands focus on to the collections before it goes inert.
    if (!onPhoto && hint?.contains(document.activeElement))
      page
        .querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.focus({ preventScroll: true });
    hint?.toggleAttribute("inert", !onPhoto);
    // A pinned cover scrolls the owner's pencil off the top: out of reach
    // there, so focus cannot land on it and leave the page mid-glide.
    profileHeader.current
      ?.querySelector(`.${styles.backgroundEdit}`)
      ?.toggleAttribute("inert", photo && !free && !onPhoto);
  };
  const scrollElement = () =>
    embedded
      ? shell.platform === "pc"
        ? ((document.scrollingElement ??
            document.documentElement) as HTMLElement)
        : root.current?.closest<HTMLElement>(
            '[data-primary-destination="user"]',
          )
      : root.current;
  const changeTab = (tab: (typeof tabs)[number]) => {
    if (tab === viewTab) return;
    // The pager sizes the destination before committing. Reading scrollTop
    // here can observe browser clamping and lose the departing body offset.
    const top = positions.current[viewTab] ?? scrollElement()?.scrollTop ?? 0;
    const collapse = coverCollapse();
    // All collections share the cover expansion. Once pinned, each collection
    // keeps its own body offset without bringing the cover back on a switch.
    const next =
      top < collapse - 1
        ? top
        : Math.max(collapse, positions.current[tab] ?? 0);
    pendingScrollTop.current = next;
    onViewChange(tab, next);
  };
  useLayoutEffect(() => {
    if (embedded && shell.activeDestination !== "user") return;
    const node = scrollElement();
    if (!node) return;
    node.scrollTop =
      pendingScrollTop.current ??
      (embedded
        ? positions.current[scrollTab]
        : state.profileScrollTop || positions.current[scrollTab]) ??
      0;
    pendingScrollTop.current = null;
    departingTab.current = null;
    positions.current[scrollTab] = node.scrollTop;
    markCover(node.scrollTop);
    const target = embedded && shell.platform === "pc" ? window : node;
    const scroll = () => {
      // Resizing for the next collection may clamp the document before its
      // commit. Preserve the position captured before that height write.
      if (departingTab.current === scrollTab) return;
      positions.current[scrollTab] = node.scrollTop;
      markCover(node.scrollTop, false);
      if (!isPreview)
        author.cache.set(`profile-scroll:${state.entryId}`, positions.current);
      if (!embedded) onViewChange(scrollTab, node.scrollTop);
    };
    target.addEventListener("scroll", scroll, { passive: true });
    return () => target.removeEventListener("scroll", scroll);
  }, [
    embedded,
    isPreview,
    scrollTab,
    state.entryId,
    profile?.isOwner,
    shell.activeDestination,
    shell.platform,
  ]);
  // The cover and the collections are two resting places: a gesture that
  // settles between them glides on in the direction it was going, so the
  // collections rise to fill the page and the cover returns whole. Only a
  // vertical user scroll (drag, wheel, keys) glides: taps, horizontal pager
  // swipes, restored positions and the pager's own height changes never do.
  useEffect(() => {
    if (embedded && shell.activeDestination !== "user") return;
    const node = scrollElement();
    if (!node) return;
    const target = embedded && shell.platform === "pc" ? window : node;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const keys = [
      "ArrowDown",
      "ArrowUp",
      "PageDown",
      "PageUp",
      "Home",
      "End",
      " ",
    ];
    // A nested dialog scrolls itself; keys typed into a field or pressed on a
    // button are not a page scroll either.
    const foreign = (event: Event, selector = "dialog") =>
      event.target instanceof Element && !!event.target.closest(selector);
    let touching = false,
      intent = Number.NEGATIVE_INFINITY,
      glideDirection = 0,
      interrupted = false,
      retries = 0,
      origin: { x: number; y: number } | null = null,
      direction = 0,
      last = node.scrollTop,
      glide: number | null = null,
      settle = 0,
      release = 0;
    const done = () => {
      glide = null;
      window.clearTimeout(release);
    };
    const intended = () => performance.now() - intent < 1500;
    const snap = () => {
      const rest = restStage(),
        top = node.scrollTop;
      if (touching || glide !== null || !intended()) return;
      intent = Number.NEGATIVE_INFINITY;
      if (rest <= 0 || top <= 0 || top >= rest - 1 || !direction) return;
      // An identity too tall to pin (a long bio) scrolls freely, so its lower
      // part and the collections can rest in view.
      if (!pinned()) return;
      glide = direction > 0 ? rest : 0;
      glideDirection = direction;
      node.scrollTo({
        top: glide,
        behavior: reduce?.matches ? "auto" : "smooth",
      });
      // A glide cut short (a tap, a sideways swipe, a scroll write) settles
      // on in its own direction, once.
      release = window.setTimeout(() => {
        done();
        if (retries < 1) resettle();
      }, 700);
    };
    function resettle() {
      retries += 1;
      intent = performance.now();
      direction = glideDirection;
      window.clearTimeout(settle);
      settle = window.setTimeout(snap, 90);
    }
    const scroll = () => {
      const top = node.scrollTop;
      if (top !== last) direction = top > last ? 1 : -1;
      last = top;
      // Momentum after a gesture keeps the gesture's intent alive.
      if (glide === null && intended()) intent = performance.now();
      if (glide !== null) {
        if (Math.abs(top - glide) < 2) done();
        return;
      }
      window.clearTimeout(settle);
      settle = window.setTimeout(snap, 90);
    };
    const start = (event: Event) => {
      const touch = (event as TouchEvent).touches?.[0];
      if (foreign(event)) return;
      touching = true;
      intent = Number.NEGATIVE_INFINITY;
      origin = touch ? { x: touch.clientX, y: touch.clientY } : null;
      interrupted = glide !== null;
      retries = 0;
      done();
    };
    const move = (event: Event) => {
      const touch = (event as TouchEvent).touches?.[0];
      if (!origin || !touch) return;
      const dx = Math.abs(touch.clientX - origin.x),
        dy = Math.abs(touch.clientY - origin.y);
      if (dy > 8 && dy > dx) {
        intent = performance.now();
        interrupted = false;
      }
    };
    const end = () => {
      touching = false;
      origin = null;
      if (interrupted) {
        interrupted = false;
        resettle();
        return;
      }
      window.clearTimeout(settle);
      settle = window.setTimeout(snap, 90);
    };
    // New input takes over from a glide in progress.
    const wheel = (event: Event) => {
      const { deltaX, deltaY } = event as WheelEvent;
      if (foreign(event) || Math.abs(deltaY) <= Math.abs(deltaX)) return;
      intent = performance.now();
      retries = 0;
      done();
    };
    const key = (event: Event) => {
      if (
        foreign(
          event,
          'input, textarea, select, button, [contenteditable="true"], dialog',
        ) ||
        !keys.includes((event as KeyboardEvent).key)
      )
        return;
      intent = performance.now();
      retries = 0;
      done();
    };
    target.addEventListener("scroll", scroll, { passive: true });
    target.addEventListener("touchstart", start, { passive: true });
    target.addEventListener("touchmove", move, { passive: true });
    target.addEventListener("touchend", end, { passive: true });
    target.addEventListener("touchcancel", end, { passive: true });
    target.addEventListener("wheel", wheel, { passive: true });
    target.addEventListener("keydown", key);
    return () => {
      window.clearTimeout(settle);
      window.clearTimeout(release);
      target.removeEventListener("scroll", scroll);
      target.removeEventListener("touchstart", start);
      target.removeEventListener("touchmove", move);
      target.removeEventListener("touchend", end);
      target.removeEventListener("touchcancel", end);
      target.removeEventListener("wheel", wheel);
      target.removeEventListener("keydown", key);
    };
  }, [embedded, shell.activeDestination, shell.platform]);
  useLayoutEffect(() => {
    if (embedded && shell.activeDestination !== "user") return;
    const header = profileHeader.current;
    const node = scrollElement();
    if (!header || !node) return;
    const measure = () => {
      const height = coverCollapse();
      const previous = collapseHeight.current;
      collapseHeight.current = height;
      markCover(node.scrollTop);
      // The card's tint is sampled again once the layout settles.
      window.clearTimeout(cardTimer.current);
      cardTimer.current = window.setTimeout(sampleCard, 150);
      if (previous <= 0 || Math.abs(height - previous) < 0.5) return;
      const top = positions.current[scrollTab] ?? node.scrollTop;
      // Loading a bio or changing viewport size must not reopen a collapsed
      // cover. Offsets inside each collection remain relative to its content.
      for (const tab of Object.keys(positions.current)) {
        const saved = positions.current[tab]!;
        if (saved >= previous - 1)
          positions.current[tab] = Math.max(height, saved + height - previous);
      }
      if (top >= previous - 1) {
        node.scrollTop = Math.max(height, top + height - previous);
        positions.current[scrollTab] = node.scrollTop;
        markCover(node.scrollTop);
        if (!embedded) onViewChange(scrollTab, node.scrollTop);
      }
      if (!isPreview)
        author.cache.set(`profile-scroll:${state.entryId}`, positions.current);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    // The cover's height lives partly in its padding (svh), so watch the
    // border box; the identity can also move inside an unchanged cover.
    observer?.observe(header, { box: "border-box" });
    if (identityPanel.current) observer?.observe(identityPanel.current);
    return () => observer?.disconnect();
  }, [
    embedded,
    isPreview,
    scrollTab,
    state.entryId,
    shell.activeDestination,
    shell.platform,
  ]);
  const panels = Object.fromEntries(
    tabs.map((tab) => [
      tab,
      <div className={styles.panelContent}>
        {isPreview ? (
          <div>
            <p>暂无可显示的内容</p>
          </div>
        ) : (
          <ProfileList
            key={`${viewerId ?? "guest"}:${id}:${tab}:${state.entryId}`}
            authorId={id}
            tab={tab}
            entryId={state.entryId}
            owner={owner}
            active={tab === viewTab}
          />
        )}
      </div>,
    ]),
  ) as Record<(typeof tabs)[number], ReactNode>;
  const name = profile?.displayName ?? (id ? "作者主页" : "访客");
  const coverTint = tint && tint.src === profile?.background?.src ? tint : null;
  const coverCardTint =
    card && card.src === profile?.background?.src ? card : null;
  const coverRatio =
    profile?.background?.width && profile.background.height
      ? profile.background.width / profile.background.height
      : null;
  // Over a photo the identity's text and the owner's pencil wear the dark
  // theme. The avatar does not: the avatar editor opens inside it, in the
  // reader's own theme.
  const coverTheme = profile?.background ? "dark" : undefined;
  return (
    <section
      ref={root}
      role={embedded || insideDialog ? "region" : "dialog"}
      aria-modal={embedded || insideDialog ? undefined : true}
      aria-label={embedded ? "用户主页" : "作者主页"}
      className={`${embedded ? styles.page : styles.overlay} ${styles.coverRoot}`}
      style={
        {
          ...(coverTint && {
            "--cover-tint": coverTint.color,
            "--cover-shade-photo": coverTint.shade,
          }),
          ...(coverCardTint && {
            "--cover-card-tint": coverCardTint.tint,
            "--cover-card-alpha": coverCardTint.alpha,
          }),
          ...(coverRatio && { "--cover-ratio": coverRatio }),
        } as CSSProperties
      }
      data-author-profile={id ?? "guest"}
    >
      <header ref={topBar} className={`${styles.header} ${styles.coverHeader}`}>
        {embedded && headerStart ? (
          headerStart
        ) : (
          <button
            type="button"
            ref={backButtonRef}
            aria-label="返回"
            className="yoyi-icon-button"
            onClick={onClose}
          >
            <Icon name="back" />
          </button>
        )}
        <span />
        {owner ? (
          <nav className={styles.profileActions} aria-label="主页管理">
            <button
              type="button"
              aria-label="设置"
              className="yoyi-icon-button"
              onClick={() => setModal("settings")}
            >
              <Icon name="settings" />
            </button>
          </nav>
        ) : (
          <span />
        )}
      </header>
      <section
        ref={profileHeader}
        className={`${styles.profile} ${styles.coverProfile}`}
        aria-label="用户资料"
        data-profile-background-slot=""
      >
        <div className={styles.profileCover} aria-label="主页背景">
          {profile?.background && (
            <img
              src={profile.background.src}
              alt=""
              onLoad={(event) => {
                const image = event.currentTarget;
                const src = image.getAttribute("src") ?? "";
                void decoded(image).then(() => {
                  // A newer photo may have replaced this one meanwhile.
                  if (image.getAttribute("src") !== src) return;
                  const colors = coverColors(image);
                  setTint(
                    colors
                      ? { src, color: colors.tint, shade: colors.shade }
                      : null,
                  );
                  sampleCard();
                });
              }}
            />
          )}
          {profile?.background && (
            <span
              aria-hidden="true"
              className={styles.coverGlass}
              style={{
                backgroundImage: `url(${JSON.stringify(profile.background.src)})`,
              }}
            />
          )}
          {profile?.background && (
            <span aria-hidden="true" className={styles.coverCard} />
          )}
        </div>
        {ownProfile && (
          <button
            type="button"
            data-theme={coverTheme}
            aria-label="编辑主页背景"
            className={styles.backgroundEdit}
            onClick={() => setModal("background")}
          >
            <Icon name="edit" />
          </button>
        )}
        <div
          ref={identityPanel}
          className={`${styles.profileIdentity} ${styles.coverIdentity}`}
        >
          <div ref={identityHead} className={styles.coverHead}>
            {ownProfile && profile ? (
              <AvatarEntry profile={profile} className={styles.avatar}>
                {profile.avatar ? (
                  <img src={profile.avatar.src} alt="" width={80} height={80} />
                ) : (
                  <span>{name.slice(0, 1)}</span>
                )}
              </AvatarEntry>
            ) : (
              <div
                className={styles.avatar}
                role="img"
                aria-label={`${name}的头像`}
              >
                {profile?.avatar ? (
                  <img src={profile.avatar.src} alt="" width={80} height={80} />
                ) : (
                  <span>{name.slice(0, 1)}</span>
                )}
              </div>
            )}
            <div
              className={`${styles.identity} ${styles.coverNames}`}
              data-theme={coverTheme}
            >
              <h1>{name}</h1>
              {profile && (
                <p className={styles.coverMeta}>
                  {profile.studioName && (
                    <StudioName value={profile.studioName} prominent />
                  )}
                  <span>@{profile.handle}</span>
                </p>
              )}
            </div>
          </div>
          {profile ? (
            <>
              {profile.bio && (
                <p className={styles.coverBio} data-theme={coverTheme}>
                  {profile.bio}
                </p>
              )}
              <div className={styles.coverBar} data-theme={coverTheme}>
                {!isPreview &&
                  (profile.totals.following !== null ||
                    profile.totals.followers !== null) && (
                    <div className={styles.coverCounts}>
                      {profile.totals.following !== null && (
                        <button
                          type="button"
                          className={styles.coverCount}
                          onClick={() => setPeople("following")}
                        >
                          关注{" "}
                          <strong className={styles.relationshipCount}>
                            {profile.totals.following}
                          </strong>
                        </button>
                      )}
                      {profile.totals.followers !== null && (
                        <button
                          type="button"
                          className={styles.coverCount}
                          onClick={() => setPeople("followers")}
                        >
                          粉丝{" "}
                          <strong className={styles.relationshipCount}>
                            {profile.totals.followers}
                          </strong>
                        </button>
                      )}
                    </div>
                  )}
                {preview ? (
                  preview.self ? null : (
                    <div className={styles.coverActions}>
                      <button
                        type="button"
                        aria-pressed={profile.following}
                        className={`${profile.following ? media.secondaryButton : `${media.primaryButton} ${styles.coverPrimary}`} ${styles.coverButton}`}
                        onClick={() =>
                          preview.onFollowChange(!profile.following)
                        }
                      >
                        {profile.following ? "取消关注" : "关注"}
                      </button>
                    </div>
                  )
                ) : !profile.isOwner && author.viewer ? (
                  <div className={styles.coverActions}>
                    <button
                      type="button"
                      aria-pressed={profile.following}
                      className={`${profile.following ? media.secondaryButton : `${media.primaryButton} ${styles.coverPrimary}`} ${styles.coverButton}`}
                      onClick={async () => {
                        try {
                          await authorClient.command("relationships/follow", {
                            requestId: requestIdentity(),
                            targetId: profile.id,
                            enabled: !profile.following,
                          });
                          save();
                          author.mutate();
                        } catch (e) {
                          author.notify(
                            e instanceof Error ? e.message : "关注未完成",
                          );
                        }
                      }}
                    >
                      {profile.following ? "取消关注" : "关注"}
                    </button>
                    {directEntry && (
                      <button
                        type="button"
                        className={`${media.secondaryButton} ${styles.coverButton}`}
                        data-profile-direct-message=""
                        aria-label={`给 ${profile.displayName} 发私信`}
                        onClick={() => {
                          // Opening never sends: the first submit in the
                          // message center creates the canonical pair.
                          directEntry.openWith(
                            profile.id,
                            profile.displayName,
                            profile.studioName,
                          );
                          onClose();
                        }}
                      >
                        私信
                      </button>
                    )}
                    <ProfileMoreMenu
                      name={profile.displayName}
                      onBlock={async () => {
                        if (
                          !window.confirm(
                            `屏蔽 ${profile.displayName}？双方的关注将移除。`,
                          )
                        )
                          return;
                        try {
                          await authorClient.command("relationships/block", {
                            requestId: requestIdentity(),
                            targetId: profile.id,
                            enabled: true,
                          });
                          author.mutate();
                          onClose();
                        } catch (e) {
                          author.notify(
                            e instanceof Error ? e.message : "屏蔽未完成",
                          );
                        }
                      }}
                    />
                  </div>
                ) : !profile.isOwner ? (
                  <div className={styles.coverActions}>
                    <a
                      href={author.signInHref}
                      className={`${media.primaryButton} ${styles.coverButton} ${styles.coverPrimary}`}
                    >
                      登录后关注
                    </a>
                  </div>
                ) : null}
              </div>
            </>
          ) : !id ? (
            <>
              <p className={styles.coverBio}>
                无需登录即可浏览与搜索。登录后可跨设备收藏、喜欢、关注。
              </p>
              <div className={styles.coverBar}>
                <div className={styles.coverActions}>
                  <a
                    href={author.signInHref}
                    className={`${media.primaryButton} ${styles.coverButton} ${styles.coverPrimary}`}
                  >
                    登录
                  </a>
                </div>
              </div>
            </>
          ) : null}
          {error && (
            <p role="alert" data-theme={coverTheme}>
              {error}
            </p>
          )}
        </div>
        {profile?.background && (
          <span
            key={chin === "cover" ? `cover:${coverTint?.shade ?? ""}` : chin}
            aria-hidden="true"
            className={styles.coverChin}
            data-chin={chin}
          />
        )}
        {profile?.background && (
          <button
            ref={scrollHint}
            type="button"
            className={styles.scrollHint}
            aria-label={`向下查看${labels[viewTab as (typeof tabs)[number]] ?? "内容"}`}
            onClick={() => {
              const node = scrollElement(),
                top = restStage();
              if (!node || top <= 0) return;
              node.scrollTo?.({
                top,
                behavior: window.matchMedia?.(
                  "(prefers-reduced-motion: reduce)",
                ).matches
                  ? "auto"
                  : "smooth",
              });
              // The hint leaves; focus goes on to the collection reached.
              root.current
                ?.querySelector<HTMLElement>(
                  '[role="tab"][aria-selected="true"]',
                )
                ?.focus({ preventScroll: true });
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M6 9.5l6 6 6-6" />
            </svg>
          </button>
        )}
      </section>
      <section className={styles.userContent} aria-label="用户内容">
        <div className={styles.tabs} role="tablist" aria-label="用户内容分类">
          {visibleTabs.map((tab) => (
            <button
              type="button"
              key={tab}
              role="tab"
              id={`${tabId}-${tab}`}
              aria-controls={`${tabId}-panel-${tab}`}
              aria-selected={viewTab === tab}
              tabIndex={viewTab === tab ? 0 : -1}
              onClick={() => pager.current?.scrollToKey(tab)}
              onKeyDown={(event) => {
                const index = visibleTabs.indexOf(tab);
                const next =
                  event.key === "ArrowRight"
                    ? visibleTabs[Math.min(index + 1, visibleTabs.length - 1)]
                    : event.key === "ArrowLeft"
                      ? visibleTabs[Math.max(0, index - 1)]
                      : undefined;
                if (next) {
                  event.preventDefault();
                  pager.current?.scrollToKey(next);
                  root.current
                    ?.querySelector<HTMLElement>(`[id="${tabId}-${next}"]`)
                    ?.focus({ preventScroll: true });
                }
              }}
            >
              {labels[tab]}
            </button>
          ))}
          <span
            aria-hidden
            className={styles.tabIndicator}
            style={{
              width: `${100 / visibleTabs.length}%`,
              transform: `translateX(${progress * 100}%)`,
            }}
          />
        </div>
        <HorizontalPager
          ref={pager}
          keys={visibleTabs}
          activeKey={viewTab as (typeof tabs)[number]}
          onCommit={changeTab}
          onBeforeCommit={() => {
            positions.current[viewTab] =
              scrollElement()?.scrollTop ?? positions.current[viewTab] ?? 0;
            departingTab.current = viewTab;
          }}
          onProgress={setProgress}
          panels={panels}
          platform={shell.platform}
          scrollOwner="document"
          visible={
            (!embedded || shell.activeDestination === "user") &&
            modal === null &&
            people === null
          }
          frameClassName={styles.pager}
          panelClassName={styles.panel}
          panelAttributes={(tab) => ({ "data-author-panel": tab })}
          panelId={(tab) => `${tabId}-panel-${tab}`}
          panelLabelledBy={(tab) => `${tabId}-${tab}`}
        />
      </section>
      {ownProfile && profile && modal === "edit" && (
        <ProfileEditor
          profile={profile}
          onClose={() => setModal("settings")}
          onSaved={save}
        />
      )}
      {ownProfile && profile && modal === "background" && (
        <ProfileBackgroundEditor
          profile={profile}
          header={profileHeader}
          onClose={() => setModal(null)}
          onSaved={save}
        />
      )}
      {!isPreview &&
        people &&
        profile &&
        (ownProfile || profile.privacy[people] === "public") && (
          <PeopleList
            key={`${author.viewer?.id ?? "guest"}:${profile.id}:${people}`}
            id={profile.id}
            list={people}
            owner={ownProfile}
            revision={author.revision}
            onClose={() => setPeople(null)}
          />
        )}
      {owner && modal === "settings" && (
        <ProfileSettings
          key={profile?.id ?? "guest"}
          profile={profile}
          onDeparture={() =>
            authReturn?.consumeView(
              `profile-settings:${state.entryId}`,
              authReturnView,
            )
          }
          onClose={() => {
            authReturn?.consumeView(
              `profile-settings:${state.entryId}`,
              authReturnView,
            );
            setModal(null);
          }}
          onSaved={save}
          onEdit={
            ownProfile
              ? () => {
                  authReturn?.consumeView(
                    `profile-settings:${state.entryId}`,
                    authReturnView,
                  );
                  setModal("edit");
                }
              : undefined
          }
        />
      )}
    </section>
  );
};
export const MyComments = ({
  entryId,
  onOpenContent,
}: {
  entryId: string;
  /**
   * A host that owns a modal (the message center) opens the target after it
   * has finished closing. Every target, Articles included, goes through it.
   */
  onOpenContent?:
    ((target: DiscussionTarget, opener: HTMLElement) => void) | undefined;
}) => {
  const author = useAuthors(),
    shell = useProductShell();
  const cacheKey = `own-comments:${author.viewer?.id}:${entryId}`;
  type Snapshot = { items: OwnComment[]; page: number; total: number };
  const [snapshot, setSnapshot] = useState<Snapshot>(
    () =>
      (author.cache.get(cacheKey) as Snapshot) ?? {
        items: [],
        page: 0,
        total: 0,
      },
  );
  const { items, page, total } = snapshot;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const lock = useRef(false),
    epoch = useRef(0),
    failed = useRef<number | null>(null),
    deletionLock = useRef(false);
  const saveSnapshot = (next: Snapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
    author.cache.set(cacheKey, next);
  };
  const load = async (n = 0) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const run = epoch.current;
    try {
      const last = n || Math.max(1, snapshotRef.current.page);
      const collected: OwnComment[] = [];
      let count = 0;
      for (let current = n || 1; current <= last; current++) {
        const result = await authorClient.comments(current);
        if (run !== epoch.current) return;
        collected.push(...result.items);
        count = result.total;
      }
      const merged =
        n > 1 ? [...snapshotRef.current.items, ...collected] : collected;
      saveSnapshot({
        items: [...new Map(merged.map((item) => [item.id, item])).values()],
        page: last,
        total: count,
      });
      failed.current = null;
    } catch (e) {
      if (run === epoch.current) {
        failed.current = n;
        setError(e instanceof Error ? e.message : "评论记录不可用");
      }
    } finally {
      if (run === epoch.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    void load();
    return () => {
      epoch.current++;
      lock.current = false;
    };
  }, [author.viewer?.id, author.revision]);
  return (
    <section>
      <h2>我的评论</h2>
      <p className="phase4-muted">
        仅自己可见。不可用的第三方内容不显示上下文。
      </p>
      <ul className="phase4-comment-list">
        {items.map((item) => (
          <li key={item.id}>
            <p>{item.text}</p>
            <small>{new Date(item.createdAt).toLocaleString()}</small>
            <div className="phase4-actions">
              {item.target ? (
                <button
                  type="button"
                  onClick={(event) => {
                    author.cache.set("discussion-location", {
                      target: item.target,
                      id: item.id,
                    });
                    const target = item.target!;
                    const opener = event.currentTarget;
                    if (onOpenContent) onOpenContent(target, opener);
                    else if (target.type === "article") {
                      // content-community-completion-v1: an Article discussion
                      // opens through the editorial reader, a topic overlay of
                      // the discussion destination (openTopic refuses from
                      // any other destination).
                      shell.navigatePrimary("discussion");
                      requestAnimationFrame(() =>
                        shell.openTopic(target.id, opener, 0),
                      );
                    } else shell.openContent(target, opener);
                  }}
                >
                  前往评论位置
                </button>
              ) : (
                <span>目标内容或讨论已不可用</span>
              )}
              {!item.deleted && (
                <button
                  type="button"
                  onClick={async () => {
                    if (
                      !window.confirm("删除这条评论正文？其他人的回复会保留。")
                    )
                      return;
                    if (deletionLock.current) return;
                    deletionLock.current = true;
                    const run = epoch.current;
                    try {
                      await authorClient.command(
                        `discussion/items/${item.id}/body`,
                        { requestId: requestIdentity() },
                        "DELETE",
                      );
                      if (run !== epoch.current) return;
                      saveSnapshot({
                        ...snapshotRef.current,
                        items: snapshotRef.current.items.map((current) =>
                          current.id === item.id
                            ? {
                                ...current,
                                text: "该正文已删除",
                                deleted: true,
                              }
                            : current,
                        ),
                      });
                      await load();
                      author.mutate();
                    } catch (e) {
                      if (run === epoch.current)
                        setError(e instanceof Error ? e.message : "删除失败");
                    } finally {
                      deletionLock.current = false;
                    }
                  }}
                >
                  删除正文
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {items.length < total && (
        <button
          className="phase4-button"
          disabled={busy}
          onClick={() => void load(page + 1)}
        >
          加载更多
        </button>
      )}
      {busy && <p role="status">读取中…</p>}
      {error && (
        <p role="alert">
          {error}
          <button
            type="button"
            disabled={busy}
            onClick={() => void load(failed.current ?? 0)}
          >
            重试读取
          </button>
        </p>
      )}
    </section>
  );
};

export const AuthorProfileOverlay = (
  props: ProductShellProfileOverlayRenderProps & AuthorProfilePresentationProps,
) => {
  const author = useAuthors();
  const preview = props.preview;
  return (
    <ScopedAuthorProfile
      key={`${preview ? "preview" : (author.viewer?.id ?? "guest")}:${props.state.entryId}`}
      {...props}
      preview={preview}
    />
  );
};

/** An in-flow primary destination; the shell owns its vertical scroll and Back. */
export const AuthorProfilePage = ({
  onBack,
  headerStart,
  entryId = "primary-user",
}: {
  onBack: () => void;
  headerStart?: ReactNode;
  entryId?: string;
}) => {
  const author = useAuthors();
  return (
    <ScopedAuthorProfilePage
      key={`${author.viewer?.id ?? "guest"}:${entryId}`}
      onBack={onBack}
      headerStart={headerStart}
      entryId={entryId}
    />
  );
};
const ScopedAuthorProfilePage = ({
  onBack,
  headerStart,
  entryId,
}: {
  onBack: () => void;
  headerStart?: ReactNode;
  entryId: string;
}) => {
  const author = useAuthors();
  const cacheKey = `primary-profile-tab:${author.viewer?.id ?? "guest"}:${entryId}`;
  const selectedTab = useRef<(typeof tabs)[number]>("works");
  const authReturnView = useAuthReturnView(
    `primary-profile:${entryId}`,
    () => ({ tab: selectedTab.current }),
  );
  const [tab, setTab] = useState<(typeof tabs)[number]>(() => {
    const saved = authReturnView?.tab ?? author.cache.get(cacheKey);
    return tabs.includes(saved as (typeof tabs)[number])
      ? (saved as (typeof tabs)[number])
      : "works";
  });
  selectedTab.current = tab;
  const backButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <ScopedAuthorProfile
      embedded
      headerStart={headerStart}
      state={{
        kind: "profile",
        version: 2,
        authorId: author.viewer?.id ?? null,
        entryId,
        tab,
        profileScrollTop: 0,
        sourceDestination: "home",
        sourceScrollTop: 0,
      }}
      backButtonRef={backButtonRef}
      onClose={onBack}
      onViewChange={(next) => {
        const selected = next === "comments" ? "works" : next;
        author.cache.set(cacheKey, selected);
        setTab(selected);
      }}
    />
  );
};
