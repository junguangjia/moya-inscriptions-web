"use client";

import { Icon } from "@moya/ui";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  fetchSameOriginCatalogSearchPage,
  parseCatalogSearchPage,
  parseCatalogSearchQuery,
} from "../../lib/public-api/catalog-search-client";
import { CatalogCard } from "../home/catalog-card";
import { CatalogPagingControl } from "../catalog-paging/catalog-paging-control";
import { useProductShell } from "../product-shell/product-shell";
import { SearchPresentation, SearchTrigger } from "./search-presentation";
import styles from "./search.module.css";
import { trackAnalytics } from "../analytics/client";
import { requestIdentity } from "../shell/request-identity";
import type { ReactNode, RefObject } from "react";
import type {
  CatalogSearchItem,
  CatalogSearchPage,
  CatalogSearchTransportQuery,
} from "@moya/contracts";
import type { CatalogSearchTransportResult } from "../../lib/public-api/catalog-search";
import type { CatalogPagingRequestState } from "../catalog-paging/catalog-paging";

interface SearchContextValue {
  readonly open: boolean;
  readonly setOpen: (value: boolean) => void;
  readonly openerRef: RefObject<HTMLButtonElement | null>;
  readonly inputRef: RefObject<HTMLInputElement | null>;
}
const SearchContext = createContext<SearchContextValue | null>(null);
const useSearchContext = () => {
  const value = useContext(SearchContext);
  if (value === null) throw new Error("Catalog Search requires its provider");
  return value;
};

export const CatalogSearchProvider = ({
  children,
}: {
  readonly children: ReactNode;
}) => {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <SearchContext.Provider value={{ open, setOpen, openerRef, inputRef }}>
      {children}
    </SearchContext.Provider>
  );
};
export const CatalogSearchNavigationAction = () => {
  const { open, setOpen, openerRef, inputRef } = useSearchContext();
  return (
    <SearchTrigger
      open={open}
      onOpenChange={setOpen}
      openerRef={openerRef}
      searchInputRef={inputRef}
    />
  );
};
/** The same Search in a primary header's leading slot (author composition). */
export const CatalogSearchHeaderAction = () => {
  const { open, setOpen, openerRef, inputRef } = useSearchContext();
  return (
    <SearchTrigger
      open={open}
      onOpenChange={setOpen}
      openerRef={openerRef}
      placement="header"
      searchInputRef={inputRef}
    />
  );
};

export type CatalogSearchLoader = (
  query: CatalogSearchTransportQuery,
  signal: AbortSignal,
) => Promise<CatalogSearchTransportResult>;
interface SearchSnapshot {
  readonly state:
    "idle" | "loading" | "results" | "empty" | "error" | "invalid-query";
  readonly items: readonly CatalogSearchItem[];
  readonly page: CatalogSearchPage | null;
  readonly paging: CatalogPagingRequestState;
}
const idle = (): SearchSnapshot => ({
  state: "idle",
  items: [],
  page: null,
  paging: "complete",
});
const matchLabels = {
  "title-exact": "标题精确匹配",
  "alias-exact": "别名精确匹配",
  "normalized-exact": "规范化精确匹配",
  "title-alias-partial": "标题或别名匹配",
  structured: "基本资料匹配",
  body: "正文匹配",
} as const satisfies Record<CatalogSearchItem["matchKind"], string>;

