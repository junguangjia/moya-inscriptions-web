"use client";
import { MyReportingCases } from "../reporting/reporting-cases";
import { UserIdentity } from "./user-identity";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import type { AuthorProfile } from "@moya/contracts";
import { useAuthReturn, useAuthReturnView } from "../auth/auth-return";
import { AuthorDialog } from "./author-dialog";
import type { AuthorDialogNavigationHandle } from "./author-dialog";
import { authorClient, AuthorRequestError } from "./author-data";
import { useAuthors } from "./author-context";
import { requestIdentity } from "../shell/request-identity";
import { useProductShell } from "../product-shell/product-shell";
import { ArticleAgentConnections } from "../editorial-content/article-authoring/article-delegation";
import { useArticleAvailability } from "../editorial-content/article-authoring/article-availability";
import { AccountSecurity } from "../auth/account-security";
import type { AccountSecurityHandle } from "../auth/account-security";
import { AccountSwitcher } from "./account-switcher";
import {
  AccountDeletion,
  AccountDeletionEntry,
} from "../auth/account-deletion";
import type { AccountDeletionHandle } from "../auth/account-deletion";
import { useGlobalUploadProgress } from "../publishing/publishing-provider";
import { useEndAccountEditing } from "../publishing/ui/editor/editor-session-provider";
import { forgetDeletedAccount } from "./account-local-data";
import {
  SettingsFeedbackForm,
  useSettingsFeedback,
} from "../settings/feedback-form";
import { useSettingsSwipe } from "../settings/use-settings-swipe";
import styles from "../settings/settings-view.module.css";
import { SettingsIcon } from "../settings/settings-icons";
import { FeedLayoutPreview } from "../settings/feed-layout-preview";
import { feedLayoutLabels } from "../product-shell/preferences";
import type { SettingsIconName } from "../settings/settings-icons";

type Page =
  | "root"
  | "display"
  | "privacy"
  | "blocks"
  | "security"
  | "factor"
  | "accounts"
  | "reports"
  | "feedback"
  | "edit"
  | "deletion";
const titles: Record<Page, string> = {
  root: "设置",
  display: "外观",
  privacy: "列表隐私",
  blocks: "已屏蔽账户",
  security: "账号与安全",
  factor: "验证登录方式",
  accounts: "切换账号",
  reports: "我的举报与申诉",
  feedback: "反馈与建议",
  edit: "编辑信息",
  deletion: "注销账号",
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
  accounts: "users-round",
  reports: "shield-check",
  feedback: "mail",
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
  platform,
}: {
  label: string;
  kind: "theme" | "layout";
  options: readonly { value: Value; label: string; icon?: SettingsIconName }[];
  value: Value;
  onChange: (value: Value) => void;
  platform?: "phone" | "tablet" | "pc";
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
          {kind === "theme" && (
            <span
              className={styles.preview}
              data-theme-preview={option.value}
              aria-hidden="true"
            >
              <span className={styles.previewWindow}>
                <span className={styles.previewBar} />
                <span className={styles.previewTiles}>
                  <i />
                  <i />
                  <i />
                </span>
              </span>
              {option.icon && <SettingsIcon name={option.icon} />}
            </span>
          )}
          <span>{option.label}</span>
          <span className={styles.checkmark} aria-hidden="true">
            {value === option.value && <SettingsIcon name="check" />}
          </span>
        </button>
      ))}
    </div>
    {kind === "layout" && (value === "single" || value === "double") && (
      <FeedLayoutPreview
        platform={platform}
        value={value === "single" ? "single" : "double"}
      />
    )}
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
/** Child pages whose private state is never restored after an auth journey. */
const restorablePage = (value: Page): Page =>
  value === "factor" || value === "deletion" ? "security" : value;

/**
 * account-deletion-v1: mounted only on its own page, inside the product's
 * PublishingProvider, so the composer's unfinished work and a pending avatar
 * save are known before the account is ended. While the deletion's outcome is
 * pending or shown, Session rechecks wait, so neither this page nor the Session
 * a same-key retry presents is torn down by a revoked-Session answer. While
 * an attempt is unconfirmed, the dialog asks the page before Back leaves it.
 */
