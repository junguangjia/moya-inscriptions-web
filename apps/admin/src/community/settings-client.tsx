"use client";

import { workspacePageLabel } from "../workspace/routes";

import { useEffect, useState } from "react";
import { SetStepNav } from "@payloadcms/ui";

import {
  TIME_ZONE_NOTE,
  call,
  describeFailure,
  formatPreciseTime,
  policyDescriptions,
  policyLabels,
} from "./api";
import styles from "./community.module.css";
import { WorkPublishingSettingsCard } from "./work-publishing-settings-client";

import type {
  PublicationPolicy,
  PublicationPolicyState,
} from "@moya/contracts/internal/community-operator";

const policies: readonly PublicationPolicy[] = [
  "DIRECT_PUBLICATION",
  "PRE_MODERATION",
];

/**
 * The Owner-controlled publication setting. Switching affects future
 * submissions only; nothing already pending, visible or hidden changes.
 * In Development the independent work publishing setting follows as its own
 * card; the two are stored and switched separately.
 */
export const CommunitySettingsClient = ({
  workPublishing = false,
}: {
  readonly workPublishing?: boolean;
}) => {
  const [policy, setPolicy] = useState<PublicationPolicyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{
    readonly tone: "success" | "error";
    readonly text: string;
  } | null>(null);

  useEffect(() => {
    void call<PublicationPolicyState>("read-policy")
      .then((state) => {
        setPolicy(state);
        setError(null);
      })
      .catch((failure: unknown) => setError(describeFailure(failure).text));
  }, []);

  const choose = async (next: PublicationPolicy) => {
    if (policy?.policy === next || busy) return;
    setBusy(true);
    try {
      setPolicy(
        await call<PublicationPolicyState>("set-policy", { policy: next }),
      );
      setReceipt({
        tone: "success",
        text: `已切换为「${policyLabels[next]}」，仅影响此后的新评论与回复。`,
      });
    } catch (failure) {
      setReceipt({
        tone: "error",
        text: `切换未执行：${describeFailure(failure).text}`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.workspace}>
      <SetStepNav
        nav={[
          { label: "设置", url: "/admin/community-moderation/settings" },
          { label: "发布规则" },
        ]}
      />
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>
            {workspacePageLabel("/admin/community-moderation/settings")}
          </h1>
          <p className={styles.lead}>
            {workPublishing
              ? "评论和作品可分别设置发布方式。"
              : "设置评论的发布方式。"}
          </p>
        </div>
      </header>

      {error !== null ? (
        <p className={styles.notice} data-tone="error" role="alert">
          {error}
        </p>
      ) : null}

      {workPublishing ? (
        <h2 className={styles.sectionTitle}>评论与回复发布模式</h2>
      ) : null}

      {/* Options are unavailable only until the current mode is known; while a
          switch is in flight the group is busy and clicks are ignored. */}
      <div
        aria-busy={busy}
        aria-label={workPublishing ? "评论与回复发布模式" : "发布模式"}
        className={styles.tabs}
        role="radiogroup"
      >
        {policies.map((option) => (
          <button
            aria-checked={policy?.policy === option}
            className={styles.option}
            data-policy-option={option}
            disabled={policy === null}
            key={option}
            onClick={() => void choose(option)}
            role="radio"
            type="button"
          >
            {policyLabels[option]}
          </button>
        ))}
      </div>

      {policy === null ? (
        <p className={styles.state} role="status">
          正在读取当前设置…
        </p>
      ) : (
        <div className={styles.card} data-policy-current={policy.policy}>
          <h2>当前：{policyLabels[policy.policy]}</h2>
          <p className={styles.lead}>{policyDescriptions[policy.policy]}</p>
          <p className={styles.secondary}>
            由 {policy.updatedBy} 于{" "}
            <time dateTime={policy.updatedAt}>
              {formatPreciseTime(policy.updatedAt)}
            </time>{" "}
            设置；{TIME_ZONE_NOTE}。
          </p>
          <p className={styles.lead}>
            切换只影响此后的新提交：已待审核的仍待审核，已公开的仍公开，已隐藏的仍隐藏。
            回复不会越过仍待审核或已隐藏的根评论显示。
          </p>
        </div>
      )}

      {receipt === null ? null : (
        <p className={styles.receipt} data-tone={receipt.tone} role="status">
          {receipt.text}
        </p>
      )}

      {workPublishing ? <WorkPublishingSettingsCard /> : null}
    </div>
  );
};
