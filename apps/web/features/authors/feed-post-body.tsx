"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { authorClient } from "./author-data";
import { useOptionalAuthors } from "./author-context";
import styles from "../home/home-screen.module.css";

type BodyState =
  | { readonly state: "loading" }
  | { readonly state: "loaded"; readonly text: string }
  | { readonly state: "error" };

/** Preview the body immediately; read visible posts through the existing,
 * account-scoped work endpoint to determine whether three lines overflow. */
export const FeedPostBody = ({
  workId,
  expanded,
  id,
  preview,
  onOverflowChange,
}: {
  readonly workId: string;
  readonly expanded: boolean;
  readonly id: string;
  readonly preview?: string | undefined;
  readonly onOverflowChange?: ((overflow: boolean) => void) | undefined;
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
  const [previewOwner] = useState(author?.viewer?.id ?? "guest");
  const safePreview =
    !checking &&
    !sessionError &&
    previewOwner === (author?.viewer?.id ?? "guest")
      ? preview
      : undefined;
  const container = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLParagraphElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (onOverflowChange === undefined || container.current === null) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [onOverflowChange]);
  const displayedText =
    body.state === "loaded" ? body.text : (safePreview ?? "");
  useLayoutEffect(() => {
    if (onOverflowChange === undefined || text.current === null) return;
    const element = text.current;
    const measure = () => {
      const lineHeight = Number.parseFloat(
        getComputedStyle(element).lineHeight,
      );
      if (Number.isFinite(lineHeight))
        onOverflowChange(element.scrollHeight > lineHeight * 3 + 1);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(element);
    let active = true;
    void document.fonts?.ready.then(() => {
      if (active) measure();
    });
    window.addEventListener("resize", measure);
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [displayedText, body.state, expanded, onOverflowChange]);
  const shouldRead = expanded || (visible && onOverflowChange !== undefined);
  useEffect(() => {
    if (!shouldRead || checking || sessionError) return undefined;
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
  }, [shouldRead, workId, attempt, key, cache, checking, sessionError]);
  if (!expanded && onOverflowChange === undefined) return null;
  return (
    <div
      ref={container}
      className={styles.postBody}
      data-feed-post-body-collapsed={!expanded ? "" : undefined}
      data-feed-post-body-state={body.state}
      id={id}
    >
      {body.state === "loaded" ? (
        <p ref={text} className={styles.postBodyText} data-feed-post-body="">
          {body.text}
        </p>
      ) : safePreview === undefined || safePreview === "" ? null : (
        <p ref={text} className={styles.postBodyText} data-card-excerpt="">
          {safePreview}
        </p>
      )}
      {body.state === "loaded" ||
      (!expanded && body.state === "loading") ? null : body.state ===
        "loading" ? (
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
