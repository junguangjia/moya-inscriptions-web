/**
 * account-switching-v1: tells other tabs that this browser's session changed
 * (an account was added, switched or signed out). Like the Development
 * CommunitySessionNotification it stores no identity or credential: every
 * tab's AuthorProvider rechecks the Backend on the `storage` event.
 */
export const announceCommunitySessionChange = () => {
  try {
    window.localStorage.setItem(
      "yoyi-community-session-change",
      crypto.randomUUID(),
    );
  } catch {
    // Storage may be disabled; the existing focus refresh remains available.
  }
};

const sessionNoticeKey = "yoyi-community-session-notice";

/**
 * Leaves one message for this tab's next page load, when a session change here
 * ends in a full reload that must not look like a plain success (a partial
 * 退出所有账号). sessionStorage keeps it to this tab; it names accounts only.
 */
export const carrySessionNotice = (text: string) => {
  try {
    window.sessionStorage.setItem(sessionNoticeKey, text);
  } catch {
    // Storage may be disabled; 设置 → 切换账号 still lists what is held.
  }
};

/** The message the previous page load left, once. */
export const takeSessionNotice = (): string | null => {
  try {
    const text = window.sessionStorage.getItem(sessionNoticeKey);
    if (text !== null) window.sessionStorage.removeItem(sessionNoticeKey);
    return text === "" ? null : text;
  } catch {
    return null;
  }
};
