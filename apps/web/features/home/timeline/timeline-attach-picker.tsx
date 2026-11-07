"use client";

import { useEffect, useRef, useState } from "react";

import { UNTITLED_WORK_LABEL } from "../../authors/content-card";
import { workCard } from "../../authors/profile-list";
import { requestIdentity } from "../../shell/request-identity";
import {
  readContentTimelineEntry,
  readOwnWorks,
  setWorkTimelineEntry,
} from "./timeline-posts-data";
import styles from "./timeline-posts.module.css";

import type { UserWork } from "@moya/contracts";

type ListState =
  | { readonly state: "loading" }
  | { readonly state: "failed" }
  | {
      readonly state: "ready";
      readonly items: readonly UserWork[];
      readonly total: number;
      readonly page: number;
      readonly more: "idle" | "loading" | "failed";
    };

type Step =
  | { readonly kind: "choose" }
  | { readonly kind: "checking" }
  /** The work is attached elsewhere: moving it is asked first. */
  | { readonly kind: "move"; readonly from: string }
  | { readonly kind: "saving" };

interface Pending {
  readonly workId: string;
  /** Kept for 重试 when an answer was not confirmed (commands are idempotent). */
  readonly requestId: string;
}

const errorText = (error: unknown) =>
  error instanceof Error && error.message !== ""
    ? error.message
    : "暂时无法完成，请重试";

const outcomeUnknown = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { outcomeUnknown?: unknown }).outcomeUnknown === true;

/**
 * 「关联我发过的帖子」 (timeline-posts-v1 §2.2): the viewer's own works as a
 * single-choice list. A work already attached to another entry is moved
 * only after the author confirms 「已在：某词条」. The attachment takes effect
 * at once; the list and the counts read again after it. It opens in place
 * of its button with the focus on its title, so the focus is not dropped to
 * the page.
 */
