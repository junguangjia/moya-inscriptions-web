"use client";
import { useEffect, useState } from "react";
import { authorClient } from "./author-data";
import styles from "../home/home-screen.module.css";

/** Full bodies already read in this document, by work id. */
const bodies = new Map<string, string>();

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
  const [body, setBody] = useState<BodyState>(() => {
    const cached = bodies.get(workId);
    return cached === undefined
      ? { state: "loading" }
      : { state: "loaded", text: cached };
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!expanded) return undefined;
    const cached = bodies.get(workId);
    if (cached !== undefined) {
      setBody({ state: "loaded", text: cached });
      return undefined;
    }
    const controller = new AbortController();
    setBody({ state: "loading" });
    authorClient
      .work(workId, controller.signal)
      .then((work) => {
        if (controller.signal.aborted) return;
        if (!work.available) {
          setBody({ state: "error" });
          return;
        }
        bodies.set(workId, work.text);
        setBody({ state: "loaded", text: work.text });
      })
      .catch(() => {
        if (!controller.signal.aborted) setBody({ state: "error" });
      });
    return () => controller.abort();
  }, [expanded, workId, attempt]);
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
            onClick={() => setAttempt((value) => value + 1)}
            type="button"
          >
            重试
          </button>
        </p>
      )}
    </div>
  );
};
