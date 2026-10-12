"use client";
import { useEffect, useState } from "react";
import { authorClient } from "./author-data";
import { useOptionalAuthors } from "./author-context";
import styles from "../home/home-screen.module.css";

type BodyState =
  | { readonly state: "loading" }
  | { readonly state: "loaded"; readonly text: string }
  | { readonly state: "error" };

/**
 * A work post's full body, shown in place under the title once expanded. The
 * card carries only an excerpt, so the first expansion reads the work once;
 * collapsing aborts a read in flight. Rendering nothing while collapsed keeps
 * the excerpt line the only text of the post. An untitled post passes its
 * excerpt as `preview`, kept in place until the full body replaces it.
 */
export const FeedPostBody = ({
  workId,
  expanded,
  id,
  preview,
}: {
  readonly workId: string;
  readonly expanded: boolean;
  readonly id: string;
  readonly preview?: string | undefined;
}) => {
  const author = useOptionalAuthors();
  const cache = author?.cache;
  const key = `work-body:${author?.viewer?.id ?? "guest"}:${workId}`;
  const checking = author?.checking ?? false;
  const sessionError = author?.sessionError ?? false;
  const [snapshot, setSnapshot] = useState<{ key: string; body: BodyState }>(
    () => {
      const cached = cache?.get(key);
      return {
        key,
        body:
          typeof cached === "string"
            ? { state: "loaded", text: cached }
            : { state: "loading" },
      };
    },
  );
  // Hide the old identity's snapshot in the render that changes identity,
  // before the effect starts its replacement read.
  const body: BodyState = sessionError
    ? { state: "error" }
    : checking || snapshot.key !== key
      ? { state: "loading" }
      : snapshot.body;
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!expanded || checking || sessionError) return undefined;
    const cached = cache?.get(key);
    if (typeof cached === "string") {
      setSnapshot({ key, body: { state: "loaded", text: cached } });
      return undefined;
    }
    const controller = new AbortController();
    setSnapshot({ key, body: { state: "loading" } });
    authorClient
      .work(workId, controller.signal)
      .then((work) => {
        if (controller.signal.aborted) return;
        if (!work.available) {
          setSnapshot({ key, body: { state: "error" } });
          return;
        }
        cache?.set(key, work.text);
        setSnapshot({ key, body: { state: "loaded", text: work.text } });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setSnapshot({ key, body: { state: "error" } });
      });
    return () => controller.abort();
  }, [expanded, workId, attempt, key, cache, checking, sessionError]);
  if (!expanded) return null;
  return (
    <div
      className={styles.postBody}
      data-feed-post-body-state={body.state}
      id={id}
    >
      {body.state === "loaded" ? (
        <p className={styles.postBodyText} data-feed-post-body="">
          {body.text}
        </p>
      ) : preview === undefined || preview === "" ? null : (
        <p className={styles.postBodyText} data-card-excerpt="">
          {preview}
        </p>
      )}
      {body.state === "loaded" ? null : body.state === "loading" ? (
        <p className={styles.postBodyStatus} role="status">
          正文加载中…
        </p>
      ) : (
        <p className={styles.postBodyStatus} role="alert">
          正文暂时无法加载
          <button
            className={styles.postBodyRetry}
            onClick={() => {
              if (sessionError && author !== null) void author.refresh();
              else setAttempt((value) => value + 1);
            }}
            type="button"
          >
            重试
          </button>
        </p>
      )}
    </div>
  );
};
