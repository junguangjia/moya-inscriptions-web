"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { authorClient } from "./author-data";
import { useOptionalAuthors } from "./author-context";
import styles from "../home/home-screen.module.css";

type BodyState =
  | { readonly state: "loading" }
  | { readonly state: "loaded"; readonly text: string }
  | { readonly state: "error" };

/** Range offsets use UTF-16; slice only at complete Unicode code points. */
const collapsedOpening = (
  value: string,
  element?: HTMLParagraphElement,
  lineHeight?: number,
) => {
  if (value === "") return "";
  const characters = Array.from(value);
  let count = Math.min(160, characters.length - 1);
  const node = element?.firstChild;
  if (
    element !== undefined &&
    node?.nodeType === Node.TEXT_NODE &&
    lineHeight !== undefined
  ) {
    const range = document.createRange();
    if (typeof range.getBoundingClientRect === "function") {
      const offsets = [0];
      for (const character of characters)
        offsets.push(offsets[offsets.length - 1]! + character.length);
      const bottom = element.getBoundingClientRect().top + lineHeight * 3 + 1;
      let low = 0;
      let high = characters.length;
      range.setStart(node, 0);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        range.setEnd(node, offsets[middle]!);
        if (range.getBoundingClientRect().bottom <= bottom) low = middle;
        else high = middle - 1;
      }
      count = Math.min(count, low);
    }
  }
  return `${characters.slice(0, count).join("").trimEnd()}…`;
};

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
  const [measurement, setMeasurement] = useState<{
    readonly key: string;
    readonly text: string;
    readonly overflow: boolean;
    readonly opening: string;
  }>();
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
      if (
        displayedText === "" ||
        (Number.isFinite(lineHeight) &&
          lineHeight > 0 &&
          element.clientWidth > 0 &&
          element.scrollHeight > 0)
      ) {
        const overflow =
          displayedText !== "" && element.scrollHeight > lineHeight * 3 + 1;
        const opening = overflow
          ? collapsedOpening(displayedText, element, lineHeight)
          : displayedText;
        setMeasurement((previous) =>
          previous?.key === key &&
          previous.text === displayedText &&
          previous.overflow === overflow &&
          previous.opening === opening
            ? previous
            : { key, text: displayedText, overflow, opening },
        );
        onOverflowChange(overflow);
      }
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
  }, [key, displayedText, body.state, expanded, onOverflowChange]);
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
  // CSS clipping does not shorten the accessibility tree. Keep the full text
  // for accurate visual measurement, but expose only an opening when collapsed.
  const accessibleText =
    measurement?.key === key && measurement.text === displayedText
      ? measurement.opening
      : collapsedOpening(displayedText);
  return (
    <div
      ref={container}
      className={styles.postBody}
      data-feed-post-body-collapsed={!expanded ? "" : undefined}
      data-feed-post-body-state={body.state}
      id={id}
    >
      {body.state === "loaded" ? (
        <p
          ref={text}
          className={styles.postBodyText}
          data-feed-post-body=""
          aria-hidden={!expanded ? true : undefined}
        >
          {body.text}
        </p>
      ) : safePreview === undefined || safePreview === "" ? null : (
        <p
          ref={text}
          className={styles.postBodyText}
          data-card-excerpt=""
          aria-hidden={!expanded ? true : undefined}
        >
          {safePreview}
        </p>
      )}
      {!expanded && accessibleText !== "" ? (
        <p className="yoyi-visually-hidden">{accessibleText}</p>
      ) : null}
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
