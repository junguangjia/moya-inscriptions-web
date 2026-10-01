"use client";

import { useState } from "react";
import { SetStepNav } from "@payloadcms/ui";

import { call, describeFailure, formatPreciseTime } from "./api";
import styles from "./community.module.css";

import type {
  OperatorDmConversation,
  OperatorDmMessage,
} from "@moya/contracts/internal/community-operator";

/**
 * content-community-completion-v1: the smallest Owner-only view over private
 * messages. The Owner names one conversation (by id, or by both participant
 * ids) and a purpose; the Backend records every access and removal
 * content-free. There is no browsing, search or export of private messages,
 * and nothing here is reachable by automation or agent principals.
 */
export const DmModerationClient = () => {
  const [conversationId, setConversationId] = useState("");
  const [userA, setUserA] = useState("");
  const [userB, setUserB] = useState("");
  const [purpose, setPurpose] = useState("");
  const [conversation, setConversation] =
    useState<OperatorDmConversation | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (label: string, action: () => Promise<void>) => {
    if (busy) return;
    if (!purpose.trim()) {
      setNotice("请先填写查看或处理的目的；该目的会被记录。");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setNotice(`${label}已完成，并已记录访问目的。`);
    } catch (failure) {
      setNotice(`${label}未执行：${describeFailure(failure).text}`);
    } finally {
      setBusy(false);
    }
  };

  const load = () =>
    run("读取对话", async () => {
      const result = conversationId.trim()
        ? await call<OperatorDmConversation>("read-dm-conversation", {
            id: conversationId.trim(),
            purpose: purpose.trim(),
          })
        : await call<OperatorDmConversation>("lookup-dm-conversation", {
            userIds: [userA.trim(), userB.trim()],
            purpose: purpose.trim(),
          });
      setConversation(result);
    });

  const remove = (message: OperatorDmMessage) =>
    run("移除消息", async () => {
      const removed = await call<OperatorDmMessage>("remove-dm-message", {
        id: message.id,
        requestId: crypto.randomUUID(),
        purpose: purpose.trim(),
      });
      setConversation((current) =>
        current
          ? {
              ...current,
              messages: current.messages.map((m) =>
                m.id === removed.id ? removed : m,
              ),
            }
          : current,
      );
    });

  return (
    <div className={styles.layout} data-community-dm-moderation="">
      <SetStepNav
        nav={[
          { label: "私信处理", url: "/community-moderation/direct-messages" },
        ]}
      />
      <header className={styles.header}>
        <h1>私信处理</h1>
        <p className={styles.lead}>
          仅在明确指定一段对话并写明目的时读取；每次读取与移除都会记录（不含内容）。
          不提供私信浏览、搜索或导出；自动化账号与代理无法使用。
        </p>
      </header>
      {notice && (
        <p role="status" className={styles.notice} data-dm-moderation-notice="">
          {notice}
        </p>
      )}
      <section className={styles.panel} aria-labelledby="dm-select-heading">
        <h2 id="dm-select-heading" className={styles.sectionTitle}>
          指定对话
        </h2>
        <form
          className={styles.settingsForm}
          onSubmit={(event) => {
            event.preventDefault();
            void load();
          }}
        >
          <label>
            对话标识（dm-…）
            <input
              value={conversationId}
              onChange={(event) => setConversationId(event.target.value)}
            />
          </label>
          <p>或按两位参与者的用户标识查找：</p>
          <label>
            用户标识 A
            <input
              value={userA}
              onChange={(event) => setUserA(event.target.value)}
            />
          </label>
          <label>
            用户标识 B
            <input
              value={userB}
              onChange={(event) => setUserB(event.target.value)}
            />
          </label>
          <label>
            目的（必填，将被记录）
            <input
              value={purpose}
              maxLength={500}
              required
              onChange={(event) => setPurpose(event.target.value)}
            />
          </label>
          <div className={styles.actions}>
            <button
              type="submit"
              className={styles.actionButton}
              disabled={
                busy ||
                !purpose.trim() ||
                (!conversationId.trim() && !(userA.trim() && userB.trim()))
              }
            >
              读取
            </button>
          </div>
        </form>
      </section>
      {conversation && (
        <section
          className={styles.panel}
          aria-labelledby="dm-conversation-heading"
          data-dm-moderation-conversation={conversation.id}
        >
          <h2 id="dm-conversation-heading" className={styles.sectionTitle}>
            对话 {conversation.id}
          </h2>
          <p className={styles.mono}>
            {conversation.participants
              .map(
                (p) =>
                  `${p.displayName}（${p.id}，${p.status === "active" ? "正常" : "已停用"}）`,
              )
              .join(" ↔ ")}
            · 状态 {conversation.state === "active" ? "已激活" : "请求中"} ·{" "}
            {conversation.messageCount} 条消息 · 创建于{" "}
            {formatPreciseTime(conversation.createdAt)}
          </p>
          {conversation.messages.length < conversation.messageCount && (
            <p role="status">仅显示最近 {conversation.messages.length} 条。</p>
          )}
          <ul className={styles.links}>
            {conversation.messages.map((message) => (
              <li
                key={message.id}
                className={styles.card}
                data-dm-moderation-message={message.id}
              >
                <p className={styles.summary}>
                  <strong>{message.senderName}</strong>
                  <span className={styles.mono}>
                    #{message.sequence} · {formatPreciseTime(message.createdAt)}
                  </span>
                </p>
                <p className={styles.fullText}>
                  {message.removed ? (
                    <em>已移除（{message.removedBy ?? "operator"}）</em>
                  ) : (
                    message.text
                  )}
                </p>
                {!message.removed && (
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy}
                      onClick={() => void remove(message)}
                    >
                      移除此消息
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};
