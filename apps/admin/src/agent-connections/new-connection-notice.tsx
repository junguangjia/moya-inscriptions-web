"use client";

import { useEffect, useState } from "react";
import { useNav, usePreferences } from "@payloadcms/ui";

import community from "../community/community.module.css";
import styles from "./connections.module.css";

/**
 * Tells an owner that another owner connected a tool, on their next visit to the
 * Admin (amendment 2026-11-05, section 4). The Admin has no mail adapter, so this
 * is how they hear of it. What this person has seen lives in their own Payload
 * preferences, which needs no migration and follows them between devices.
 *
 * Reading the list is reserved to an Owner browser session like everything else on
 * it. A failed read shows nothing, because the notice is a courtesy and the AI 连接
 * page stays the place to look.
 */

const SEEN_PREFERENCE = "agent-connections-seen";

interface NewConnection {
  readonly tool: string | null;
  readonly authorizedBy: string | null;
  readonly consentedAt: string;
}

const isOthersConnection = (entry: unknown): entry is NewConnection => {
  const row = entry as { mine?: unknown; consentedAt?: unknown };
  return row.mine === false && typeof row.consentedAt === "string";
};

export const NewConnectionNotice = () => {
  const { getPreference, setPreference } = usePreferences();
  const { navOpen } = useNav();
  const [unseen, setUnseen] = useState<readonly NewConnection[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const response = await fetch("/api/agent-connections", {
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok) return;
      const body = (await response.json()) as {
        result?: { connections?: readonly unknown[] };
      };
      const others = (body.result?.connections ?? [])
        .filter(isOthersConnection)
        .sort((a, b) => Date.parse(b.consentedAt) - Date.parse(a.consentedAt));
      if (others.length === 0) return;
      const seen = await getPreference<{ seenAt?: string } | null>(
        SEEN_PREFERENCE,
      );
      const seenAt = Date.parse(seen?.seenAt ?? "");
      if (!controller.signal.aborted)
        setUnseen(
          Number.isNaN(seenAt)
            ? others
            : others.filter(
                ({ consentedAt }) => Date.parse(consentedAt) > seenAt,
              ),
        );
    })().catch(() => undefined);
    return () => controller.abort();
  }, [getPreference]);

  const [latest] = unseen;
  if (latest === undefined) return null;
  const who = latest.authorizedBy ?? "另一位管理员";
  const what = latest.tool ?? "一个工具";

  return (
    <div
      className={styles.ownerNotice}
      data-agent-connections-notice={unseen.length}
      data-nav-open={navOpen}
      role="status"
    >
      <span>
        {unseen.length === 1
          ? `有新的 AI 连接：${who} 授权了「${what}」。`
          : `有 ${unseen.length} 个新的 AI 连接，最近一个是 ${who} 授权的「${what}」。`}
      </span>
      <span className={styles.ownerNoticeActions}>
        <a className={styles.quietLink} href="/admin/agent-connections">
          查看
        </a>
        <button
          className={community.actionButton}
          data-agent-connections-notice-dismiss
          onClick={() => {
            setUnseen([]);
            // A save that fails tells them again next visit, which is harmless.
            void Promise.resolve(
              setPreference(SEEN_PREFERENCE, { seenAt: latest.consentedAt }),
            ).catch(() => undefined);
          }}
          type="button"
        >
          知道了
        </button>
      </span>
    </div>
  );
};
