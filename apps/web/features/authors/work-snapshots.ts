"use client";
import { useCallback, useSyncExternalStore } from "react";
import type { UserWork } from "@moya/contracts";
import { authorClient } from "./author-data";
import { recordOwnWorkAudience } from "./own-work-audience";

/**
 * Full work records this page already received (a Works tab list, a body
 * read, a Detail read), so a work's Detail can show at once while its own
 * read confirms it; the server stays the authority. Each record keeps the
 * account and account epoch it was read under and is shown only while both
 * are still current, so nothing read for another account (even A→B→A) is
 * ever shown.
 */
interface WorkSnapshot {
  readonly work: UserWork;
  readonly account: string | null;
  readonly epoch: number;
}

/** Whom a read was for: taken before the read starts, passed with its answer. */
export interface WorkSnapshotToken {
  readonly account: string | null;
  readonly epoch: number;
  readonly generation: number;
}

const LIMIT = 200;
const entries = new Map<string, WorkSnapshot>();
// Increases on every forget: a read started before a work or its author was
// forgotten records neither, so a late answer cannot bring either back.
let generation = 0;
const forgottenWorks = new Map<string, number>();
const forgottenAuthors = new Map<string, number>();
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of [...listeners]) listener();
};

// A bounded record, the most recently written last.
const remember = <T>(map: Map<string, T>, key: string, value: T) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > LIMIT) map.delete(map.keys().next().value as string);
};

/** Whom a read starting now is for; pass it to `recordWorkSnapshots` with the answer. */
export const workSnapshotToken = (): WorkSnapshotToken => ({
  account: authorClient.account(),
  epoch: authorClient.accountEpoch(),
  generation,
});

/**
 * Records works a read returned, unless the account changed since the read
 * started or a work or its author was forgotten meanwhile; the author's own
 * view of a work also records its audience.
 */
export const recordWorkSnapshots = (
  works: readonly UserWork[],
  token: WorkSnapshotToken,
): void => {
  // Module state is per browser page; a server render never records.
  if (
    typeof window === "undefined" ||
    token.account !== authorClient.account() ||
    token.epoch !== authorClient.accountEpoch()
  )
    return;
  let changed = false;
  for (const [id, entry] of entries) {
    if (entry.account === token.account && entry.epoch === token.epoch)
      continue;
    entries.delete(id);
    changed = true;
  }
  for (const work of works) {
    if (
      (forgottenWorks.get(work.id) ?? 0) > token.generation ||
      (forgottenAuthors.get(work.authorId) ?? 0) > token.generation
    )
      continue;
    remember(entries, work.id, {
      work,
      account: token.account,
      epoch: token.epoch,
    });
    recordOwnWorkAudience(work);
    changed = true;
  }
  if (changed) notify();
};

/** The work as last read for the current account, or null. Never records. */
export const readWorkSnapshot = (id: string): UserWork | null => {
  const entry = entries.get(id);
  if (entry === undefined) return null;
  return entry.account === authorClient.account() &&
    entry.epoch === authorClient.accountEpoch()
    ? entry.work
    : null;
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The work as last read for the current account, or null (always on the server). */
export const useWorkSnapshot = (id: string): UserWork | null => {
  const read = useCallback(() => readWorkSnapshot(id), [id]);
  return useSyncExternalStore(subscribe, read, () => null);
};

/** Forgets a work, including what reads already in progress would record. */
export const forgetWorkSnapshot = (id: string): void => {
  generation++;
  remember(forgottenWorks, id, generation);
  entries.delete(id);
  notify();
};

/** Forgets every work of an author, including what reads in progress would record. */
export const forgetAuthorWorkSnapshots = (authorId: string): void => {
  generation++;
  remember(forgottenAuthors, authorId, generation);
  for (const [id, entry] of entries)
    if (entry.work.authorId === authorId) entries.delete(id);
  notify();
};

/** Only for tests: forgets every record. */
export const resetWorkSnapshots = (): void => {
  entries.clear();
  forgottenWorks.clear();
  forgottenAuthors.clear();
  generation = 0;
  notify();
};
