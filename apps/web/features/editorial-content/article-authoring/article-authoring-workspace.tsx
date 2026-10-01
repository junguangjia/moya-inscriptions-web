"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  ArticleMediaReference,
  CatalogId,
  CatalogPage,
  PublishingMediaItem,
} from "@moya/contracts";
import { authorClient } from "../../../lib/public-api/author-community-client";
import {
  articleAuthoringClient,
  articleAuthoringLimits,
} from "../../../lib/public-api/article-authoring-client";
import { fetchSameOriginCatalogDetail } from "../../../lib/public-api/catalog-detail-client";
import { publishingClient } from "../../../lib/public-api/work-publishing-client";
import { fetchSameOriginCatalogPage } from "../../../lib/public-api/catalog-list-client";
import { createExternalStore } from "../../publishing/upload-manager-store";
import type {
  UploadManagerSnapshot,
  UploadItemView,
} from "../../publishing/upload-manager";
import {
  addToStagingBatch,
  attachStagedCounterpart,
  confirmStaging,
  countStaging,
  identifyFile,
  identifyFiles,
  keepStagedStillAsPhoto,
  removeStagedEntry,
  resolveStagedAmbiguity,
  setBatchOriginal,
} from "../../publishing/import-grouping";
import type {
  FileOrigin,
  StagingBatch,
} from "../../publishing/import-grouping";
import { EditorDialog } from "../../publishing/ui/editor/editor-dialog";
import { MediaPicker } from "../../publishing/ui/media/media-picker";
import { StagedChoices } from "../../publishing/ui/media/staged-choices";
import { itemStatus, retryPlan } from "../../publishing/ui/media/media-status";
import { ArticleAuthoringBoundary } from "./article-authoring-boundary";
import {
  ArticleCatalogReference,
  ArticleReferencedMedia,
} from "./article-managed-media";
import { createArticleMediaResolver } from "./article-media-resolver";
import type { ArticleMediaResolver } from "./article-media-resolver";
import { createArticleUploadSession } from "./article-upload-session";
import type { ArticleUploadSession } from "./article-upload-session";
import type { ArticleEditorProps } from "./article-editor-props";
import type { ArticleMediaBridge } from "./article-attachments";
import styles from "./article-media.module.css";

/** The caller uses the canonical bounded own-media page and account-fenced HTTP client. */
export interface ArticleAuthoringWorkspaceProps extends Pick<
  ArticleEditorProps,
  | "sessionKey"
  | "initial"
  | "onBack"
  | "onPublished"
  | "onReloadDraft"
  | "backButtonRef"
  | "registerLeaveGuard"
> {
  readonly layout: "phone" | "desktop";
  readonly mediaItems: readonly PublishingMediaItem[];
  readonly mediaLoading: boolean;
  readonly mediaHasMore: boolean;
  readonly reloadMedia: () => Promise<void>;
  readonly loadMoreMedia: () => Promise<void>;
  readonly covered?: boolean;
  readonly onOpenCatalog: (id: CatalogId) => void;
}
interface ImageChoice {
  readonly multiple: boolean;
  readonly resolve: (references: readonly ArticleMediaReference[]) => void;
  readonly signal: AbortSignal;
}
interface CatalogChoice {
  readonly resolve: (id: CatalogId | null) => void;
  readonly signal: AbortSignal;
}