export const CatalogSearch = ({
  loadPage = fetchSameOriginCatalogSearchPage,
}: {
  readonly loadPage?: CatalogSearchLoader;
}) => {
  const { open, setOpen, openerRef, inputRef } = useSearchContext();
  const { openCatalog } = useProductShell();
  const [keyword, setKeyword] = useState("");
  const [snapshot, setSnapshotState] = useState<SearchSnapshot>(idle);
  const snapshotRef = useRef(snapshot);
  const contentRef = useRef<HTMLDivElement>(null);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const submittedRef = useRef("");
  const analyticsRequest = useRef<string | null>(null);
  const setSnapshot = (value: SearchSnapshot) => {
    snapshotRef.current = value;
    setSnapshotState(value);
  };
  const cancel = () => {
    generationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
  };
  useEffect(
    () => () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
    },
    [],
  );

  const request = async (value: string, requestedPage: number) => {
    const query = parseCatalogSearchQuery({
      q: value,
      page: String(requestedPage),
      pageSize: "20",
    });
    if (query === null) {
      cancel();
      setSnapshot({ ...idle(), state: "invalid-query" });
      return;
    }
    if (requestedPage > 1 && controllerRef.current !== null) return;
    cancel();
    const generation = generationRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    submittedRef.current = value;
    const previous = snapshotRef.current;
    const append = requestedPage > 1;
    if (!append) analyticsRequest.current = requestIdentity();
    setSnapshot(
      append
        ? { ...previous, paging: "loading" }
        : { ...idle(), state: "loading" },
    );
    if (!append && contentRef.current !== null)
      contentRef.current.scrollTop = 0;
    let result: CatalogSearchTransportResult;
    try {
      result = await loadPage(query, controller.signal);
    } catch {
      if (controller.signal.aborted) return;
      result = { state: "unexpected-error" };
    }
    if (
      controller.signal.aborted ||
      generation !== generationRef.current ||
      controllerRef.current !== controller
    )
      return;
    controllerRef.current = null;
    const page =
      result.state === "success" ? parseCatalogSearchPage(result.page) : null;
    if (page === null || page.page !== requestedPage || page.pageSize !== 20) {
      setSnapshot(
        append
          ? { ...previous, paging: "next-page-error" }
          : {
              ...idle(),
              state:
                result.state === "invalid-query" ? "invalid-query" : "error",
            },
      );
      return;
    }
    if (!append && analyticsRequest.current)
      trackAnalytics({
        name: "search",
        surface: "search",
        requestId: analyticsRequest.current,
        searchQuery: query.q.slice(0, 100),
      });
    // Keep the server's complete order. Dedupe only overlapping page identities.
    const seen = new Set(append ? previous.items.map(({ id }) => id) : []);
    const items = append ? [...previous.items] : [];
    for (const item of page.items) {
      if (!seen.has(item.id)) {
        items.push(item);
        seen.add(item.id);
      }
    }
    setSnapshot({
      state: items.length === 0 ? "empty" : "results",
      items,
      page,
      paging: page.page >= page.totalPages ? "complete" : "idle",
    });
  };
  const edit = (value: string) => {
    cancel();
    setKeyword(value);
    submittedRef.current = "";
    setSnapshot(idle());
  };
  const next = () => {
    const current = snapshotRef.current;
    if (
      current.page === null ||
      current.page.page >= current.page.totalPages ||
      (current.paging !== "idle" && current.paging !== "next-page-error")
    )
      return;
    void request(submittedRef.current, current.page.page + 1);
  };

  return (
    <SearchPresentation
      keyword={keyword}
      open={open}
      onOpenChange={setOpen}
      openerRef={openerRef}
      searchInputRef={inputRef}
      contentRef={contentRef}
      onKeywordChange={edit}
      onClear={() => edit("")}
      onSubmit={(value) => {
        void request(value, 1);
      }}
    >
      {snapshot.state === "results" ? (
        <div
          className={styles.groups}
          data-search-results=""
          data-analytics-search-request={analyticsRequest.current ?? undefined}
        >
          <p role="status">找到 {snapshot.page?.total} 条资料</p>
          <div className={styles.results}>
            {snapshot.items.map((item, index) => (
              <div
                key={item.id}
                data-search-result=""
                data-analytics-position={index + 1}
              >
                <p className={styles.matchKind}>
                  {matchLabels[item.matchKind]}
                </p>
                <CatalogCard
                  item={item}
                  variant="inscription"
                  onOpenCatalog={(record, opener) => {
                    trackAnalytics({
                      name: "search_click",
                      surface: "search",
                      targetType: "catalog",
                      targetId: record.id,
                      ...(index < 10_000 ? { position: index + 1 } : {}),
                      ...(analyticsRequest.current
                        ? { requestId: analyticsRequest.current }
                        : {}),
                    });
                    openCatalog(record.id, opener);
                  }}
                />
              </div>
            ))}
          </div>
          <CatalogPagingControl state={snapshot.paging} onLoadNextPage={next} />
        </div>
      ) : (
        <div
          className={styles.empty}
          data-search-state={snapshot.state}
          role={
            snapshot.state === "error" || snapshot.state === "invalid-query"
              ? "alert"
              : "status"
          }
        >
          <Icon
            aria-hidden="true"
            name={
              snapshot.state === "error"
                ? "error"
                : snapshot.state === "empty"
                  ? "empty"
                  : "search"
            }
          />
          <strong>
            {snapshot.state === "idle"
              ? "搜索馆藏资料"
              : snapshot.state === "loading"
                ? "正在搜索…"
                : snapshot.state === "empty"
                  ? "没有找到相关内容"
                  : snapshot.state === "invalid-query"
                    ? "请检查搜索关键词"
                    : "搜索暂时不可用"}
          </strong>
          <span>
            {snapshot.state === "idle"
              ? "输入名称、人物或正文中的文字"
              : snapshot.state === "empty"
                ? "请尝试其他关键词"
                : snapshot.state === "invalid-query"
                  ? "请输入 1 至 200 个字符，避免特殊控制字符"
                  : snapshot.state === "error"
                    ? "请求失败，请稍后重试"
                    : null}
          </span>
          {snapshot.state === "error" ? (
            <button
              className={styles.retry}
              type="button"
              onClick={() => {
                void request(submittedRef.current, 1);
              }}
            >
              重试
            </button>
          ) : null}
        </div>
      )}
    </SearchPresentation>
  );
};
