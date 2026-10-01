/**
 * content-community-completion-v1: the direct-message feature module. The
 * message-center host (owned by the notifications track) mounts
 * `DirectMessagePanel` in its 私信 slot and adds `useUnreadConversationCount()`
 * to its activity units exactly once.
 */
export { DirectMessagePanel } from "./direct-message-panel";
export type {
  DirectMessagePanelProps,
  DirectMessageTitle,
} from "./direct-message-panel";
export { DM_POLL_INTERVAL_MS } from "./use-direct-messages";
export {
  DirectMessageEntryProvider,
  useDirectMessageEntry,
  useUnreadConversationCount,
} from "./direct-message-entry";