export const ArticleAuthoringWorkspace = (
  props: ArticleAuthoringWorkspaceProps,
) => {
  const [uploadResource, setUploadResource] = useState<{
    readonly sessionKey: string;
    readonly session: ArticleUploadSession;
  } | null>(null);
  const uploads =
    uploadResource?.sessionKey === props.sessionKey
      ? uploadResource.session
      : null;
  // Freeze the loaded editor session. Account-fenced ports invalidate writes
  // without replacing local input after a transient identity-check failure.
  const [epoch] = useState(() => authorClient.accountEpoch());
  const [resolverResource, setResolverResource] = useState<{
    readonly sessionKey: string;
    readonly epoch: number;
    readonly resolver: ArticleMediaResolver;
  } | null>(null);
  const resolver =
    resolverResource?.sessionKey === props.sessionKey &&
    resolverResource.epoch === epoch
      ? resolverResource.resolver
      : null;
  const readyRef = useRef<ReadonlyMap<string, PublishingMediaItem>>(new Map());
  const [choice, setChoice] = useState<ImageChoice | null>(null);
  const [catalogChoice, setCatalogChoice] = useState<CatalogChoice | null>(
    null,
  );
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [batch, setBatch] = useState<StagingBatch | null>(null);
  const [identifying, setIdentifying] = useState(0);
  const [maxUploads, setMaxUploads] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [catalogPage, setCatalogPage] = useState<CatalogPage | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const choiceRef = useRef<ImageChoice | null>(null);
  const catalogChoiceRef = useRef<CatalogChoice | null>(null);
  const epochRef = useRef(epoch);
  const batchRef = useRef<StagingBatch | null>(null);
  const sessionGeneration = useRef(0);
  const batchRevision = useRef(0);
  const identificationOperation = useRef(0);
  const lifetime = useRef<AbortController | null>(null);
  const catalogRead = useRef<AbortController | null>(null);
  batchRef.current = batch;
  const [empty] = useState(() =>
    createExternalStore<UploadManagerSnapshot>({
      accountId: props.initial.ownerId,
      status: "paused",
      pauseReason: null,
      items: [],
    }),
  );
  const store = uploads?.manager.store ?? empty;
  const uploadState = useSyncExternalStore(
    store.subscribe,
    store.get,
    store.get,
  );
  const ready = useMemo(() => {
    const items = new Map(props.mediaItems.map((item) => [item.id, item]));
    for (const item of uploadState.items)
      if (item.phase === "ready" && item.serverItem !== null)
        items.set(item.serverItem.id, item.serverItem);
    return items;
  }, [props.mediaItems, uploadState.items]);
  readyRef.current = ready;
  useEffect(() => {
    resolver?.refreshReady();
  }, [resolver, ready]);
  const sameAccount = () =>
    authorClient.account() === props.initial.ownerId &&
    authorClient.accountEpoch() === epochRef.current;
  const reportFailure = () => {
    if (!lifetime.current?.signal.aborted)
      setMessage("暂时无法读取或上传素材，请重试。");
  };
  const finishImages = (references: readonly ArticleMediaReference[]) => {
    choiceRef.current?.resolve(references);
    choiceRef.current = null;
    setChoice(null);
    setSelected([]);
    batchRevision.current++;
    identificationOperation.current++;
    batchRef.current = null;
    setBatch(null);
    setIdentifying(0);
  };
  const finishCatalog = (id: CatalogId | null) => {
    catalogChoiceRef.current?.resolve(id);
    catalogChoiceRef.current = null;
    setCatalogChoice(null);
    catalogRead.current?.abort();
  };
  useEffect(() => {
    const abort = new AbortController();
    sessionGeneration.current++;
    batchRevision.current++;
    identificationOperation.current++;
    setIdentifying(0);
    lifetime.current = abort;
    if (!sameAccount()) return () => abort.abort();
    const session = createArticleUploadSession(props.initial.ownerId);
    const mediaResolver = createArticleMediaResolver({
      ownerId: props.initial.ownerId,
      epoch,
      account: authorClient.account,
      accountEpoch: authorClient.accountEpoch,
      readyItems: () => readyRef.current,
      readManaged: (id, signal) => publishingClient.item(id, signal),
      readCatalog: async (id, signal) => {
        const result = await fetchSameOriginCatalogDetail(id, signal);
        return result.state === "success" ? result.detail : null;
      },
    });
    setResolverResource({
      sessionKey: props.sessionKey,
      epoch,
      resolver: mediaResolver,
    });
    setUploadResource({ sessionKey: props.sessionKey, session });
    setMaxUploads(null);
    setChoice(null);
    setCatalogChoice(null);
    setSelected([]);
    setBatch(null);
    batchRef.current = null;
    batchRevision.current++;
    setMessage(null);
    void session
      .limits()
      .then((limits) => {
        if (!abort.signal.aborted)
          setMaxUploads(
            Math.min(limits.maxItems, articleAuthoringLimits.galleryImages),
          );
      })
      .catch(() => {
        if (!abort.signal.aborted && lifetime.current === abort)
          reportFailure();
      });
    return () => {
      sessionGeneration.current++;
      abort.abort();
      catalogRead.current?.abort();
      mediaResolver.dispose();
      session.manager.release();
      session.dispose();
      choiceRef.current?.resolve([]);
      catalogChoiceRef.current?.resolve(null);
      choiceRef.current = null;
      catalogChoiceRef.current = null;
    };
  }, [props.initial.ownerId, props.sessionKey, epoch]);
  const currentEpoch = authorClient.accountEpoch();
  useEffect(() => {
    if (sameAccount()) return;
    finishImages([]);
    finishCatalog(null);
  }, [currentEpoch]);
  const loadCatalog = async (page: number) => {
    catalogRead.current?.abort();
    const abort = new AbortController();
    catalogRead.current = abort;
    setCatalogLoading(true);
    try {
      const result = await fetchSameOriginCatalogPage(
        { page: String(page), pageSize: "20" },
        abort.signal,
      );
      if (abort.signal.aborted || !sameAccount()) return;
      if (result.state === "success") setCatalogPage(result.page);
      else reportFailure();
    } catch {
      if (!abort.signal.aborted) reportFailure();
    } finally {
      if (!abort.signal.aborted) setCatalogLoading(false);
    }
  };
  const media = useMemo<ArticleMediaBridge>(
    () => ({
      choose: ({ multiple, signal }) => {
        if (signal.aborted || !sameAccount()) return Promise.resolve([]);
        finishImages([]);
        setMessage(null);
        setSelected([]);
        void props.reloadMedia().catch(reportFailure);
        return new Promise((resolve) => {
          const onAbort = () => {
            if (choiceRef.current === pending) finishImages([]);
          };
          const pending = {
            multiple,
            signal,
            resolve: (references: readonly ArticleMediaReference[]) => {
              signal.removeEventListener("abort", onAbort);
              resolve(references);
            },
          };
          choiceRef.current = pending;
          setChoice(pending);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
      },
      chooseCatalog: (signal) => {
        if (signal.aborted || !sameAccount()) return Promise.resolve(null);
        catalogChoiceRef.current?.resolve(null);
        setMessage(null);
        setCatalogPage(null);
        void loadCatalog(1);
        return new Promise((resolve) => {
          const onAbort = () => {
            if (catalogChoiceRef.current === pending) finishCatalog(null);
          };
          const pending = {
            signal,
            resolve: (id: CatalogId | null) => {
              signal.removeEventListener("abort", onAbort);
              resolve(id);
            },
          };
          catalogChoiceRef.current = pending;
          setCatalogChoice(pending);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
      },
      render: (reference, { alt, active }) =>
        resolver === null ? (
          <p role="status">正在准备素材…</p>
        ) : (
          <ArticleReferencedMedia
            resolver={resolver}
            reference={reference}
            alt={alt}
            active={
              active !== false &&
              choice === null &&
              catalogChoice === null &&
              props.covered !== true
            }
          />
        ),
      renderCatalog: (id) =>
        resolver === null ? (
          <p role="status">正在准备素材…</p>
        ) : (
          <ArticleCatalogReference
            resolver={resolver}
            id={id}
            onOpen={props.onOpenCatalog}
          />
        ),
    }),
    [
      resolver,
      props.initial.ownerId,
      props.sessionKey,
      props.reloadMedia,
      props.onOpenCatalog,
      props.covered,
      choice,
      catalogChoice,
    ],
  );
  const client = useMemo<ArticleEditorProps["client"]>(
    () => ({
      ...articleAuthoringClient,
      save: async (id, command, signal) => {
        const saved = await articleAuthoringClient.save(id, command, signal);
        // Cleanup is not part of the acknowledged content write. The manager
        // checks durable Article refs before dropping temporary upload refs.
        if (uploads !== null)
          void uploads.releaseCommittedUploads(saved).catch(reportFailure);
        return saved;
      },
    }),
    [uploads],
  );
  const activeCount = uploadState.items.filter(
    (item) => item.phase !== "cancelled" && item.phase !== "cleanup",
  ).length;
  const stage = async (files: File[], origin: FileOrigin) => {
    if (
      uploads === null ||
      maxUploads === null ||
      identifying !== 0 ||
      !sameAccount()
    )
      return;
    if (files.length > maxUploads || activeCount >= maxUploads) {
      setMessage(`本次最多上传 ${maxUploads} 项素材，请减少选择。`);
      return;
    }
    const abort = lifetime.current!;
    const generation = sessionGeneration.current;
    const revision = batchRevision.current;
    const operation = ++identificationOperation.current;
    const startingBatch = batchRef.current;
    setIdentifying(files.length);
    setMessage(null);
    try {
      const identified = await identifyFiles(files);
      if (
        abort.signal.aborted ||
        !sameAccount() ||
        generation !== sessionGeneration.current ||
        revision !== batchRevision.current ||
        startingBatch !== batchRef.current
      )
        return;
      const next = addToStagingBatch(startingBatch, identified, origin);
      if (
        next.entries.length > maxUploads ||
        !countStaging(next, activeCount, maxUploads).withinLimit
      ) {
        setMessage(`本次最多上传 ${maxUploads} 项素材，请减少选择。`);
        return;
      }
      batchRevision.current++;
      batchRef.current = next;
      setBatch(next);
    } catch {
      if (!abort.signal.aborted) reportFailure();
    } finally {
      if (
        !abort.signal.aborted &&
        generation === sessionGeneration.current &&
        operation === identificationOperation.current
      )
        setIdentifying(0);
    }
  };
  const updateBatch = (next: StagingBatch | null) => {
    batchRevision.current++;
    batchRef.current = next;
    setBatch(next);
    setMessage(null);
  };
  const confirmUploads = () => {
    if (uploads === null || batch === null || maxUploads === null) return;
    const result = confirmStaging(batch, activeCount, maxUploads);
    if (!result.ok) {
      setMessage(
        result.error === "items_limit"
          ? `本次最多上传 ${maxUploads} 项素材。`
          : "请先完成素材配对或选择。",
      );
      return;
    }
    uploads.manager.addConfirmed(result.confirmed);
    updateBatch(result.remaining);
  };
  const retry = (item: UploadItemView) => {
    if (uploads === null) return;
    const plan = retryPlan(item);
    if (plan?.type === "registration")
      uploads.manager.retryRegistration(item.key);
    else if (plan?.type === "processing")
      void uploads.manager.retryProcessing(item.key).catch(reportFailure);
    else if (plan?.type === "components")
      void Promise.all(
        plan.roles.map((role) =>
          uploads.manager.retryComponent(item.key, role),
        ),
      ).catch(reportFailure);
  };
  const chooseItem = (item: PublishingMediaItem) => {
    if (choice === null || item.state !== "ready" || item.media === null)
      return;
    if (!choice.multiple) setSelected([item.id]);
    else
      setSelected((current) =>
        current.includes(item.id)
          ? current.filter((id) => id !== item.id)
          : current.length >= articleAuthoringLimits.galleryImages
            ? current
            : [...current, item.id],
      );
  };
  const confirmImages = () => {
    if (!sameAccount()) {
      finishImages([]);
      return;
    }
    const references = selected.flatMap((id): ArticleMediaReference[] => {
      const item = ready.get(id);
      return item?.state === "ready" && item.media !== null
        ? [{ type: "managed", itemId: item.id }]
        : [];
    });
    if (references.length !== selected.length) {
      setMessage("部分素材已不可用，请重新选择。");
      return;
    }
    finishImages(references);
  };
  const close = () => {
    if (uploads === null || !sameAccount()) {
      uploads?.manager.release();
      uploads?.dispose();
      resolver?.dispose();
      props.onBack();
      return;
    }
    void uploads
      .discard()
      .then(() => {
        resolver?.dispose();
        props.onBack();
      })
      .catch(reportFailure);
  };
  return (
    <div className={styles.workspace}>
      <div>
        {message === null ? null : (
          <p className={styles.message} role="status">
            {message}
          </p>
        )}
      </div>
      {uploads === null || resolver === null ? (
        <p role="status">正在准备专题素材…</p>
      ) : (
        <ArticleAuthoringBoundary
          active
          initial={props.initial}
          sessionKey={props.sessionKey}
          accountEpoch={epoch}
          client={client}
          {...(props.backButtonRef === undefined
            ? {}
            : { backButtonRef: props.backButtonRef })}
          {...(props.registerLeaveGuard === undefined
            ? {}
            : { registerLeaveGuard: props.registerLeaveGuard })}
          media={media}
          onBack={close}
          onReloadDraft={props.onReloadDraft}
          onPublished={(id) => {
            if (uploads === null) props.onPublished(id);
            else
              void uploads
                .discard()
                .catch(() => undefined)
                .finally(() => {
                  resolver.dispose();
                  props.onPublished(id);
                });
          }}
        />
      )}
      {choice === null ? null : (
        <EditorDialog
          title={choice.multiple ? "选择图片组" : "选择图片"}
          size="wide"
          dataName="article-image-picker"
          onCancel={() => finishImages([])}
        >
          <div className={styles.picker}>
            <p>
              选择已就绪的账号素材，或上传新的图片。已选 {selected.length} 项。
            </p>
            <section aria-label="上传素材">
              <h3>上传素材</h3>
              <MediaPicker
                layout={props.layout}
                disabled={
                  uploads === null ||
                  maxUploads === null ||
                  identifying !== 0 ||
                  activeCount >= (maxUploads ?? 0)
                }
                onFiles={(files, origin) => void stage(files, origin)}
              />
              {batch === null ? null : (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={batch.original}
                      onChange={(event) => {
                        const current = batchRef.current;
                        if (current !== null)
                          updateBatch(
                            setBatchOriginal(
                              current,
                              event.currentTarget.checked,
                            ),
                          );
                      }}
                    />
                    保留原图
                  </label>
                  <StagedChoices
                    staging={{
                      batch,
                      count: countStaging(batch, activeCount, maxUploads ?? 0),
                      identifying,
                    }}
                    originalQuality={batch.original}
                    replacementNote={null}
                    confirmError={message}
                    onRemove={(key) => {
                      const current = batchRef.current;
                      if (current === null) return;
                      const result = removeStagedEntry(current, key);
                      if (result.ok) updateBatch(result.batch);
                    }}
                    onKeepStill={(key) => {
                      const current = batchRef.current;
                      if (current === null) return;
                      const result = keepStagedStillAsPhoto(current, key);
                      if (result.ok) updateBatch(result.batch);
                    }}
                    onAttach={async (key, file) => {
                      const original = batchRef.current;
                      const abort = lifetime.current;
                      const generation = sessionGeneration.current;
                      const revision = batchRevision.current;
                      if (
                        original === null ||
                        abort === null ||
                        abort.signal.aborted
                      )
                        return "entry_missing";
                      const identified = await identifyFile(file);
                      if (
                        abort.signal.aborted ||
                        generation !== sessionGeneration.current ||
                        revision !== batchRevision.current ||
                        original !== batchRef.current ||
                        !sameAccount()
                      )
                        return "entry_missing";
                      const result = attachStagedCounterpart(
                        original,
                        key,
                        identified,
                      );
                      if (result.ok) updateBatch(result.batch);
                      return result.ok ? null : result.error;
                    }}
                    onResolve={(key, still, motion) => {
                      const current = batchRef.current;
                      if (current === null) return "entry_missing";
                      const result = resolveStagedAmbiguity(
                        current,
                        key,
                        still,
                        motion,
                      );
                      if (result.ok) updateBatch(result.batch);
                      return result.ok ? null : result.error;
                    }}
                    onConfirm={confirmUploads}
                    onCancel={() => {
                      identificationOperation.current++;
                      setIdentifying(0);
                      updateBatch(null);
                    }}
                  />
                </>
              )}
              <ul className={styles.progress}>
                {uploadState.items
                  .filter(
                    (item) =>
                      item.phase !== "cancelled" && item.phase !== "cleanup",
                  )
                  .map((item, index) => {
                    const status = itemStatus(item);
                    return (
                      <li key={item.key}>
                        <span>
                          素材 {index + 1}：{status.label}
                        </span>
                        {status.kind === "needs_choice" ? (
                          <button
                            type="button"
                            onClick={() =>
                              uploads?.manager.chooseOriginal(item.key)
                            }
                          >
                            上传原图
                          </button>
                        ) : status.kind === "failed" &&
                          status.retry !== null ? (
                          <button type="button" onClick={() => retry(item)}>
                            重试
                          </button>
                        ) : status.kind === "paused" ? (
                          <button
                            type="button"
                            onClick={() =>
                              void uploads?.manager
                                .continueUploads()
                                .catch(reportFailure)
                            }
                          >
                            继续上传
                          </button>
                        ) : null}
                        {item.phase !== "ready" ? (
                          <button
                            type="button"
                            onClick={() =>
                              void uploads?.manager
                                .cancelItem(item.key)
                                .catch(reportFailure)
                            }
                          >
                            取消上传
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
              </ul>
            </section>
            <section aria-label="账号素材">
              <h3>账号素材</h3>
              {props.mediaLoading ? (
                <p role="status">正在读取账号素材…</p>
              ) : null}
              <div className={styles.grid}>
                {[...ready.values()].map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={styles.asset}
                    aria-pressed={selected.includes(item.id)}
                    disabled={item.state !== "ready" || item.media === null}
                    onClick={() => chooseItem(item)}
                  >
                    {item.media === null ? (
                      <span>素材尚未就绪</span>
                    ) : (
                      <img
                        src={item.media.thumbSrc}
                        alt="账号图片"
                        loading="lazy"
                        decoding="async"
                      />
                    )}
                    <span>
                      {selected.includes(item.id)
                        ? `已选 ${selected.indexOf(item.id) + 1}`
                        : item.kind === "live"
                          ? "实况照片"
                          : "图片"}
                    </span>
                  </button>
                ))}
              </div>
              {props.mediaHasMore ? (
                <button
                  type="button"
                  disabled={props.mediaLoading}
                  onClick={() =>
                    void props.loadMoreMedia().catch(reportFailure)
                  }
                >
                  加载更多素材
                </button>
              ) : null}
            </section>
            <div className={styles.actions}>
              <button type="button" onClick={() => finishImages([])}>
                返回编辑
              </button>
              <button
                type="button"
                disabled={selected.length === 0 || identifying !== 0}
                onClick={confirmImages}
              >
                使用已选素材
              </button>
            </div>
          </div>
        </EditorDialog>
      )}
      {catalogChoice === null ? null : (
        <EditorDialog
          title="引用藏品"
          size="wide"
          dataName="article-catalog-picker"
          onCancel={() => finishCatalog(null)}
        >
          <div className={styles.picker}>
            <p>从已公开的藏品中选择引用。</p>
            {catalogLoading ? <p role="status">正在读取藏品…</p> : null}
            <div className={styles.grid}>
              {catalogPage?.items.map((catalog) => (
                <button
                  type="button"
                  className={styles.asset}
                  key={catalog.id}
                  onClick={() => finishCatalog(catalog.id)}
                >
                  {catalog.representativeMedia === undefined ? null : (
                    <img
                      src={catalog.representativeMedia.src}
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                  )}
                  <span>{catalog.title}</span>
                </button>
              ))}
            </div>
            {catalogPage !== null &&
            catalogPage.page < catalogPage.totalPages ? (
              <button
                type="button"
                disabled={catalogLoading}
                onClick={() => void loadCatalog(catalogPage.page + 1)}
              >
                下一页
              </button>
            ) : null}
            <button type="button" onClick={() => finishCatalog(null)}>
              返回编辑
            </button>
          </div>
        </EditorDialog>
      )}
    </div>
  );
};
