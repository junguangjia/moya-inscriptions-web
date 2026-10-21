"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { authorClient } from "./author-data";
import { useOptionalAuthors } from "./author-context";
import {
  readWorkSnapshot,
  recordWorkSnapshots,
  useWorkSnapshot,
  workSnapshotToken,
} from "./work-snapshots";
import type { WorkSnapshotToken } from "./work-snapshots";
import styles from "../home/home-screen.module.css";

type BodyState =
  | { readonly state: "loading" }
  | { readonly state: "loaded"; readonly text: string }
  | { readonly state: "error" };

const sameToken = (a: WorkSnapshotToken, b: WorkSnapshotToken) =>
  a.account === b.account &&
  a.epoch === b.epoch &&
  a.generation === b.generation;

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

/** Preview the body immediately; show the full text of a work this account
 * already received (a Works tab list, an earlier body or Detail read), else
 * read visible posts through the existing, account-scoped work endpoint to
 * determine whether three lines overflow. With `onOpen`, the displayed text
 * is covered by a transparent 查看详情 button. */
export const FeedPostBody = ({
  workId,
  expanded,
  id,
  preview,
  onOverflowChange,
  onOpen,
}: {
  readonly workId: string;
  readonly expanded: boolean;
  readonly id: string;
  readonly preview?: string | undefined;
  readonly onOverflowChange?: ((overflow: boolean) => void) | undefined;
  readonly onOpen?:
    ((opener: HTMLButtonElement, pointer: boolean) => void) | undefined;
}) => {
  const author = useOptionalAuthors();
  const key = `work-body:${author?.viewer?.id ?? "guest"}:${workId}`;
  const checking = author?.checking ?? false;
  const sessionError = author?.sessionError ?? false;
  // The work as this account last received it; an unavailable one is read
  // again, so its error and 重试 stay this post's own.
  const known = useWorkSnapshot(workId);
  const knownText = known?.available ? known.text : null;
  // Held, but no longer available to read (an operator hid it): never keep a
  // copied text then; read again, so the post shows its own error and 重试.
  const heldUnavailable = known !== null && !known.available;
  // What this post shows of its own: a copy of the held text, or its read's
  // answer. Loaded text carries whom it was current for and the forget
  // generation it was current at, so text the bounded store merely dropped
  // stays on screen while text something forgot is read again.
  const [snapshot, setSnapshot] = useState<{
    key: string;
    body: BodyState;
    token?: WorkSnapshotToken;
  }>(() => ({ key, body: { state: "loading" } }));
  // Hide the old identity's snapshot in the render that changes identity,
  // before the effect starts its replacement read.
  const body: BodyState = sessionError
    ? { state: "error" }
    : checking
      ? { state: "loading" }
      : knownText !== null
        ? { state: "loaded", text: knownText }
        : snapshot.key !== key
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
  // A layout effect, so text something forgot is replaced before it paints.
  // It looks at `snapshot` as this render shows it; a change to that alone
  // never starts a read.
  useLayoutEffect(() => {
    if (checking || sessionError) return undefined;
    if (knownText !== null) {
      // Copied, so the text stays when the bounded store drops the record.
      const token = workSnapshotToken();
      setSnapshot((previous) =>
        previous.key === key &&
        previous.body.state === "loaded" &&
        previous.body.text === knownText &&
        previous.token !== undefined &&
        sameToken(previous.token, token)
          ? previous
          : { key, body: { state: "loaded", text: knownText }, token },
      );
      return undefined;
    }
    const shown =
      snapshot.key === key && snapshot.body.state === "loaded"
        ? snapshot.token
        : undefined;
    let again = false;
    if (shown !== undefined) {
      // Not held (any more), but shown. It stays, and nothing is read, while
      // the account is the same and nothing was forgotten since it was
      // current: the store only dropped the record to stay bounded.
      const now = workSnapshotToken();
      if (sameToken(shown, now) && !heldUnavailable) return undefined;
      // Something was forgotten since (an edit, a block, a refused Detail
      // read; the store does not say which work). This post reads once more
      // for itself only: recording that answer could push another post's
      // record out and set that post reading too.
      again = shown.generation !== now.generation;
      if (!shouldRead) setSnapshot({ key, body: { state: "loading" } });
    }
    if (!shouldRead) return undefined;
    const controller = new AbortController();
    // Taken before the read: a change of account, or a forget while it
    // runs, keeps its answer out of the snapshots.
    const token = workSnapshotToken();
    setSnapshot({ key, body: { state: "loading" } });
    authorClient
      .work(workId, controller.signal)
      .then((work) => {
        if (controller.signal.aborted) return;
        if (!work.available) {
          setSnapshot({ key, body: { state: "error" } });
          return;
        }
        if (!again && work.id === workId) {
          recordWorkSnapshots([work], token);
          const now = workSnapshotToken();
          // Refused for the same account: the work was forgotten while this
          // read ran, so its answer may predate the change. Read once more.
          if (
            readWorkSnapshot(workId) === null &&
            now.account === token.account &&
            now.epoch === token.epoch
          ) {
            setAttempt((value) => value + 1);
            return;
          }
        }
        setSnapshot({
          key,
          body: { state: "loaded", text: work.text },
          token,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setSnapshot({ key, body: { state: "error" } });
      });
    return () => controller.abort();
  }, [
    shouldRead,
    workId,
    attempt,
    key,
    checking,
    sessionError,
    knownText,
    heldUnavailable,
  ]);
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
      {body.state === "loaded" ||
      (safePreview !== undefined && safePreview !== "") ? (
        // The opener covers only displayed text; the status row stays apart.
        <div className={styles.postBodyFrame}>
          {body.state === "loaded" ? (
            <p
              ref={text}
              className={styles.postBodyText}
              data-feed-post-body=""
              aria-hidden={!expanded ? true : undefined}
            >
              {body.text}
            </p>
          ) : (
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
          {onOpen === undefined || displayedText.trim() === "" ? null : (
            <button
              aria-label="查看详情"
              className={styles.postBodyOpen}
              data-feed-post-body-open=""
              onClick={(event) =>
                onOpen(event.currentTarget, event.detail !== 0)
              }
              type="button"
            />
          )}
        </div>
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
