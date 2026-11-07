"use client";
import { useCallback, useSyncExternalStore } from "react";
import type { UserWork, WorkVisibility } from "@moya/contracts";

/**
 * Whether other people can see a work right now, as the author's own view of
 * it last said (`publiclyVisible`, author-only). Work Detail records it when
 * it loads the author's work, and its public interactions (history record,
 * like, favorite, share) and the discussion composer read it: a work nobody
 * else can see offers neither and says so, never with a pending or review
 * label. Entries are per author account, so another account never reads
 * them; third parties have none and keep their own rules.
 */
export interface OwnWorkAudience {
  /** Null while not known again after a visibility change on this page. */
  readonly publiclyVisible: boolean | null;
  readonly visibility: WorkVisibility;
  /**
   * Reading the work again after that change failed, so the page cannot
   * tell until the work loads again (only with `publiclyVisible: null`).
   */
  readonly unconfirmed?: true;
}

const LIMIT = 200;
const audiences = new Map<string, OwnWorkAudience>();
const listeners = new Set<() => void>();

const keyOf = (accountId: string, workId: string) => `${accountId} ${workId}`;

const notify = () => {
  for (const listener of [...listeners]) listener();
};

export const setOwnWorkAudience = (
  accountId: string,
  workId: string,
  audience: OwnWorkAudience | null,
): void => {
  const key = keyOf(accountId, workId);
  const current = audiences.get(key);
  if (
    audience !== null &&
    current?.publiclyVisible === audience.publiclyVisible &&
    current.visibility === audience.visibility &&
    current.unconfirmed === audience.unconfirmed
  )
    return;
  if (audience === null && current === undefined) return;
  audiences.delete(key);
  if (audience !== null) {
    audiences.set(key, audience);
    // A bounded record of the works this browser opened most recently.
    if (audiences.size > LIMIT)
      audiences.delete(audiences.keys().next().value as string);
  }
  notify();
};

/**
 * What the author's own view of a work says about its audience; null for a
 * third party's view, or one without the author-only fields.
 */
export const ownWorkAudienceOf = (work: UserWork): OwnWorkAudience | null =>
  !work.canEdit ||
  work.publiclyVisible === undefined ||
  work.visibility === undefined
    ? null
    : { publiclyVisible: work.publiclyVisible, visibility: work.visibility };

/**
 * Records what the author's own view of a work says; a third party's view,
 * or one without the author-only fields, removes nothing it cannot know.
 */
export const recordOwnWorkAudience = (work: UserWork): void => {
  // Module state is per browser page; a server render never records.
  if (typeof window === "undefined" || !work.canEdit) return;
  setOwnWorkAudience(work.authorId, work.id, ownWorkAudienceOf(work));
};

export const readOwnWorkAudience = (
  accountId: string | null,
  workId: string | null,
): OwnWorkAudience | null =>
  accountId === null || workId === null
    ? null
    : (audiences.get(keyOf(accountId, workId)) ?? null);

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The signed-in author's own record for a work, or null (not theirs, or not known). */
export const useOwnWorkAudience = (
  accountId: string | null,
  workId: string | null,
): OwnWorkAudience | null => {
  const read = useCallback(
    () => readOwnWorkAudience(accountId, workId),
    [accountId, workId],
  );
  return useSyncExternalStore(subscribe, read, () => null);
};

/** Only for tests: forgets every record. */
export const resetOwnWorkAudiences = (): void => {
  audiences.clear();
  notify();
};

/**
 * The truthful note for the author of a work others cannot see: the
 * requested visibility names why only when it is self-only. While it is
 * being read again nothing is claimed; when that read failed, the note
 * says only that it cannot be told. Null when others can see the work.
 */
export const ownWorkAudienceNote = (
  audience: OwnWorkAudience,
): string | null =>
  audience.publiclyVisible === false
    ? audience.visibility === "self"
      ? "此作品当前仅你可见。"
      : "此作品当前不对其他人显示。"
    : audience.publiclyVisible === null && audience.unconfirmed === true
      ? "暂时无法确认其他人能否看到此作品。"
      : null;

/**
 * The short mark an author's own work carries in a works grid while others
 * cannot see it (the profile works grid's, and the timeline posts grid's):
 * 仅自己可见 when it is self-only, else 暂不公开, never a pending or review
 * label. Null while others can see it, or while that is not known.
 */
export const ownWorkAudienceLabel = (
  audience: OwnWorkAudience,
): string | null =>
  audience.publiclyVisible === false
    ? audience.visibility === "self"
      ? "仅自己可见"
      : "暂不公开"
    : null;
