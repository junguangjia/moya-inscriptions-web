"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ArticleDraft,
  ArticleDraftSummary,
  CreateArticleDraftCommand,
  PublishingMediaItem,
} from "@moya/contracts";
import { useVisualViewportFrame } from "../../publishing/ui/editor/editor-overlay";
import { Icon } from "@moya/ui";
import { authorClient } from "../../../lib/public-api/author-community-client";
import { requestIdentity } from "../../shell/request-identity";
import {
  articleAuthoringClient,
  ArticleRequestError,
  createEmptyArticleDocument,
} from "../../../lib/public-api/article-authoring-client";
import { useAuthors } from "../../authors/author-context";
import { useProductShell } from "../../product-shell/product-shell";
import type { ProductShellEditorOverlayControls } from "../../product-shell/product-shell";
import type { ArticleEditorTarget } from "../../product-shell/product-history";
import detailStyles from "../../detail/catalog-detail.module.css";
import hostStyles from "../../publishing/publishing-entry.module.css";
import styles from "./article-host.module.css";
const Workspace = dynamic(
  () =>
    import("./article-authoring-workspace").then(
      (module) => module.ArticleAuthoringWorkspace,
    ),
  { ssr: false, loading: () => <p role="status">正在加载专题编辑器…</p> },
);
const status = {
  draft: "草稿",
  pending: "审核中",
  published: "已公开",
  withdrawn: "已撤回",
} as const;

