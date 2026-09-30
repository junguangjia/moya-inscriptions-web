"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { motion } from "@moya/design-tokens";
import type { AuthorProfile } from "@moya/contracts";
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
const defaults: AuthorProfile["privacy"] = {
  following: "private",
  followers: "private",
  favorites: "private",
  likes: "private",
};
const ChoiceGroup = <Value extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: Value; label: string }[];
  value: Value;
  onChange: (value: Value) => void;
}) => (
  <fieldset className={styles.group}>
    <legend>{label}</legend>
    <div className={styles.choices} role="radiogroup" aria-label={label}>
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
          <span>{option.label}</span>
          <span aria-hidden="true">{value === option.value ? "✓" : ""}</span>
        </button>
      ))}
    </div>
  </fieldset>
);

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
  const [page, setPage] = useState<Page>("root"),
    [direction, setDirection] = useState<"forward" | "back" | "none">("none");
  const pageRef = useRef<Page>("root");
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
  const scrollPositions = useRef<Partial<Record<Page, number>>>({});
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
    if (page === "blocks" && owner && blocks === null && !blocksError)
      void loadBlocks();
  }, [page, owner]);
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
    show("root", true);
  }, [owner]);
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
    if (direction !== "none" && !reducedMotion())
      pageAnimation.current =
        content.current?.animate?.(
          [
            {
              opacity: 0,
              transform: `translateX(${direction === "back" ? -20 : 20}px)`,
            },
            { opacity: 1, transform: "translateX(0)" },
          ],
          {
            duration: Number.parseInt(motion.duration.normal),
            easing: motion.easing.standard,
          },
        ) ?? null;
  }, [page]);
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
      if (latest.current.signedOut) window.location.assign("/");
      else if (
        latest.current.editRequested &&
        ownerRef.current &&
        latest.current.onEdit
      )
        latest.current.onEdit();
      else latest.current.onClose();
    };
    if (reducedMotion()) finish();
    else closeTimer.current = window.setTimeout(finish, 200);
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
  const row = (label: string, destination: Page, summary?: string) => (
    <button
      type="button"
      data-settings-focus-key={destination}
      className={styles.row}
      disabled={blocked}
      onClick={() => show(destination)}
    >
      <span className={styles.rowText}>
        <span>{label}</span>
        {summary && <small>{summary}</small>}
      </span>
      <span className={styles.chevron} aria-hidden="true">
        ›
      </span>
    </button>
  );
  const guest = (
    <div className={styles.rows}>
      <a className={styles.row} href={author.signInHref}>
        <span className={styles.rowText}>
          登录后管理账户设置<small>隐私、屏蔽账户与登录方式</small>
        </span>
        <span className={styles.chevron} aria-hidden="true">
          ›
        </span>
      </a>
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
                  <h3>外观</h3>
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
                          dirty ? "有未保存的更改" : "关注、粉丝、收藏与喜欢",
                        )}
                        {row("已屏蔽账户", "blocks", "查看和解除屏蔽")}
                      </div>
                    </section>
                    <section className={styles.group}>
                      <h3>账户</h3>
                      <div className={styles.rows}>
                        {row("账号与安全", "security", "邮箱、手机号与登录")}
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
                            <span>编辑信息</span>
                            <span className={styles.chevron} aria-hidden="true">
                              ›
                            </span>
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
                  value={shell.theme}
                  onChange={shell.setThemePreference}
                  options={(["system", "light", "dark"] as const).map(
                    (value) => ({ value, label: themeLabels[value] }),
                  )}
                />
                {shell.platform !== "pc" && (
                  <ChoiceGroup
                    label="首页布局"
                    value={shell.feedLayout}
                    onChange={shell.setFeedLayoutPreference}
                    options={(["single", "double"] as const).map((value) => ({
                      value,
                      label: value === "single" ? "单列" : "双列",
                    }))}
                  />
                )}
                <p className={styles.help}>
                  外观更改立即生效，并保存在当前浏览器。
                </p>
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
                        <span>{privacyLabels[key]}</span>
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
                    每项设置仅隐藏自己的列表；另一人的公开列表仍可能显示同一关系。浏览历史、我的评论和编辑草稿始终私密。
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
                    解除屏蔽不会恢复以前的关注。屏蔽不会阻止匿名访问公开内容。
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
                  {blocks && blocks.items.length < blocks.total && (
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
