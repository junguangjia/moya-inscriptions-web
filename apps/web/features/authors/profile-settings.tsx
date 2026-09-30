"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { AuthorProfile } from "@moya/contracts";
import { useAuthReturn, useAuthReturnView } from "../auth/auth-return";
import { AuthorDialog } from "./author-dialog";
import type { AuthorDialogNavigationHandle } from "./author-dialog";
import { authorClient } from "./author-data";
import { useAuthors } from "./author-context";
import { requestIdentity } from "../shell/request-identity";
import { useProductShell } from "../product-shell/product-shell";
import { AccountSecurity } from "../auth/account-security";
import type { AccountSecurityHandle } from "../auth/account-security";
import { useSettingsSwipe } from "../settings/use-settings-swipe";
import styles from "../settings/settings-view.module.css";
import { SettingsIcon } from "../settings/settings-icons";
import type { SettingsIconName } from "../settings/settings-icons";

type Page = "root" | "display" | "privacy" | "blocks" | "security" | "factor";
const titles: Record<Page, string> = {
  root: "设置",
  display: "外观",
  privacy: "列表隐私",
  blocks: "已屏蔽账户",
  security: "账号与安全",
  factor: "验证登录方式",
};
const themeLabels = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
} as const;
const privacyLabels = {
  following: "关注列表",
  followers: "粉丝列表",
  favorites: "收藏列表",
  likes: "喜欢列表",
} as const;
const pageIcons = {
  display: "palette",
  privacy: "lock-keyhole",
  blocks: "ban",
  security: "shield-check",
} as const;
const privacyIcons = {
  following: "user-round-plus",
  followers: "users-round",
  favorites: "bookmark",
  likes: "heart",
} as const;
const defaults: AuthorProfile["privacy"] = {
  following: "private",
  followers: "private",
  favorites: "private",
  likes: "private",
};
const ChoiceGroup = <Value extends string>({
  label,
  kind,
  options,
  value,
  onChange,
}: {
  label: string;
  kind: "theme" | "layout";
  options: readonly { value: Value; label: string; icon?: SettingsIconName }[];
  value: Value;
  onChange: (value: Value) => void;
}) => (
  <fieldset className={styles.group}>
    <legend>{label}</legend>
    <div
      className={styles.choices}
      data-choice-kind={kind}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          className={styles.choice}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            if (
              ![
                "ArrowRight",
                "ArrowDown",
                "ArrowLeft",
                "ArrowUp",
                "Home",
                "End",
              ].includes(event.key)
            )
              return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? options.length - 1
                  : (index +
                      (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) +
                      options.length) %
                    options.length;
            onChange(options[next]!.value);
            const buttons =
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                "button",
              );
            buttons?.[next]?.focus();
          }}
        >
          <span
            className={styles.preview}
            data-theme-preview={kind === "theme" ? option.value : undefined}
            data-layout-preview={kind === "layout" ? option.value : undefined}
            aria-hidden="true"
          >
            {kind === "theme" ? (
              <>
                <span className={styles.previewWindow}>
                  <span className={styles.previewBar} />
                  <span className={styles.previewTiles}>
                    <i />
                    <i />
                    <i />
                  </span>
                </span>
                {option.icon && <SettingsIcon name={option.icon} />}
              </>
            ) : (
              <span className={styles.previewFeed}>
                <i />
                <i />
                <i />
                <i />
              </span>
            )}
          </span>
          <span>{option.label}</span>
          <span className={styles.checkmark} aria-hidden="true">
            {value === option.value && <SettingsIcon name="check" />}
          </span>
        </button>
      ))}
    </div>
  </fieldset>
);