export const ArticleAuthoringHost = ({
  target,
  controls,
}: {
  readonly target: ArticleEditorTarget;
  readonly controls: ProductShellEditorOverlayControls;
}) => {
  const author = useAuthors();
  const host = useRef<HTMLElement>(null);
  useVisualViewportFrame(host);
  return (
    <section
      ref={host}
      className={`${detailStyles.experience} ${hostStyles.host} ${styles.host}`}
      role="dialog"
      aria-modal="true"
      aria-label="专题文章与草稿"
      data-article-authoring-host=""
    >
      {author.viewer === null ? (
        <>
          <header className={hostStyles.bar}>
            <button
              type="button"
              ref={controls.backButtonRef}
              onClick={controls.close}
              aria-label="返回"
            >
              <Icon name="back" />
            </button>
          </header>
          <p>
            {author.checking
              ? "正在确认账号…"
              : "登录后可创建、编辑和发布自己的专题文章。"}
          </p>
          {author.checking ? null : <a href={author.signInHref}>登录</a>}
        </>
      ) : (
        <OwnedArticles
          key={author.viewer.id}
          ownerId={author.viewer.id}
          target={target}
          controls={controls}
        />
      )}
    </section>
  );
};
const OwnedArticles = ({
  ownerId,
  target,
  controls,
}: {
  readonly ownerId: string;
  readonly target: ArticleEditorTarget;
  readonly controls: ProductShellEditorOverlayControls;
}) => {
  const shell = useProductShell();
  const author = useAuthors();
  const accountEpoch = authorClient.accountEpoch();
  const accountReady = authorClient.account() === ownerId;
  const [draft, setDraft] = useState<ArticleDraft | null>(null);
  const [items, setItems] = useState<readonly ArticleDraftSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [published, setPublished] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [mediaItems, setMediaItems] = useState<readonly PublishingMediaItem[]>(
    [],
  );
  const [mediaCursor, setMediaCursor] = useState<string | null>(null);
  const [mediaBusy, setMediaBusy] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const epoch = useRef(authorClient.accountEpoch());
  const listRead = useRef(0),
    mediaRead = useRef(0);
  const creation = useRef<CreateArticleDraftCommand | null>(null);
  const writeBusy = useRef(false);
  const liveRead = (abort: AbortController) =>
    !abort.signal.aborted && lifetime.current === abort;
  const current = (abort: AbortController) =>
    liveRead(abort) &&
    authorClient.account() === ownerId &&
    authorClient.accountEpoch() === epoch.current;
  const list = useCallback(
    async (after?: string) => {
      const abort = lifetime.current;
      if (abort === null || !current(abort)) return;
      const read = ++listRead.current;
      setBusy(true);
      try {
        const result = await articleAuthoringClient.list(
          { pageSize: 20, ...(after === undefined ? {} : { cursor: after }) },
          abort.signal,
        );
        if (!current(abort) || read !== listRead.current) return;
        if (result.items.some((item) => item.ownerId !== ownerId))
          throw new Error("article_host_owner_changed");
        setItems((old) =>
          after === undefined
            ? result.items
            : [
                ...new Map(
                  [...old, ...result.items].map((item) => [item.id, item]),
                ).values(),
              ],
        );
        setCursor(result.nextCursor);
      } catch {
        if (liveRead(abort) && read === listRead.current)
          setNotice("暂时无法读取专题草稿，请重试。");
      } finally {
        if (liveRead(abort) && read === listRead.current) setBusy(false);
      }
    },
    [ownerId],
  );
  // Loaded editor input survives same-owner identity failures. Its original
  // epoch remains fenced; only unopened reads restart after confirmation.
  const readEpoch = draft === null ? accountEpoch : epoch.current;
  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    epoch.current = readEpoch;
    setDraft(null);
    setItems([]);
    setCursor(null);
    setNotice(null);
    if (!accountReady) {
      setBusy(false);
      setNotice("账号暂时无法确认，请重新确认后读取专题草稿。");
      return () => abort.abort();
    }
    if (target.type === "article-list") void list();
    else {
      setBusy(true);
      void articleAuthoringClient
        .read(target.id as ArticleDraft["id"], abort.signal)
        .then((value) => {
          if (!current(abort)) return;
          if (value.ownerId !== ownerId || value.id !== target.id)
            throw new Error("article_host_owner_changed");
          setDraft(value);
        })
        .catch(() => {
          if (liveRead(abort))
            setNotice("这份专题草稿不可用或不属于当前账号。");
        })
        .finally(() => {
          if (liveRead(abort)) setBusy(false);
        });
    }
    return () => {
      abort.abort();
      listRead.current++;
      mediaRead.current++;
    };
  }, [
    ownerId,
    readEpoch,
    target.type,
    target.type === "article-draft" ? target.id : "",
    list,
  ]);
  const create = async () => {
    const abort = lifetime.current;
    if (abort === null || !current(abort) || writeBusy.current) return;
    writeBusy.current = true;
    setBusy(true);
    setNotice(null);
    creation.current ??= {
      requestId: requestIdentity(),
      title: "",
      coverRefId: null,
      document: createEmptyArticleDocument(),
    };
    try {
      const value = await articleAuthoringClient.create(
        creation.current,
        abort.signal,
      );
      if (!current(abort)) return;
      if (value.ownerId !== ownerId)
        throw new ArticleRequestError(502, "article_invalid_response", true);
      creation.current = null;
      controls.replaceTarget({ type: "article-draft", id: value.id });
    } catch (error) {
      if (!current(abort)) return;
      const unknown =
        !(error instanceof ArticleRequestError) || error.outcomeUnknown;
      if (!unknown) creation.current = null;
      setNotice(
        unknown
          ? "创建结果尚未确认，重试会确认同一次创建。"
          : "暂时无法创建专题草稿，请重试。",
      );
    } finally {
      writeBusy.current = false;
      if (liveRead(abort)) setBusy(false);
    }
  };
  const readMedia = useCallback(
    async (after?: string) => {
      const abort = lifetime.current;
      if (abort === null || !current(abort)) return;
      const read = ++mediaRead.current;
      setMediaBusy(true);
      try {
        const page = await articleAuthoringClient.ownMedia(
          { pageSize: 20, ...(after === undefined ? {} : { cursor: after }) },
          abort.signal,
        );
        if (!current(abort) || read !== mediaRead.current) return;
        setMediaItems((old) =>
          after === undefined
            ? page.items
            : [
                ...new Map(
                  [...old, ...page.items].map((item) => [item.id, item]),
                ).values(),
              ],
        );
        setMediaCursor(page.nextCursor);
      } catch (error) {
        if (current(abort) && read === mediaRead.current)
          setNotice("账号素材暂时无法读取，请重试。");
        throw error;
      } finally {
        if (current(abort) && read === mediaRead.current) setMediaBusy(false);
      }
    },
    [ownerId],
  );
  const identityNotice =
    !accountReady || accountEpoch !== epoch.current ? (
      <p role="alert">
        账号验证发生变化，当前输入仍保留。请重新确认账号；已打开的编辑器需要在原账号中重新打开。
        <button
          type="button"
          disabled={author.checking}
          onClick={() => void author.refresh()}
        >
          重新确认账号
        </button>
      </p>
    ) : null;
  if (draft !== null)
    return (
      <>
        {identityNotice}
        <Workspace
          initial={draft}
          sessionKey={`${ownerId}:${epoch.current}:${draft.id}:${reload}`}
          accountEpoch={epoch.current}
          layout={shell.platform === "phone" ? "phone" : "desktop"}
          mediaItems={mediaItems}
          mediaLoading={mediaBusy}
          mediaHasMore={mediaCursor !== null}
          reloadMedia={() => readMedia()}
          loadMoreMedia={() =>
            mediaCursor === null ? Promise.resolve() : readMedia(mediaCursor)
          }
          covered={false}
          backButtonRef={controls.backButtonRef}
          registerLeaveGuard={controls.registerLeaveGuard}
          onBack={controls.close}
          onPublished={(id) => {
            setPublished(id);
            controls.replaceTarget({ type: "article-list" });
          }}
          onReloadDraft={(remote) => {
            if (remote.ownerId === ownerId) {
              setDraft(remote);
              setReload((value) => value + 1);
            }
          }}
          onOpenCatalog={(id) =>
            window.open(
              `/?catalogId=${encodeURIComponent(id)}#detail`,
              "_blank",
              "noopener,noreferrer",
            )
          }
        />
      </>
    );
  return (
    <>
      <header className={`${detailStyles.detailHeader} ${hostStyles.bar}`}>
        <button
          ref={controls.backButtonRef}
          type="button"
          aria-label="返回"
          onClick={controls.close}
        >
          <Icon name="back" />
        </button>
        <strong>专题文章与草稿</strong>
      </header>
      <div className={styles.list} aria-busy={busy}>
        {identityNotice}
        {notice === null ? null : <p role="status">{notice}</p>}
        {published === null ? null : (
          <p role="status">
            专题已公开。
            <a
              href={`/?topic=${encodeURIComponent(published)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              查看公开文章
            </a>
          </p>
        )}
        {target.type === "article-list" ? (
          <>
            <button type="button" disabled={busy} onClick={() => void create()}>
              {creation.current === null ? "新建专题文章" : "重试确认创建"}
            </button>
            {busy && items.length === 0 ? (
              <p role="status">正在读取专题草稿…</p>
            ) : null}
            {!busy && items.length === 0 ? <p>还没有专题草稿。</p> : null}
            <ul>
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      controls.replaceTarget({
                        type: "article-draft",
                        id: item.id,
                      })
                    }
                  >
                    <strong>{item.title || "未命名专题"}</strong>
                    <span>
                      {status[item.status]} · 版本 {item.version}
                    </span>
                  </button>
                  {item.publicVersion === null ? null : (
                    <a
                      target="_blank"
                      rel="noopener noreferrer"
                      href={`/?topic=${encodeURIComponent(item.id)}`}
                    >
                      公开版本
                    </a>
                  )}
                </li>
              ))}
            </ul>
            <button type="button" disabled={busy} onClick={() => void list()}>
              刷新草稿
            </button>
            {cursor === null ? null : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void list(cursor)}
              >
                加载更多草稿
              </button>
            )}
          </>
        ) : busy ? (
          <p role="status">正在读取专题草稿…</p>
        ) : (
          <button
            type="button"
            onClick={() => controls.replaceTarget({ type: "article-list" })}
          >
            返回草稿列表
          </button>
        )}
      </div>
    </>
  );
};