export const TimelineAttachPicker = ({
  authorId,
  entryId,
  entryTitle,
  onAttached,
  onCancel,
}: {
  readonly authorId: string;
  readonly entryId: string;
  readonly entryTitle: string;
  /** The result to say once the attachment is confirmed. */
  readonly onAttached: (text: string) => void;
  readonly onCancel: () => void;
}) => {
  const [list, setList] = useState<ListState>({ state: "loading" });
  const [revision, setRevision] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [message, setMessage] = useState<{
    readonly tone: "status" | "error";
    readonly text: string;
  } | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<Pending | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  // 关联 gives way to the 「已在」 question and comes back after its 取消;
  // the focus follows, never left on a button that went.
  const confirmRef = useRef<HTMLButtonElement>(null);
  const moveRef = useRef<HTMLParagraphElement>(null);
  const asking = step.kind === "move";
  const askedBefore = useRef(false);
  useEffect(() => {
    if (asking) moveRef.current?.focus();
    else if (askedBefore.current) confirmRef.current?.focus();
    askedBefore.current = asking;
  }, [asking]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let stale = false;
    setList({ state: "loading" });
    readOwnWorks(authorId, 1).then(
      (page) => {
        if (!stale)
          setList({
            state: "ready",
            items: page.items,
            total: page.total,
            page: 1,
            more: "idle",
          });
      },
      () => {
        if (!stale) setList({ state: "failed" });
      },
    );
    return () => {
      stale = true;
    };
  }, [authorId, revision]);

  const more = () => {
    if (list.state !== "ready" || list.more === "loading") return;
    const page = list.page + 1;
    setList({ ...list, more: "loading" });
    readOwnWorks(authorId, page).then(
      (answer) => {
        if (!mounted.current) return;
        setList((current) => {
          if (current.state !== "ready") return current;
          const known = new Set(current.items.map((work) => work.id));
          return {
            state: "ready",
            items: [
              ...current.items,
              ...answer.items.filter((work) => !known.has(work.id)),
            ],
            total: answer.total,
            page,
            more: "idle",
          };
        });
      },
      () => {
        if (mounted.current)
          setList((current) =>
            current.state === "ready"
              ? { ...current, more: "failed" }
              : current,
          );
      },
    );
  };

  const save = async (pending: Pending) => {
    setStep({ kind: "saving" });
    setMessage(null);
    try {
      const result = await setWorkTimelineEntry(pending.workId, {
        requestId: pending.requestId,
        entryId,
      });
      if (!mounted.current) return;
      setUnconfirmed(null);
      setStep({ kind: "choose" });
      // The answer, not the request, decides what is said.
      if (result.entryId === entryId) onAttached("已关联到这个词条");
      else setMessage({ tone: "error", text: "关联未生效，请重试" });
    } catch (error) {
      if (!mounted.current) return;
      setUnconfirmed(outcomeUnknown(error) ? pending : null);
      setStep({ kind: "choose" });
      setMessage({ tone: "error", text: errorText(error) });
    }
  };

  const attach = async () => {
    if (chosen === null || step.kind !== "choose") return;
    const workId = chosen;
    setStep({ kind: "checking" });
    setMessage(null);
    let current: Awaited<ReturnType<typeof readContentTimelineEntry>>;
    try {
      current = await readContentTimelineEntry({ type: "work", id: workId });
    } catch (error) {
      if (!mounted.current) return;
      setStep({ kind: "choose" });
      setMessage({ tone: "error", text: errorText(error) });
      return;
    }
    if (!mounted.current) return;
    if (current?.id === entryId) {
      setStep({ kind: "choose" });
      setMessage({ tone: "status", text: "这篇帖子已关联到这个词条" });
      return;
    }
    if (current !== null) {
      setStep({ kind: "move", from: current.title });
      return;
    }
    await save({ workId, requestId: requestIdentity() });
  };

  const busy = step.kind === "checking" || step.kind === "saving";
  const titleId = `timeline-attach-${entryId}`;

  return (
    <div
      aria-labelledby={titleId}
      className={styles.picker}
      data-timeline-attach-picker=""
      role="group"
    >
      <div className={styles.pickerHead}>
        <h3
          className={styles.pickerTitle}
          id={titleId}
          ref={titleRef}
          tabIndex={-1}
        >
          选择要关联的帖子
        </h3>
        <button className={styles.textAction} onClick={onCancel} type="button">
          取消
        </button>
      </div>
      {list.state === "loading" ? (
        <p className={styles.status} role="status">
          正在载入你的帖子
        </p>
      ) : null}
      {list.state === "failed" ? (
        <div className={styles.row}>
          <p className={styles.status} data-tone="error" role="status">
            你的帖子载入失败
          </p>
          <button
            className={styles.textAction}
            onClick={() => setRevision((value) => value + 1)}
            type="button"
          >
            重试
          </button>
        </div>
      ) : null}
      {list.state === "ready" && list.items.length === 0 ? (
        <p className={styles.status}>发布过的帖子会列在这里。</p>
      ) : null}
      {list.state === "ready" && list.items.length > 0 ? (
        <ul
          aria-labelledby={titleId}
          className={styles.options}
          role="radiogroup"
        >
          {list.items.map((work) => {
            const card = workCard(work);
            const label = work.title === "" ? UNTITLED_WORK_LABEL : work.title;
            const checked = chosen === work.id;
            return (
              <li key={work.id}>
                <button
                  aria-checked={checked}
                  className={styles.option}
                  data-timeline-attach-work={work.id}
                  onClick={() => {
                    if (busy) return;
                    setChosen(work.id);
                    setStep({ kind: "choose" });
                    setMessage(null);
                  }}
                  role="radio"
                  type="button"
                >
                  <span aria-hidden="true" className={styles.optionThumb}>
                    {card.media === null ? null : (
                      <img
                        alt=""
                        decoding="async"
                        loading="lazy"
                        src={card.media.src}
                      />
                    )}
                  </span>
                  <span className={styles.optionText}>
                    <span className={styles.optionTitle}>{label}</span>
                  </span>
                  {checked ? (
                    <span aria-hidden="true" className={styles.optionMark}>
                      已选
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {list.state === "ready" && list.items.length < list.total ? (
        <button
          aria-disabled={list.more === "loading" || undefined}
          className={styles.textAction}
          onClick={more}
          type="button"
        >
          {list.more === "failed" ? "载入失败，重试" : "显示更多"}
        </button>
      ) : null}
      {step.kind === "move" ? (
        <div className={styles.picker} data-timeline-attach-move="">
          <p
            className={styles.status}
            ref={moveRef}
            role="status"
            tabIndex={-1}
          >
            已在：{step.from}。改为关联到「{entryTitle}」？
          </p>
          <div className={styles.actions}>
            <button
              className={styles.primary}
              onClick={() => {
                if (chosen !== null)
                  void save({ workId: chosen, requestId: requestIdentity() });
              }}
              type="button"
            >
              改为关联
            </button>
            <button
              className={styles.secondary}
              onClick={() => setStep({ kind: "choose" })}
              type="button"
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.actions}>
          <button
            aria-disabled={chosen === null || busy || undefined}
            className={styles.primary}
            data-timeline-attach-confirm=""
            onClick={() => void attach()}
            ref={confirmRef}
            type="button"
          >
            {busy ? "正在关联" : "关联"}
          </button>
        </div>
      )}
      {message === null ? null : (
        <p className={styles.status} data-tone={message.tone} role="status">
          {message.text}
        </p>
      )}
      {unconfirmed !== null && step.kind === "choose" ? (
        <button
          className={styles.textAction}
          onClick={() => void save(unconfirmed)}
          type="button"
        >
          重试
        </button>
      ) : null}
    </div>
  );
};