const DeletionPage = ({
  owner,
  settingsDirty,
  navigationRef,
  onBusyChange,
  onCancel,
  onFinished,
}: {
  owner: string;
  settingsDirty: boolean;
  navigationRef: RefObject<AccountDeletionHandle | null>;
  onBusyChange: (busy: boolean) => void;
  onCancel: () => void;
  onFinished: () => void;
}) => {
  const progress = useGlobalUploadProgress();
  const { avatarSave, holdSession } = useAuthors();
  const endEditing = useEndAccountEditing();
  const release = useRef<(() => void) | null>(null);
  const holdWhilePending = useCallback(
    (pending: boolean) => {
      if (pending) release.current ??= holdSession();
      else {
        release.current?.();
        release.current = null;
      }
    },
    [holdSession],
  );
  useEffect(
    () => () => {
      release.current?.();
      release.current = null;
    },
    [],
  );
  const forget = useCallback(
    async (accountId: string) => {
      // Nothing of the ended account may write its local data again in this
      // tab (a live composer, its uploads or autosave), then the data goes.
      endEditing(accountId);
      await forgetDeletedAccount(accountId);
    },
    [endEditing],
  );
  const unfinished = [
    ...(progress.active || progress.backgroundPublication === true
      ? ["作品图片仍在上传、处理或发布中。"]
      : []),
    ...(progress.hasUnsavedChanges ? ["正在编辑的作品还有未保存的更改。"] : []),
    ...(avatarSave?.accountId === owner && !avatarSave.failed
      ? ["新头像还没有保存完成。"]
      : []),
    ...(settingsDirty ? ["设置里还有未保存的更改或未发送的反馈。"] : []),
  ];
  return (
    <AccountDeletion
      expectedViewerId={owner}
      unfinishedWork={unfinished}
      navigationRef={navigationRef}
      onBusyChange={onBusyChange}
      onPendingChange={holdWhilePending}
      onCancel={onCancel}
      onDeleted={forget}
      onFinished={onFinished}
    />
  );
};

