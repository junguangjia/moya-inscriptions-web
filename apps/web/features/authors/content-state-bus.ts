"use client";
import { useSyncExternalStore } from "react";
import type { ContentIdentity, DiscussionTarget } from "@moya/contracts";
import { contentKey } from "./author-context";

/*
 * The latest comment total a reader has received for each content, from
 * either its state read or its discussion read (both count with the same
 * Backend rule). Every mounted card and Detail of that content shows the
 * newest total without another request: posting or deleting a comment
 * re-reads the discussion, and that read publishes here. No count is ever
 * guessed locally (a comment awaiting approval is not public).
 */
const counts = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const readVersion = () => version;
const keyOf = (viewerId: string | null, target: ContentIdentity) =>
  `${viewerId ?? "guest"}:${contentKey(target)}`;

/** Records the comment total `viewerId` received for a discussed content. */
export const publishCommentCount = (
  viewerId: string | null,
  target: DiscussionTarget,
  count: number,
): void => {
  if (target.type === "article") return;
  const key = keyOf(viewerId, target);
  if (counts.get(key) === count) return;
  counts.set(key, count);
  version++;
  for (const listener of listeners) listener();
};

/** The newest comment total this reader received for the content, if any. */
export const usePublishedCommentCount = (
  viewerId: string | null,
  target: ContentIdentity,
): number | undefined => {
  useSyncExternalStore(subscribe, readVersion, readVersion);
  return counts.get(keyOf(viewerId, target));
};
