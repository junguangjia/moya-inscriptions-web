"use client";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type {
  ArticleApprovalCandidate,
  ArticleApprovalReview,
  ArticleConsentReview,
  ArticleAuthoringGrant,
} from "@moya/contracts";
import { articleDelegationClient } from "../../../lib/public-api/article-delegation-client";
import { useAuthors } from "../../authors/author-context";
import { authorClient } from "../../../lib/public-api/author-community-client";
import { requestIdentity } from "../../shell/request-identity";
import { createArticleConsentAttempt } from "./article-consent-attempt";
import styles from "../../auth/account-security.module.css";

const failure = "账户、候选版本或授权已变化，请重新读取后再试。";
const accountReady = (checking: boolean, id: string | undefined) =>
  !checking && id !== undefined;

/** Human identity comes from the existing AuthorProvider; no new login or cookie. */
export const ArticleAgentConsent = ({
  interactionUid,
}: {
  readonly interactionUid: string;
}) => {
  const author = useAuthors();
  if (author.viewer === null)
    return <p>请先登录当前作者账户，再查看客户端授权。</p>;
  return (
    <ArticleAccountConsent
      key={`${author.viewer.id}:${authorClient.accountEpoch()}:${interactionUid}`}
      interactionUid={interactionUid}
      author={author}
      ownerId={author.viewer.id}
    />
  );
};

const ArticleAccountConsent = ({
  interactionUid,
  ownerId,
  author,
}: {
  readonly interactionUid: string;
  readonly ownerId: string;
  readonly author: ReturnType<typeof useAuthors>;
}) => {
  const [review, setReview] = useState<ArticleConsentReview | null>(null);
  const [permitPublish, setPermitPublish] = useState(false);
  const [busy, setBusy] = useState(false),
    [note, setNote] = useState("");
  const [attempt, setAttempt] = useState<ReturnType<
    typeof createArticleConsentAttempt
  > | null>(null);
  useEffect(() => {
    const next = createArticleConsentAttempt({
      ownerId,
      interactionUid,
      currentAccount: authorClient.account,
      accountEpoch: authorClient.accountEpoch,
      requestId: () => requestIdentity(),
      decide: articleDelegationClient.decide,
    });
    setAttempt(next);
    return () => next.dispose();
  }, [ownerId, interactionUid]);
  useEffect(() => {
    // Account revalidation retains its epoch and any unknown one-use decision.
    // A fresh review ticket must not replace a receipt awaiting its answer.
    if (author.checking || attempt === null || attempt.pending() !== null)
      return;
    setReview(null);
    setPermitPublish(false);
    setNote("");
    const controller = new AbortController();
    void articleDelegationClient
      .consent(interactionUid, controller.signal)
      .then((value) => {
        if (
          !controller.signal.aborted &&
          attempt.isCurrent() &&
          value.interactionUid === interactionUid
        )
          setReview(value);
      })
      .catch(() => {
        if (!controller.signal.aborted && attempt.isCurrent()) setNote(failure);
      });
    return () => controller.abort();
  }, [author.checking, interactionUid, attempt]);
  const decide = async (decision: "approve" | "deny") => {
    if (
      review === null ||
      attempt === null ||
      busy ||
      author.checking ||
      !attempt.isCurrent()
    )
      return;
    setBusy(true);
    setNote("");
    try {
      const result = await attempt.submit(decision, review);
      if (attempt.isCurrent()) window.location.assign(result.resumeUrl);
    } catch {
      if (attempt.isCurrent()) {
        setNote(
          attempt.unconfirmed()
            ? "授权决定的结果尚未确认，请重试同一决定以继续。"
            : failure,
        );
        setBusy(false);
      }
    }
  };
  if (author.checking) return <p>正在确认当前作者账户…</p>;
  const pending = attempt?.pending() ?? null;
  return (
    <section
      className={styles.panel}
      aria-label="授权文章助手"
      aria-busy={busy}
    >
      <h1>授权文章助手</h1>
      <p>当前作者：{author.viewer?.displayName}</p>
      {review === null ? (
        <p>{note || "正在读取授权请求…"}</p>
      ) : (
        <>
          <h2>{review.clientLabel}</h2>
          <p className={styles.muted}>{review.clientId}</p>
          <p>允许读取和编辑你拥有的文章草稿，以及查看你选择的可用媒体。</p>
          {review.scopes.includes("artvenn:article:publish") && (
            <label className={styles.field}>
              <span>
                <input
                  type="checkbox"
                  checked={permitPublish}
                  onChange={(event) => setPermitPublish(event.target.checked)}
                  disabled={busy || pending !== null}
                />
                我另外允许此助手请求发布。每个候选版本仍需我在平台预览后单独批准。
              </span>
            </label>
          )}
          <p className={styles.muted}>
            有效请求截止：{new Date(review.expiresAt).toLocaleString()}。
            你可以在连接设置中随时撤销。
          </p>
          <div className={styles.actions}>
            {pending !== null ? (
              <button
                type="button"
                onClick={() => void decide(pending.decision)}
                disabled={busy}
              >
                重试上次{pending.decision === "approve" ? "同意" : "拒绝"}决定
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void decide("approve")}
                  disabled={
                    busy ||
                    (review.scopes.includes("artvenn:article:publish") &&
                      !permitPublish)
                  }
                >
                  同意这些权限
                </button>
                <button
                  type="button"
                  onClick={() => void decide("deny")}
                  disabled={busy}
                >
                  拒绝
                </button>
              </>
            )}
          </div>
          {note && <p role="alert">{note}</p>}
        </>
      )}
    </section>
  );
};

