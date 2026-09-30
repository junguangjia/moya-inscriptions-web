"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useAuthReturnView } from "../auth/auth-return";
import type { AuthorProfile } from "@moya/contracts";
import { AuthorDialog } from "./author-dialog";
import { authorClient } from "./author-data";
import { useAuthors } from "./author-context";
import { requestIdentity } from "../shell/request-identity";
import { useProductShell } from "../product-shell/product-shell";
import { AccountSecurity } from "../auth/account-security";
import { SettingsDisplayControls } from "../settings/settings-overlay";
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
  const tabRef = useRef<"display" | "account">("display");
  const authReturnView = useAuthReturnView("profile-settings-tab", () => ({
    tab: tabRef.current,
  }));
  const initialPrivacy: AuthorProfile["privacy"] = profile?.privacy ?? {
    following: "private",
    followers: "private",
    favorites: "private",
    likes: "private",
  };
  const [privacy, setPrivacy] = useState(initialPrivacy),
    [saved, setSaved] = useState(initialPrivacy),
    [tab, setTab] = useState<"display" | "account">(
      authReturnView?.tab ?? "display",
    ),
    [blocks, setBlocks] = useState<Awaited<
      ReturnType<typeof authorClient.people>
    > | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [editRequested, setEditRequested] = useState(false);
  tabRef.current = tab;
  const author = useAuthors();
  const shell = useProductShell();
  const tabId = useId();
  const ownProfile = !!profile?.isOwner && profile.id === author.viewer?.id;
  const dirty = JSON.stringify(saved) !== JSON.stringify(privacy);
  const load = (page = 1) =>
    !ownProfile
      ? Promise.resolve()
      : authorClient.people(profile.id, "blocks", page).then((result) =>
          setBlocks((old) =>
            page === 1
              ? result
              : {
                  ...result,
                  items: [...(old?.items ?? []), ...result.items],
                },
          ),
        );
  useEffect(() => {
    if (tab === "account" && ownProfile)
      void load().catch((e) => setError(e.message));
  }, [profile?.id, ownProfile, tab]);
  const labels = {
    following: "关注列表",
    followers: "粉丝列表",
    favorites: "收藏列表",
    likes: "喜欢列表",
  } as const;
  return (
    <AuthorDialog
      title="设置"
      dirty={!editRequested && dirty}
      closeRequested={editRequested}
      onClose={() => {
        if (editRequested && ownProfile && onEdit) onEdit();
        else onClose();
      }}
    >
      {ownProfile && onEdit && (
        <div className="phase4-actions">
          <button
            type="button"
            disabled={busy || editRequested}
            onClick={() => {
              if (dirty && !window.confirm("更改尚未保存，放弃这些更改？"))
                return;
              setEditRequested(true);
            }}
          >
            编辑信息
          </button>
        </div>
      )}
      <div
        className="phase4-settings-tabs"
        role="tablist"
        aria-label="设置分类"
      >
        {(["display", "account"] as const).map((value, index) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`${tabId}-${value}`}
            aria-controls={`${tabId}-${value}-panel`}
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const next =
                event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
              setTab(next === 0 ? "display" : "account");
              const buttons =
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  "button",
                );
              buttons?.[next]?.focus();
            }}
          >
            {value === "display" ? "显示" : "账户设置"}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${tabId}-display-panel`}
        aria-labelledby={`${tabId}-display`}
        hidden={tab !== "display"}
      >
        <SettingsDisplayControls
          feedLayout={shell.feedLayout}
          platform={shell.platform}
          theme={shell.theme}
          onCycleTheme={shell.cycleTheme}
          onCycleFeedLayout={shell.cycleFeedLayout}
        />
      </div>
      <div
        role="tabpanel"
        id={`${tabId}-account-panel`}
        aria-labelledby={`${tabId}-account`}
        hidden={tab !== "account"}
      >
        {ownProfile ? (
          <div className="phase4-form">
            <h3>列表隐私</h3>
            {(Object.keys(labels) as (keyof typeof labels)[]).map((key) => (
              <label key={key}>
                {labels[key]}
                <select
                  value={privacy[key]}
                  disabled={busy}
                  onChange={(e) =>
                    setPrivacy((old) => ({
                      ...old,
                      [key]: e.target.value as "public" | "private",
                    }))
                  }
                >
                  <option value="public">公开</option>
                  <option value="private">仅自己可见</option>
                </select>
              </label>
            ))}
            <p className="phase4-muted">
              每项设置仅隐藏自己的列表；另一人的公开列表仍可能显示同一关系。浏览历史、我的评论和编辑草稿始终私密。
            </p>
            <button
              className="phase4-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await authorClient.command("me/privacy", {
                    requestId: requestIdentity(),
                    privacy,
                  });
                  setSaved(privacy);
                  onSaved();
                  author.mutate();
                  author.notify("隐私设置已保存");
                } catch (e) {
                  setError(e instanceof Error ? e.message : "保存失败");
                } finally {
                  setBusy(false);
                }
              }}
            >
              保存隐私设置
            </button>
            <h3>已屏蔽账户</h3>
            <p className="phase4-muted">
              解除屏蔽不会恢复以前的关注。屏蔽不会阻止匿名访问公开内容。
            </p>
            {blocks?.items.map((person) => (
              <div className="phase4-actions" key={person.id}>
                <span>
                  {person.displayName} · @{person.handle}
                </span>
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await authorClient.command("relationships/block", {
                        requestId: requestIdentity(),
                        targetId: person.id,
                        enabled: false,
                      });
                      await load();
                      author.mutate();
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "解除失败");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  解除屏蔽
                </button>
              </div>
            ))}
            {blocks && blocks.items.length < blocks.total && (
              <button
                onClick={() =>
                  void load(blocks.page + 1).catch((e) => setError(e.message))
                }
              >
                加载更多
              </button>
            )}
            {error && <p role="alert">{error}</p>}
            <AccountSecurity />
          </div>
        ) : (
          <p>
            <a href={author.signInHref}>登录后管理账户设置</a>
          </p>
        )}
      </div>
    </AuthorDialog>
  );
};
