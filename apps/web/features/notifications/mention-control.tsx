"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { MentionReference, PublicUserProfile } from "@moya/contracts";
import { normalizeMentionText } from "./mention-data";
import { authorClient } from "../authors/author-data";
import { useNotifications } from "./notification-context";
import styles from "./notifications.module.css";

/** Shared resolved-user picker for comments, publishing and C's Thread composer. */
export function MentionControl({
  text,
  mentions,
  onChange,
  maxLength = 100_000,
  inline = false,
}: {
  text: string;
  mentions: readonly MentionReference[];
  onChange: (text: string, refs: readonly MentionReference[]) => void;
  maxLength?: number;
  /** Inside a comment box: an "@" trigger in the box, the picker above it. */
  inline?: boolean;
}) {
  const enabled = useNotifications().enabled,
    id = useId(),
    trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [people, setPeople] = useState<PublicUserProfile[]>([]),
    [state, setState] = useState(""),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    setPeople([]);
    if (!open || [...query.trim()].length < 2) {
      setState("");
      return;
    }
    const abort = new AbortController();
    setState("正在查找…");
    const timer = setTimeout(() => {
      void authorClient
        .mentionPeople(query.trim(), abort.signal)
        .then((result) => {
          if (abort.signal.aborted) return;
          setPeople(result.items);
          setState(result.items.length ? "" : "没有找到可提醒的用户");
        })
        .catch(() => {
          if (!abort.signal.aborted) setState("查找失败，请重试");
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [open, query, retry]);
  if (!enabled || !authorClient.account()) return null;
  return (
    <div className={inline ? styles.mentionInline : styles.mention}>
      <button
        ref={trigger}
        type="button"
        className={inline ? styles.mentionTrigger : undefined}
        aria-label={inline ? "提醒用户" : undefined}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {inline ? "@" : "@ 提醒用户"}
      </button>
      {open && (
        <div
          id={id}
          className={inline ? styles.mentionPanel : undefined}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setOpen(false);
            trigger.current?.focus();
          }}
        >
          <label>
            查找用户
            <input
              aria-label="查找要提醒的用户"
              value={query}
              maxLength={40}
              onChange={(event) => setQuery(event.currentTarget.value)}
              // Enter searches here; it must not submit the surrounding form.
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
              placeholder="输入至少两个字符"
            />
          </label>
          {state && <p role="status">{state}</p>}
          {state.includes("失败") && (
            <button type="button" onClick={() => setRetry((n) => n + 1)}>
              重试
            </button>
          )}
          <ul aria-label="可提醒的用户">
            {people.map((person) => (
              <li key={person.id}>
                <button
                  type="button"
                  disabled={
                    mentions.length >= 20 ||
                    mentions.some((m) => m.userId === person.id)
                  }
                  onClick={() => {
                    const before = normalizeMentionText(text),
                      prefix = before ? `${before} ` : "",
                      value = `${prefix}@${person.handle}`;
                    if (value.length > maxLength) {
                      setState("正文长度不足，请先缩短文字");
                      return;
                    }
                    onChange(value, [
                      ...mentions,
                      {
                        userId: person.id,
                        handle: person.handle,
                        start: prefix.length,
                        end: value.length,
                      },
                    ]);
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  {person.displayName} <span>@{person.handle}</span>
                </button>
              </li>
            ))}
          </ul>
          <p>
            从列表选择才会提醒；最多 20
            人。编辑或粘贴普通文字不会自动添加收件人。
          </p>
        </div>
      )}
    </div>
  );
}
