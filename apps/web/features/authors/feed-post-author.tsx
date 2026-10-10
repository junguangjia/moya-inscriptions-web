"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { AuthorProfile } from "@moya/contracts";
import { useProductShell } from "../product-shell/product-shell";
import { requestIdentity } from "../shell/request-identity";
import { useAuthors } from "./author-context";
import { authorClient } from "./author-data";
import { UserIdentity } from "./user-identity";
import styles from "../home/home-screen.module.css";

type FeedAuthor = Pick<
  AuthorProfile,
  "displayName" | "studioName" | "isOwner" | "following"
> & { readonly avatarSrc: string | null };

/**
 * One profile read per distinct author and author revision, shared by every
 * post of that author in the mounted feeds. A newer revision keeps showing the
 * previous profile until it resolves, so a like or follow never blanks headers.
 */
const store = {
  viewer: null as string | null,
  profiles: new Map<
    string,
    { readonly scope: string; readonly value: FeedAuthor | null }
  >(),
  pending: new Map<string, Promise<void>>(),
  /** The newest read or local follow per author; older reads are dropped. */
  latest: new Map<string, number>(),
  sequence: 0,
  version: 0,
  listeners: new Set<() => void>(),
};
const emit = () => {
  store.version++;
  for (const listener of store.listeners) listener();
};
const subscribe = (listener: () => void) => {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
};
const readVersion = () => store.version;

const resetFor = (viewer: string) => {
  if (store.viewer === viewer) return;
  store.viewer = viewer;
  store.profiles.clear();
  store.pending.clear();
  store.latest.clear();
};

const load = (viewer: string, scope: string, authorId: string) => {
  resetFor(viewer);
  if (store.profiles.get(authorId)?.scope === scope) return;
  const key = `${scope}:${authorId}`;
  if (store.pending.has(key)) return;
  const sequence = ++store.sequence;
  store.latest.set(authorId, sequence);
  const read = authorClient
    .profile(authorId)
    .then(
      (profile): FeedAuthor => ({
        displayName: profile.displayName,
        studioName: profile.studioName,
        isOwner: profile.isOwner,
        following: profile.following,
        avatarSrc: profile.avatar?.src ?? null,
      }),
      // An unavailable author keeps the last known header, else a bare one.
      () => store.profiles.get(authorId)?.value ?? null,
    )
    .then((value) => {
      if (store.viewer !== viewer) return;
      store.pending.delete(key);
      // A read overtaken by a newer read or a local follow never overwrites it.
      if (store.latest.get(authorId) !== sequence) return;
      store.profiles.set(authorId, { scope, value });
      emit();
    });
  store.pending.set(key, read);
};

const setFollowing = (viewer: string, authorId: string, following: boolean) => {
  const entry = store.profiles.get(authorId);
  if (store.viewer !== viewer || !entry?.value) return;
  store.latest.set(authorId, ++store.sequence);
  store.profiles.set(authorId, {
    scope: entry.scope,
    value: { ...entry.value, following },
  });
  emit();
};

/** The author of a feed post: undefined while loading, null when unavailable. */
const useFeedAuthor = (authorId: string): FeedAuthor | null | undefined => {
  const author = useAuthors();
  const viewer = author.viewer?.id ?? "guest";
  const suspended = author.checking || author.sessionError;
  const scope = `${viewer}:${author.revision}`;
  useSyncExternalStore(subscribe, readVersion, readVersion);
  useEffect(() => {
    if (!suspended) load(viewer, scope, authorId);
  }, [authorId, scope, suspended, viewer]);
  return store.viewer === viewer
    ? store.profiles.get(authorId)?.value
    : undefined;
};

/**
 * The header of a single-column work post: avatar and name open the author's
 * profile; a signed-in viewer can follow another author in place.
 */
export const FeedPostAuthor = ({ authorId }: { authorId: string }) => {
  const author = useAuthors();
  const shell = useProductShell();
  const profile = useFeedAuthor(authorId);
  const [busy, setBusy] = useState(false);
  const viewer = author.viewer?.id ?? null;
  const self = viewer === authorId || profile?.isOwner === true;
  const avatarSrc = self ? author.avatarSrc : (profile?.avatarSrc ?? null);
  const name = profile?.displayName ?? "";
  const follow = async () => {
    if (viewer === null || !profile || busy) return;
    const enabled = !profile.following;
    setBusy(true);
    try {
      await authorClient.command("relationships/follow", {
        requestId: requestIdentity(),
        targetId: authorId,
        enabled,
      });
      setFollowing(viewer, authorId, enabled);
      author.mutate();
    } catch (error) {
      author.notify(error instanceof Error ? error.message : "关注未完成");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className={styles.postHeader}
      data-feed-post-author=""
      data-author-state={profile === undefined ? "loading" : undefined}
    >
      <button
        type="button"
        className={styles.postAuthor}
        aria-label={name === "" ? "查看作者" : `查看 ${name} 的主页`}
        onClick={(event) => shell.openProfile(authorId, event.currentTarget)}
      >
        <span className={styles.postAvatar}>
          {avatarSrc ? (
            <img src={avatarSrc} alt="" width="36" height="36" />
          ) : (
            [...name][0]
          )}
        </span>
        {name === "" ? null : (
          <UserIdentity name={name} studioName={profile?.studioName} />
        )}
      </button>
      {viewer === null || self || !profile ? null : (
        <button
          type="button"
          className={styles.postFollow}
          aria-pressed={profile.following}
          aria-busy={busy || undefined}
          data-feed-post-follow=""
          data-following={profile.following}
          disabled={busy || author.checking}
          onClick={() => void follow()}
        >
          {profile.following ? "已关注" : "关注"}
        </button>
      )}
    </div>
  );
};
