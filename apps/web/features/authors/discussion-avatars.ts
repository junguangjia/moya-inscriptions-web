"use client";
import { useEffect, useRef, useState } from "react";
import type {
  CommentItem,
  CommentUserPresentation,
} from "../comments/comment-types";
import { avatarThumbSrc } from "../media/profile-image";
import { useAuthors } from "./author-context";
import { authorClient } from "./author-data";

export const useDiscussionAvatars = (rows: readonly CommentItem[]) => {
  const author = useAuthors();
  const viewerId = author.viewer?.id ?? null;
  const suspended = author.checking || author.sessionError;
  const scope = JSON.stringify([viewerId, author.revision, suspended]);
  const ids = JSON.stringify(
    [
      ...new Set(
        rows.flatMap((row) => [
          row.user.id,
          ...row.replies.map((r) => r.user.id),
        ]),
      ),
    ]
      .filter((id) => id !== viewerId)
      .sort(),
  );
  const cache = useRef({ scope, avatars: new Map<string, string | null>() });
  const [snapshot, setSnapshot] = useState(cache.current);

  useEffect(() => {
    if (cache.current.scope !== scope)
      cache.current = { scope, avatars: new Map() };
    if (suspended) return;
    const controller = new AbortController();
    const current = cache.current;
    const pending = (JSON.parse(ids) as string[]).filter(
      (id) => !current.avatars.has(id),
    );
    let cursor = 0;
    const load = async () => {
      while (!controller.signal.aborted && cursor < pending.length) {
        const id = pending[cursor++];
        if (!id) return;
        let src: string | null = null;
        try {
          const profile = await authorClient.profile(id, controller.signal);
          src = avatarThumbSrc(profile.avatar);
        } catch {
          // An unavailable author uses the existing initial-letter fallback.
        }
        if (controller.signal.aborted) return;
        current.avatars.set(id, src);
        setSnapshot({ scope, avatars: new Map(current.avatars) });
      }
    };
    // Resolve each distinct loaded author once per revision, including authors
    // introduced by reply pagination, without refetching the comment pages.
    for (let n = 0; n < Math.min(4, pending.length); n++) void load();
    return () => controller.abort();
  }, [ids, scope, suspended]);

  return (user: CommentUserPresentation): CommentUserPresentation => ({
    ...user,
    avatarSrc: suspended
      ? null
      : user.id === viewerId
        ? author.avatarSrc
        : snapshot.scope === scope
          ? (snapshot.avatars.get(user.id) ?? null)
          : null,
  });
};