/** Render with the SAME Article reader/authorized media renderer as the editor. */
export const ArticleAgentApproval = ({
  candidate,
  renderPreview,
}: {
  readonly candidate: ArticleApprovalCandidate;
  readonly renderPreview: (
    review: ArticleApprovalReview["preview"],
  ) => ReactNode;
}) => {
  const author = useAuthors();
  const [review, setReview] = useState<ArticleApprovalReview | null>(null);
  const [busy, setBusy] = useState(false),
    [note, setNote] = useState("");
  const [approved, setApproved] = useState(false);
  const identity = JSON.stringify(candidate);
  useEffect(() => {
    setReview(null);
    setApproved(false);
    setNote("");
    if (!accountReady(author.checking, author.viewer?.id)) return;
    const controller = new AbortController();
    void articleDelegationClient
      .review(JSON.parse(identity), controller.signal)
      .then(setReview)
      .catch(() => {
        if (!controller.signal.aborted) setNote(failure);
      });
    return () => controller.abort();
  }, [author.checking, author.viewer?.id, identity]);
  const approve = async () => {
    if (review === null || busy || approved) return;
    setBusy(true);
    setNote("");
    try {
      await articleDelegationClient.approve({
        ...candidate,
        requestId: requestIdentity(),
        reviewTicket: review.reviewTicket,
      });
      setApproved(true);
      setReview(null);
      setNote(
        "已批准这个候选版本。助手现在可以提交发布；后续改动需要重新批准。",
      );
    } catch {
      setNote(failure);
      setReview(null);
    } finally {
      setBusy(false);
    }
  };
  if (!accountReady(author.checking, author.viewer?.id))
    return <p>请先登录文章所属作者账户，再查看候选内容。</p>;
  return (
    <section
      className={styles.panel}
      aria-label="确认助手发布候选"
      aria-busy={busy}
    >
      <h1>确认发布候选</h1>
      <p>当前作者：{author.viewer?.displayName}</p>
      {review && (
        <>
          <p>
            助手：{review.connection.clientId}；候选版本：
            {review.preview.draft.version}
          </p>
          <p>
            {review.publishedVersion === null
              ? "这是首次发布。"
              : `与已公开版本 ${review.publishedVersion} 比较：`}
            新增 {review.changes.addedBlocks} 个块，删除{" "}
            {review.changes.removedBlocks} 个块，修改{" "}
            {review.changes.changedBlocks} 个块。
          </p>
          <p>
            {review.changes.titleChanged && "标题已变更。"}
            {review.changes.coverChanged && "封面已变更。"}
            {review.changes.referencesChanged && "图片引用已变更。"}
            {review.changes.galleriesChanged && "图片组已变更。"}
          </p>
          {renderPreview(review.preview)}
          <button
            type="button"
            className={styles.primary}
            disabled={busy || approved || !review.preview.validation.valid}
            onClick={() => void approve()}
          >
            我已检查预览，批准这个版本
          </button>
        </>
      )}
      {!review && !note && <p>正在读取候选预览…</p>}
      {note && <p role="status">{note}</p>}
    </section>
  );
};

export const ArticleAgentConnections = () => {
  const author = useAuthors();
  const [items, setItems] = useState<ArticleAuthoringGrant[]>([]),
    [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () =>
    articleDelegationClient.connections().then((page) => setItems(page.items));
  useEffect(() => {
    setItems([]);
    setNote("");
    if (accountReady(author.checking, author.viewer?.id))
      void load().catch(() => setNote(failure));
  }, [author.checking, author.viewer?.id]);
  const revoke = async (item: ArticleAuthoringGrant) => {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      await articleDelegationClient.revoke(item.id, {
        requestId: requestIdentity(),
        expectedGeneration: item.generation,
      });
      await load();
      setNote("已撤销。此连接后续的草稿访问和发布请求会被拒绝。");
    } catch {
      setNote(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className={styles.panel}
      aria-label="文章助手连接"
      aria-busy={busy}
    >
      <h2>文章助手连接</h2>
      {items.map((item) => (
        <div className={styles.row} key={item.id}>
          <div className={styles.detail}>
            <strong>{item.clientId}</strong>
            <span>
              {item.scopes.includes("artvenn:article:publish")
                ? "草稿与逐候选发布"
                : "草稿读写"}
            </span>
            <span>{item.status === "revoked" ? "已撤销" : "已授权"}</span>
          </div>
          <button
            type="button"
            disabled={busy || item.status === "revoked"}
            onClick={() => void revoke(item)}
          >
            撤销连接
          </button>
        </div>
      ))}
      {note && <p role="status">{note}</p>}
    </section>
  );
};