export const ProfileSettings = ({
  profile,
  onClose,
  onSaved,
  onEdit,
  onDeparture,
  accountRead,
}: {
  profile: AuthorProfile | null;
  onClose: () => void;
  onSaved: () => void;
  onEdit?: (() => void) | undefined;
  onDeparture?: (() => void) | undefined;
  accountRead?:
    | {
        readonly loading: boolean;
        readonly error: string;
        readonly onRetry: () => void;
      }
    | undefined;
}) => {
  const articleAuthoring = useArticleAvailability();
  const author = useAuthors(),
    shell = useProductShell();
  const ownProfile = !!profile?.isOwner && profile.id === author.viewer?.id;
  const owner = ownProfile ? profile.id : null;
  const feedback = useSettingsFeedback(owner);
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
      const current = restorablePage(pageRef.current);
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
      ? restorablePage(authReturnView.page)
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
  const [accountsBusy, setAccountsBusy] = useState(false),
    accountsBusyRef = useRef(false);
  // AccountSwitcher remains the single owner of its list, loading and retry.
  const viewerId = author.viewer?.id ?? null;
  const [factorTitle, setFactorTitle] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  const [editRequested, setEditRequested] = useState(false),
    [closing, setClosing] = useState(false);
  const closingRef = useRef(false),
    closeTimer = useRef<number | null>(null);
  const navigation = useRef<AuthorDialogNavigationHandle>(null),
    security = useRef<AccountSecurityHandle>(null),
    deletion = useRef<AccountDeletionHandle>(null);
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
  const privacyDirty = JSON.stringify(saved) !== JSON.stringify(privacy);
  const dirty = privacyDirty || feedback.dirty;
  const blocked =
    busy || securityBusy || accountsBusy || feedback.pending || closing;
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
  const handleAccountsBusy = useCallback((value: boolean) => {
    accountsBusyRef.current = value;
    setAccountsBusy(value);
  }, []);
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
    accountsBusyRef.current = false;
    setAccountsBusy(false);
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
    // Explicit close/edit ends this settings restoration. Effect cleanup may
    // be checking/rekey or StrictMode and must keep late restoration available.
    authReturn?.consumeView("profile-settings-page", authReturnView);
    onDeparture?.();
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
    !busyRef.current &&
    !securityBusyRef.current &&
    !accountsBusyRef.current &&
    !feedback.isPending() &&
    !closingRef.current;
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
    if (busyRef.current || !owner || !privacyDirty) return;
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
      if (!valid()) return;
      // Any refusal reloads the true list. An account deleted after the list
      // was read is no longer listed, yet its block stays in force
      // (account-deletion-v1 r3): lifting it is refused with a conflict, the
      // only one this command meets from this page.
      await loadBlocks();
      if (valid())
        setBlocksError(
          reason instanceof AuthorRequestError && reason.status === 409
            ? "该账号已注销，屏蔽将继续有效"
            : reason instanceof Error
              ? reason.message
              : "解除失败，请重试。",
        );
    } finally {
      if (valid()) setMutationBusy(false);
    }
  };
  const requestEdit = () => {
    if (!ownProfile || !onEdit) {
      show("edit");
      return;
    }
    if (dirty && !window.confirm("更改尚未保存，放弃这些更改？")) return;
    setEditRequested(true);
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
      disabled={blocked || (destination !== "display" && accountPending)}
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
  const guestSignIn = (
    <a className={styles.row} href={author.signInHref}>
      <span className={styles.rowIcon}>
        <SettingsIcon name="shield-check" />
      </span>
      <span className={styles.rowText}>登录后管理账户设置</span>
      <SettingsIcon className={styles.chevron} name="chevron-right" />
    </a>
  );
  const accountPending = Boolean(accountRead?.loading || author.checking);
  const accountError =
    accountRead?.error ||
    (author.sessionError ? "账户状态暂时无法确认，请重试。" : "");
  const guest = (
    <div className={styles.rows}>
      {accountPending ? (
        <p className={styles.status} role="status">
          正在读取账户设置…
        </p>
      ) : accountError ? (
        <div className={styles.rowText}>
          <p className={styles.error} role="alert">
            {accountError}
          </p>
          <button
            type="button"
            className={styles.action}
            onClick={() =>
              accountRead ? accountRead.onRetry() : void author.refresh()
            }
          >
            重试
          </button>
        </div>
      ) : (
        guestSignIn
      )}
    </div>
  );
  return (
    <AuthorDialog
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
      leaveGuard={() =>
        pageRef.current === "deletion" &&
        (deletion.current?.requestLeave() ?? false)
      }
      navigationDepth={
        page === "root" ? 0 : page === "factor" || page === "deletion" ? 2 : 1
      }
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
            {ownProfile && accountError && (
              <div className={styles.group}>
                <p className={styles.error} role="alert">
                  {accountError}
                </p>
                <button
                  type="button"
                  className={styles.action}
                  onClick={() => accountRead?.onRetry()}
                >
                  重试
                </button>
              </div>
            )}
            {page === "root" && (
              <>
                <section className={styles.group}>
                  <h3>偏好</h3>
                  <div className={styles.rows}>
                    {row(
                      "外观",
                      "display",
                      `${themeLabels[shell.theme]} · ${feedLayoutLabels[shell.feedLayout]}`,
                    )}
                  </div>
                </section>
                <section className={styles.group}>
                  <h3>隐私</h3>
                  <div className={styles.rows}>
                    {row(
                      "列表隐私",
                      "privacy",
                      privacyDirty ? "有未保存的更改" : undefined,
                    )}
                    {row("已屏蔽账户", "blocks")}
                  </div>
                </section>
                <section className={styles.group}>
                  <h3>账户</h3>
                  <div className={styles.rows}>
                    {row("账号与安全", "security", "手机号、邮箱换绑")}
                    {row("切换账号", "accounts", "添加、切换或退出账户")}
                    {row("我的举报与申诉", "reports")}
                    <button
                      type="button"
                      data-settings-focus-key="edit"
                      className={styles.row}
                      disabled={blocked || editRequested || accountPending}
                      onClick={requestEdit}
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
                  </div>
                </section>
                {!ownProfile && guest}
                <section className={styles.group}>
                  <h3>帮助与规则</h3>
                  <div className={styles.rows}>
                    <a className={styles.row} href="/policies">
                      <span className={styles.rowText}>服务条款与社区规则</span>
                    </a>
                    <a className={styles.row} href="/policies/reporting">
                      <span className={styles.rowText}>举报与申诉说明</span>
                    </a>
                    {row("反馈与建议", "feedback")}
                  </div>
                </section>
              </>
            )}
            {page === "feedback" &&
              (ownProfile ? (
                <SettingsFeedbackForm feedback={feedback} />
              ) : (
                <div className={styles.rows}>
                  <a className={styles.row} href={author.signInHref}>
                    <span className={styles.rowIcon}>
                      <SettingsIcon name="shield-check" />
                    </span>
                    <span className={styles.rowText}>登录后提交反馈</span>
                    <SettingsIcon
                      className={styles.chevron}
                      name="chevron-right"
                    />
                  </a>
                </div>
              ))}
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
                <ChoiceGroup
                  label={shell.desktop ? "电脑显示模式" : "首页布局"}
                  kind="layout"
                  platform={shell.platform}
                  value={shell.feedLayout}
                  onChange={shell.setFeedLayoutPreference}
                  options={(["single", "double"] as const).map((value) => ({
                    value,
                    label: feedLayoutLabels[value],
                  }))}
                />
                <p className={styles.help}>立即生效，保存在当前浏览器。</p>
              </>
            )}
            {page === "edit" &&
              (ownProfile && onEdit ? (
                <button
                  type="button"
                  className={`${styles.action} ${styles.primary}`}
                  onClick={requestEdit}
                >
                  继续编辑资料
                </button>
              ) : ownProfile ? (
                <p className={styles.status} role="status">
                  资料编辑暂时无法打开，请返回重试。
                </p>
              ) : (
                guest
              ))}
            {page === "reports" && (ownProfile ? <MyReportingCases /> : guest)}
            {page === "accounts" && (
              <AccountSwitcher
                viewerId={viewerId}
                unsavedSettings={
                  privacyDirty
                    ? "列表隐私有未保存的更改"
                    : feedback.dirty
                      ? "反馈还没有提交"
                      : null
                }
                onBusyChange={handleAccountsBusy}
                // Like a sign-out: close, then reload as the account that
                // is current now (or signed out).
                onSessionChange={() => setSignedOut(true)}
              />
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
                    disabled={busy || !privacyDirty}
                    onClick={() => void savePrivacy()}
                  >
                    {busy ? "正在保存" : "保存隐私设置"}
                  </button>
                  <p className={styles.status} role="status">
                    {notice || (privacyDirty ? "更改尚未保存" : "")}
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
                            <UserIdentity
                              name={person.displayName}
                              studioName={person.studioName}
                            />
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
                <>
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
                  {articleAuthoring && page === "security" ? (
                    <ArticleAgentConnections />
                  ) : null}
                </>
              ) : (
                guest
              ))}
            {page === "security" && (
              <AccountDeletionEntry
                disabled={blocked || accountPending}
                onOpen={() => show("deletion")}
              />
            )}
            {page === "deletion" &&
              (ownProfile ? (
                <DeletionPage
                  owner={owner!}
                  settingsDirty={dirty}
                  navigationRef={deletion}
                  onBusyChange={handleSecurityBusy}
                  onCancel={back}
                  onFinished={() => setSignedOut(true)}
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