const motionTiming = (element: HTMLElement | null) => {
  const tokens = element ? window.getComputedStyle(element) : null;
  const value = tokens?.getPropertyValue("--yoyi-duration-normal").trim() ?? "";
  const duration = Number.parseFloat(value) * (value.endsWith("ms") ? 1 : 1000);
  return {
    duration: Number.isFinite(duration) ? Math.max(0, duration) : 0,
    easing: tokens?.getPropertyValue("--yoyi-easing-standard").trim() ?? "",
  };
};
const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export const ProfileSettings = ({
  profile,
  onClose,
  onSaved,
  onEdit,
}: {
  profile: AuthorProfile | null;
  onClose: () => void;
  onSaved: () => void;
  onEdit?: (() => void) | undefined;
}) => {
  const author = useAuthors(),
    shell = useProductShell();
  const ownProfile = !!profile?.isOwner && profile.id === author.viewer?.id;
  const owner = ownProfile ? profile.id : null;
  const mounted = useRef(true);
  const mutationRun = useRef(0);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const pageRef = useRef<Page>("root");
  const authReturn = useAuthReturn();
  const authReturnView = useAuthReturnView<{
    page: Page;
    positions: Partial<Record<Page, number>>;
  }>(
    "profile-settings-page",
    (): {
      page: Page;
      positions: Partial<Record<Page, number>>;
    } => {
      // Navigation is public presentation state. Account data and factor proofs
      // stay in their existing account-scoped components and are reloaded.
      const current =
        pageRef.current === "factor" ? "security" : pageRef.current;
      return {
        page: current,
        positions: {
          ...scrollPositions.current,
          [current]: scroller.current?.scrollTop ?? 0,
        },
      };
    },
  );
  const restoredPage: Page =
    authReturnView && Object.hasOwn(titles, authReturnView.page)
      ? authReturnView.page === "factor"
        ? "security"
        : authReturnView.page
      : "root";
  const [page, setPage] = useState<Page>(restoredPage),
    [direction, setDirection] = useState<"forward" | "back" | "none">("none");
  pageRef.current = page;
  const [privacy, setPrivacy] = useState(profile?.privacy ?? defaults),
    [saved, setSaved] = useState(profile?.privacy ?? defaults);
  const [blocks, setBlocks] = useState<Awaited<
    ReturnType<typeof authorClient.people>
  > | null>(null);
  const [blocksLoading, setBlocksLoading] = useState(false),
    [blocksError, setBlocksError] = useState("");
  const blocksRun = useRef(0),
    blocksPending = useRef(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false),
    busyRef = useRef(false);
  const [securityBusy, setSecurityBusy] = useState(false),
    securityBusyRef = useRef(false);
  const [factorTitle, setFactorTitle] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  const [editRequested, setEditRequested] = useState(false),
    [closing, setClosing] = useState(false);
  const closingRef = useRef(false),
    closeTimer = useRef<number | null>(null);
  const navigation = useRef<AuthorDialogNavigationHandle>(null),
    security = useRef<AccountSecurityHandle>(null);
  const viewport = useRef<HTMLDivElement>(null),
    scroller = useRef<HTMLDivElement>(null),
    title = useRef<HTMLSpanElement>(null);
  const scrollPositions = useRef<Partial<Record<Page, number>>>(
    Object.fromEntries(
      Object.entries(authReturnView?.positions ?? {}).filter(
        ([key, value]) =>
          Object.hasOwn(titles, key) &&
          typeof value === "number" &&
          Number.isFinite(value) &&
          value >= 0,
      ),
    ),
  );
  const endedScrollRestores = useRef(new Set<Page>());
  const openers = useRef<Partial<Record<Page, HTMLElement>>>({});
  const pendingFocus = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const pageAnimation = useRef<Animation | null>(null);
  const initialOpener = useRef<HTMLElement | null>(
    typeof document !== "undefined" &&
      document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const latest = useRef({ onClose, onEdit, editRequested, signedOut });
  latest.current = { onClose, onEdit, editRequested, signedOut };
  const dirty = JSON.stringify(saved) !== JSON.stringify(privacy);
  const blocked = busy || securityBusy || closing;
  const remember = () => {
    if (scroller.current)
      scrollPositions.current[pageRef.current] = scroller.current.scrollTop;
  };
  const show = useCallback((next: Page, back = false) => {
    if (next === pageRef.current) return;
    remember();
    if (!back && document.activeElement instanceof HTMLElement)
      openers.current[next] = document.activeElement;
    pendingFocus.current = back
      ? (openers.current[pageRef.current] ?? null)
      : null;
    pageRef.current = next;
    setDirection(back ? "back" : "forward");
    setPage(next);
  }, []);
  const handleSecurityBusy = useCallback(
    (value: boolean) => {
      if (ownerRef.current !== owner) return;
      securityBusyRef.current = value;
      setSecurityBusy(value);
    },
    [owner],
  );
  const handleFlow = useCallback(
    (value: string | null) => {
      if (ownerRef.current !== owner) return;
      if (value) {
        setFactorTitle(value);
        show("factor");
      } else if (pageRef.current === "factor") show("security", true);
    },
    [owner, show],
  );
  const loadBlocks = async (nextPage = 1) => {
    if (!owner || blocksPending.current) return;
    const account = owner,
      run = ++blocksRun.current;
    blocksPending.current = true;
    setBlocksLoading(true);
    setBlocksError("");
    try {
      const result = await authorClient.people(account, "blocks", nextPage);
      if (ownerRef.current !== account || run !== blocksRun.current) return;
      setBlocks((old) =>
        nextPage === 1
          ? result
          : {
              ...result,
              items: [
                ...(old?.items ?? []),
                ...result.items.filter(
                  (person) => !old?.items.some((item) => item.id === person.id),
                ),
              ],
            },
      );
    } catch (reason) {
      if (ownerRef.current === account && run === blocksRun.current)
        setBlocksError(
          reason instanceof Error ? reason.message : "屏蔽列表暂时无法读取。",
        );
    } finally {
      if (run === blocksRun.current) {
        blocksPending.current = false;
        setBlocksLoading(false);
      }
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      blocksRun.current++;
    };
  }, []);
  useEffect(() => {
    blocksRun.current++;
    mutationRun.current++;
    blocksPending.current = false;
    setBlocksLoading(false);
    setBlocks(null);
    setBlocksError("");
    setPrivacy(profile?.privacy ?? defaults);
    setSaved(profile?.privacy ?? defaults);
    setError("");
    setNotice("");
    busyRef.current = false;
    setBusy(false);
    securityBusyRef.current = false;
    setSecurityBusy(false);
    // /me may re-key this component after the checking/guest first mount.
    // Preserve the controlled source's public page; private state above resets.
    if (!authReturn?.isRestoring()) show("root", true);
  }, [owner]);
  useEffect(() => {
    if (
      pageRef.current === "blocks" &&
      owner &&
      blocks === null &&
      !blocksError
    )
      void loadBlocks();
  }, [page, owner]);
  useLayoutEffect(() => {
    const dialog = viewport.current?.closest("dialog");
    dialog?.setAttribute("data-settings-platform", shell.platform);
    dialog?.setAttribute("data-settings-closing", String(closing));
  }, [shell.platform, closing]);
  useLayoutEffect(() => {
    if (scroller.current)
      scroller.current.scrollTop = scrollPositions.current[page] ?? 0;
    const target = pendingFocus.current;
    pendingFocus.current = null;
    const restored = target?.isConnected
      ? target
      : target?.dataset.settingsFocusKey
        ? viewport.current?.querySelector<HTMLElement>(
            `[data-settings-focus-key="${target.dataset.settingsFocusKey}"]`,
          )
        : null;
    if (restored && !restored.closest("[inert]"))
      restored.focus({ preventScroll: true });
    else if (page !== "root") title.current?.focus({ preventScroll: true });
    pageAnimation.current?.cancel();
    const timing = motionTiming(content.current);
    if (
      direction !== "none" &&
      !reducedMotion() &&
      timing.duration > 0 &&
      timing.easing
    )
      pageAnimation.current =
        content.current?.animate?.(
          [
            {
              opacity: 0,
              transform: `translateX(${direction === "back" ? -20 : 20}px)`,
            },
            { opacity: 1, transform: "translateX(0)" },
          ],
          timing,
        ) ?? null;
  }, [page]);
  useLayoutEffect(() => {
    const target = authReturnView?.positions?.[page];
    const element = scroller.current;
    const body = content.current;
    if (
      !authReturn?.isRestoring() ||
      !element ||
      !body ||
      typeof target !== "number" ||
      !Number.isFinite(target) ||
      target <= 0 ||
      endedScrollRestores.current.has(page)
    )
      return;
    // A checking/guest or loading page may initially clamp the saved position.
    // Retry as this returned view grows; yield immediately to user interaction.
    let stopped = false;
    let resize: ResizeObserver | undefined;
    const mutation = new MutationObserver(() => restore());
    const stop = () => {
      stopped = true;
      resize?.disconnect();
      mutation.disconnect();
    };
    const end = () => {
      endedScrollRestores.current.add(page);
      stop();
    };
    const restore = () => {
      if (stopped) return;
      if (pageRef.current !== page || !authReturn.isRestoring()) {
        end();
        return;
      }
      element.scrollTop = target;
      if (Math.abs(element.scrollTop - target) < 1) end();
    };
    const key = (event: KeyboardEvent) => {
      if (
        [
          "ArrowUp",
          "ArrowDown",
          "PageUp",
          "PageDown",
          "Home",
          "End",
          " ",
        ].includes(event.key)
      )
        end();
    };
    element.addEventListener("wheel", end, { passive: true });
    element.addEventListener("touchstart", end, { passive: true });
    element.addEventListener("pointerdown", end, { passive: true });
    element.addEventListener("keydown", key);
    mutation.observe(body, { childList: true, subtree: true });
    if (typeof ResizeObserver !== "undefined") {
      resize = new ResizeObserver(restore);
      resize.observe(body);
    }
    restore();
    return () => {
      // Same-page cleanup may be StrictMode replay of an unfinished attempt.
      // Only a real page departure ends it; a later mount owns its own Set.
      if (pageRef.current !== page) endedScrollRestores.current.add(page);
      stop();
      element.removeEventListener("wheel", end);
      element.removeEventListener("touchstart", end);
      element.removeEventListener("pointerdown", end);
      element.removeEventListener("keydown", key);
    };
  }, [page, authReturn, authReturnView]);
  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      pageAnimation.current?.cancel();
      initialOpener.current?.focus({ preventScroll: true });
    };
  }, []);
  const finishClose = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    const finish = () => {
      if (latest.current.signedOut) {
        viewport.current?.closest<HTMLDialogElement>("dialog")?.close();
        latest.current.onClose();
        window.location.assign("/");
      } else if (
        latest.current.editRequested &&
        ownerRef.current &&
        latest.current.onEdit
      )
        latest.current.onEdit();
      else latest.current.onClose();
    };
    if (reducedMotion()) finish();
    else
      closeTimer.current = window.setTimeout(
        finish,
        motionTiming(viewport.current).duration,
      );
  };
  const canBack = () =>
    !busyRef.current && !securityBusyRef.current && !closingRef.current;
  const back = () => {
    if (canBack()) navigation.current?.back();
  };
  const swipe = useSettingsSwipe({
    frame: viewport,
    page,
    enabled: shell.platform !== "pc" && !blocked,
    canBack,
    onBack: back,
  });
  const setMutationBusy = (value: boolean) => {
    busyRef.current = value;
    setBusy(value);
  };
  const savePrivacy = async () => {
    if (busyRef.current || !owner || !dirty) return;
    const account = owner,
      run = ++mutationRun.current,
      submitted = { ...privacy };
    const valid = () =>
      mounted.current &&
      ownerRef.current === account &&
      run === mutationRun.current;
    setMutationBusy(true);
    setError("");
    setNotice("");
    try {
      await authorClient.command("me/privacy", {
        requestId: requestIdentity(),
        privacy: submitted,
      });
      if (!valid()) return;
      setSaved(submitted);
      onSaved();
      author.mutate();
      setNotice("隐私设置已保存");
    } catch (reason) {
      if (valid())
        setError(
          reason instanceof Error ? reason.message : "保存失败，请重试。",
        );
    } finally {
      if (valid()) setMutationBusy(false);
    }
  };
  const unblock = async (targetId: string) => {
    if (busyRef.current || blocksPending.current || !owner) return;
    const account = owner,
      run = ++mutationRun.current;
    const valid = () =>
      mounted.current &&
      ownerRef.current === account &&
      run === mutationRun.current;
    setMutationBusy(true);
    setBlocksError("");
    try {
      await authorClient.command("relationships/block", {
        requestId: requestIdentity(),
        targetId,
        enabled: false,
      });
      if (!valid()) return;
      setBlocks((old) =>
        old
          ? {
              ...old,
              items: old.items.filter((item) => item.id !== targetId),
              total: Math.max(0, old.total - 1),
            }
          : null,
      );
      author.mutate();
      await loadBlocks();
    } catch (reason) {
      if (valid())
        setBlocksError(
          reason instanceof Error ? reason.message : "解除失败，请重试。",
        );
    } finally {
      if (valid()) setMutationBusy(false);
    }
  };
  const row = (
    label: string,
    destination: keyof typeof pageIcons,
    summary?: string,
  ) => (
    <button
      type="button"
      data-settings-focus-key={destination}
      className={styles.row}
      disabled={blocked}
      onClick={() => show(destination)}
    >
      <span className={styles.rowIcon}>
        <SettingsIcon name={pageIcons[destination]} />
      </span>
      <span className={styles.rowText}>
        <span>{label}</span>
        {summary && <small>{summary}</small>}
      </span>
      <SettingsIcon className={styles.chevron} name="chevron-right" />
    </button>
  );
  const guest = (
    <div className={styles.rows}>
      <a className={styles.row} href={author.signInHref}>
        <span className={styles.rowIcon}>
          <SettingsIcon name="shield-check" />
        </span>
        <span className={styles.rowText}>登录后管理账户设置</span>
        <SettingsIcon className={styles.chevron} name="chevron-right" />
      </a>
    </div>
  );
  return (
    <AuthorDialog
      backIcon={<SettingsIcon name="arrow-left" />}
      title={page === "factor" ? factorTitle : titles[page]}
      titleContent={
        <span ref={title} className={styles.title} tabIndex={-1}>
          {page === "factor" ? factorTitle : titles[page]}
        </span>
      }
      className={styles.dialog}
      dirty={!editRequested && !signedOut && dirty}
      guardChildBack={false}
      dismissible={!blocked}
      closeRequested={editRequested || signedOut}
      navigationDepth={page === "root" ? 0 : page === "factor" ? 2 : 1}
      navigationRef={navigation}
      onBack={(depth) => {
        if (depth < 2 && pageRef.current === "factor")
          security.current?.cancelFlow();
        show(depth === 0 ? "root" : "security", true);
      }}
      onClose={finishClose}
    >
      <div
        ref={viewport}
        className={styles.viewport}
        data-settings-direction={direction}
        data-settings-page={page}
        inert={closing}
        {...swipe}
      >
        <div ref={scroller} className={styles.page}>
          <div ref={content} className={styles.content}>
            {page === "root" && (
              <>
                <section className={styles.group}>
                  <h3>偏好</h3>
                  <div className={styles.rows}>
                    {row(
                      "外观",
                      "display",
                      `${themeLabels[shell.theme]}${shell.platform === "pc" ? "" : ` · ${shell.feedLayout === "single" ? "单列" : "双列"}`}`,
                    )}
                  </div>
                </section>
                {ownProfile ? (
                  <>
                    <section className={styles.group}>
                      <h3>隐私</h3>
                      <div className={styles.rows}>
                        {row(
                          "列表隐私",
                          "privacy",
                          dirty ? "有未保存的更改" : undefined,
                        )}
                        {row("已屏蔽账户", "blocks")}
                      </div>
                    </section>
                    <section className={styles.group}>
                      <h3>账户</h3>
                      <div className={styles.rows}>
                        {row("账号与安全", "security")}
                        {onEdit && (
                          <button
                            type="button"
                            className={styles.row}
                            disabled={blocked || editRequested}
                            onClick={() => {
                              if (
                                dirty &&
                                !window.confirm("更改尚未保存，放弃这些更改？")
                              )
                                return;
                              setEditRequested(true);
                            }}
                          >
                            <span className={styles.rowIcon}>
                              <SettingsIcon name="user-round-pen" />
                            </span>
                            <span className={styles.rowText}>编辑信息</span>
                            <SettingsIcon
                              className={styles.chevron}
                              name="chevron-right"
                            />
                          </button>
                        )}
                      </div>
                    </section>
                  </>
                ) : (
                  <section className={styles.group}>
                    <h3>账户</h3>
                    {guest}
                  </section>
                )}
              </>
            )}
            {page === "display" && (
              <>
                <ChoiceGroup
                  label="主题"
                  kind="theme"
                  value={shell.theme}
                  onChange={shell.setThemePreference}
                  options={(["system", "light", "dark"] as const).map(
                    (value) => ({
                      value,
                      label: themeLabels[value],
                      icon: (
                        {
                          system: "monitor",
                          light: "sun",
                          dark: "moon",
                        } as const
                      )[value],
                    }),
                  )}
                />
                {shell.platform !== "pc" && (
                  <ChoiceGroup
                    label="首页布局"
                    kind="layout"
                    value={shell.feedLayout}
                    onChange={shell.setFeedLayoutPreference}
                    options={(["single", "double"] as const).map((value) => ({
                      value,
                      label: value === "single" ? "单列" : "双列",
                    }))}
                  />
                )}
                <p className={styles.help}>立即生效，保存在当前浏览器。</p>
              </>
            )}
            {page === "privacy" &&
              (ownProfile ? (
                <>
                  <div className={styles.rows}>
                    {(
                      Object.keys(
                        privacyLabels,
                      ) as (keyof typeof privacyLabels)[]
                    ).map((key) => (
                      <label className={styles.row} key={key}>
                        <span className={styles.rowLabel}>
                          <SettingsIcon name={privacyIcons[key]} />
                          <span>{privacyLabels[key]}</span>
                        </span>
                        <select
                          value={privacy[key]}
                          disabled={busy}
                          onChange={(event) => {
                            setNotice("");
                            setPrivacy((old) => ({
                              ...old,
                              [key]: event.target.value as "public" | "private",
                            }));
                          }}
                        >
                          <option value="public">公开</option>
                          <option value="private">仅自己可见</option>
                        </select>
                      </label>
                    ))}
                  </div>
                  <p className={styles.help}>
                    只隐藏自己的列表，另一方的公开列表仍可能显示关系。浏览历史、我的评论与草稿始终私密。
                  </p>
                  {error && (
                    <p className={styles.error} role="alert">
                      {error}
                    </p>
                  )}
                  <button
                    type="button"
                    className={`${styles.action} ${styles.primary}`}
                    disabled={busy || !dirty}
                    onClick={() => void savePrivacy()}
                  >
                    {busy ? "正在保存" : "保存隐私设置"}
                  </button>
                  <p className={styles.status} role="status">
                    {notice || (dirty ? "更改尚未保存" : "")}
                  </p>
                </>
              ) : (
                guest
              ))}
            {page === "blocks" &&
              (ownProfile ? (
                <>
                  <p className={styles.help}>
                    解除后不恢复关注；屏蔽不限制匿名访问公开内容。
                  </p>
                  {blocks && (
                    <div className={styles.rows}>
                      {blocks.items.map((person) => (
                        <div className={styles.row} key={person.id}>
                          <span className={styles.rowText}>
                            <span>{person.displayName}</span>
                            <small>@{person.handle}</small>
                          </span>
                          <button
                            type="button"
                            className={styles.action}
                            disabled={busy || blocksLoading}
                            onClick={() => void unblock(person.id)}
                          >
                            解除屏蔽
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {blocks?.total === 0 && !blocksLoading && (
                    <p className={styles.status}>暂无已屏蔽账户</p>
                  )}
                  {blocksLoading && (
                    <p className={styles.status} role="status">
                      正在读取屏蔽列表…
                    </p>
                  )}
                  {blocksError && (
                    <div>
                      <p className={styles.error} role="alert">
                        {blocksError}
                      </p>
                      <button
                        type="button"
                        className={styles.action}
                        disabled={blocksLoading || busy}
                        onClick={() => void loadBlocks()}
                      >
                        重试
                      </button>
                    </div>
                  )}
                  {blocks &&
                    !blocksError &&
                    blocks.items.length < blocks.total && (
                      <div className={styles.footer}>
                        <button
                          type="button"
                          className={styles.action}
                          disabled={busy || blocksLoading}
                          onClick={() => void loadBlocks(blocks.page + 1)}
                        >
                          加载更多
                        </button>
                      </div>
                    )}
                </>
              ) : (
                guest
              ))}
            {(page === "security" || page === "factor") &&
              (ownProfile ? (
                <AccountSecurity
                  expectedViewerId={owner!}
                  guardSignOut={() =>
                    !dirty ||
                    window.confirm("更改尚未保存，放弃这些更改并退出登录？")
                  }
                  onSignedOut={() => setSignedOut(true)}
                  onBusyChange={handleSecurityBusy}
                  onFlowChange={handleFlow}
                  navigationRef={security}
                />
              ) : (
                guest
              ))}
          </div>
        </div>
      </div>
    </AuthorDialog>
  );
};
