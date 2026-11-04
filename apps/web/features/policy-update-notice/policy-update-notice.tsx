"use client";

import { useSyncExternalStore } from "react";

import { Icon } from "@moya/ui";

import styles from "./policy-update-notice.module.css";

export const POLICY_UPDATE_NOTICE_STORAGE_KEY =
  "yoyi.policy-update-notice.ai-tools.v1";

/** The client's clock ends it here, the start of 2026-12-05 in China; nothing has to remove it. */
const POLICY_UPDATE_NOTICE_ENDS_AT = Date.parse("2026-12-05T00:00:00+08:00");

// Every Home feed draws one, so closing one closes them all. The flag also
// keeps it closed for this page when storage is blocked.
let closed = false;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const isDue = () => {
  if (closed || Date.now() >= POLICY_UPDATE_NOTICE_ENDS_AT) return false;
  try {
    return (
      window.localStorage.getItem(POLICY_UPDATE_NOTICE_STORAGE_KEY) === null
    );
  } catch {
    // Storage may be disabled; the notice may then show on every visit.
    return true;
  }
};

const isDueOnServer = () => false;

const close = () => {
  closed = true;
  try {
    window.localStorage.setItem(POLICY_UPDATE_NOTICE_STORAGE_KEY, "closed");
  } catch {
    // Storage may be disabled; the notice is closed for this page only.
  }
  for (const listener of listeners) listener();
};

/**
 * Tells existing users once that the policies changed, since they never see
 * the registration agreement again. It appears only after mount, so the server
 * HTML never holds it, and asks for nothing: no request, event or cookie.
 */
export const PolicyUpdateNotice = () => {
  const due = useSyncExternalStore(subscribe, isDue, isDueOnServer);
  return due ? (
    <div
      className={styles.notice}
      data-panel-preface=""
      data-policy-update-notice=""
    >
      <p>隐私政策和社区规则已更新：平台开始使用 AI 工具协助审核和后台管理。</p>
      <a className={styles.link} href="/policies" onClick={close}>
        查看
      </a>
      <button
        aria-label="关闭提示"
        className={styles.close}
        onClick={close}
        type="button"
      >
        <Icon aria-hidden="true" name="close" size="sm" />
      </button>
    </div>
  ) : null;
};
