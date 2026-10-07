"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ContentCard as Card, UserWork } from "@moya/contracts";
import { authorClient, AuthorRequestError } from "./author-data";
import { useAuthors } from "./author-context";
import { readLocalHistory } from "./local-library";
import { resolveLocalContent } from "./local-content-list";
import { CatalogMasonry } from "../home/catalog-masonry";
import { useProductShell } from "../product-shell/product-shell";
import { ContentCard } from "./content-card";
import { DraftsCard } from "../publishing/ui/drafts/drafts-card";
import {
  WORK_EXCERPT_MAXIMUM,
  codePointLength,
  normalizePublishingBody,
} from "../publishing/publishing-data";
import type { ProfileTab } from "../product-shell/product-history";

/**
 * The opening of a work body for its card: the shared normalization, then at
 * most the excerpt maximum in code points, trimmed after cutting (the same
 * excerpt the discovery feed builds).
 */
export const workCardExcerpt = (body: string): string => {
  const normalized = normalizePublishingBody(body);
  return codePointLength(normalized) <= WORK_EXCERPT_MAXIMUM
    ? normalized
    : [...normalized].slice(0, WORK_EXCERPT_MAXIMUM).join("").trim();
};

/**
 * A Works tab card from the work itself, showing the same still the Home
 * feed shows: `coverSrc` is the revision's card cover under its edit and
 * cover crop (M03). Only a work record without the field at all falls back
 * to the cover entry's display image; `null` is the account saying this
 * revision has no presentable cover, and then the card is its text. The
 * entry named by `coverMediaId` (else the first media) still supplies the
 * card's identity, the LIVE indicator and the placeholder colour. When the
 * work carries `coverRenditions`, the candidate that is `coverSrc` gives the
 * cover's own size, so the box reserved before the image loads matches
 * Home's; without them the measurements stay the display image's. The
 * body's opening rides along so an untitled card shows real text instead of
 * nothing (C07).
 */
export const workCard = (work: UserWork): Card => {
  const cover =
    work.media.find((media) => media.id === work.coverMediaId) ??
    work.media[0] ??
    null;
  const src =
    work.coverSrc === undefined ? (cover?.src ?? null) : work.coverSrc;
  const anchor =
    src === null
      ? undefined
      : work.coverRenditions?.find((entry) => entry.src === src);
  const excerpt = workCardExcerpt(work.text);
  return {
    target: { type: "work", id: work.id },
    title: work.title,
    ...(excerpt === "" ? {} : { excerpt }),
    aliases: [],
    kind: null,
    authorId: work.authorId,
    firstPublishedAt: work.firstPublishedAt,
    live: cover?.kind === "live" && src !== null,
    media:
      cover === null || src === null
        ? null
        : {
            id: cover.id,
            src,
            width: anchor?.width ?? cover.width,
            height: anchor?.height ?? cover.height,
            ...(anchor === undefined || work.coverRenditions === undefined
              ? {}
              : { renditions: work.coverRenditions }),
            ...(cover.placeholderColor === undefined
              ? {}
              : { placeholderColor: cover.placeholderColor }),
          },
  };
};
interface ListState {
  items: Card[];
  page: number;
  total: number;
  search: string;
  kind: string;
  revision: number;
}
/** The owner's drafts card, placed before the works in the Works tab. */
const draftsEntry = { drafts: true } as const;
type ListEntry = Card | typeof draftsEntry;
const isDraftsEntry = (entry: ListEntry): entry is typeof draftsEntry =>
  "drafts" in entry;
interface Read {
  page: number;
  replace: boolean;
  search: string;
  kind: string;
  through?: number;
}
export const ProfileList = ({
  authorId,
  tab,
  entryId,
  owner,
  active,
}: {
  authorId: string | null;
  tab: Exclude<ProfileTab, "comments">;
  entryId: string;
  owner: boolean;
  active: boolean;
}) => {
  const context = useAuthors(),
    shell = useProductShell(),
    cacheKey = `list:${context.viewer?.id ?? "guest"}:${entryId}:${authorId ?? "guest"}:${tab}`;
  const [list, setList] = useState<ListState>(() => {
      const cached = context.cache.get(cacheKey) as ListState | undefined;
      // Hidden controls must never leave a previous filter active invisibly.
      return cached && cached.search === "" && cached.kind === "all"
        ? cached
        : {
            items: [],
            page: 0,
            total: 0,
            search: "",
            kind: "all",
            revision: context.revision,
          };
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const wasActive = useRef(false);
  const epoch = useRef(0),
    loading = useRef(false),
    failed = useRef<Read | null>(null),
    sentinel = useRef<HTMLDivElement>(null),
    listRef = useRef(list);
  listRef.current = list;
  useEffect(() => {
    context.cache.set(cacheKey, list);
  }, [context.cache, cacheKey, list]);
  const readPage = async (q: Read) => {
    if (!authorId) throw new Error("账户列表不可用");
    if (tab === "works") {
      const result = await authorClient.works(authorId, q.page);
      return {
        items: result.items.filter((w) => w.available || owner).map(workCard),
        total: result.total,
      };
    }
    if (tab !== "favorites" && tab !== "likes")
      throw new Error("账户列表不可用");
    return authorClient.collection(authorId, tab, q.page, "", "all");
  };
  const load = async (q: Read) => {
    if (loading.current) return;
    loading.current = true;
    const run = ++epoch.current;
    setBusy(true);
    setError("");
    try {
      const items: Card[] = [];
      let total = 0;
      const last = q.through ?? q.page;
      const localItems =
        tab === "history" || authorId === null
          ? await resolveLocalContent(
              tab === "history"
                ? readLocalHistory(context.viewer?.id ?? null)
                : tab === "favorites"
                  ? context.guestFavorites
                  : [],
              authorClient.card,
              "",
              "all",
              () => run === epoch.current,
            )
          : null;
      for (let page = q.page; page <= last; page++) {
        const result = localItems
          ? {
              items: localItems.slice((page - 1) * 12, page * 12),
              total: localItems.length,
            }
          : await readPage({ ...q, page });
        if (run !== epoch.current) return;
        items.push(...result.items);
        total = result.total;
      }
      failed.current = null;
      setList((old) => ({
        ...old,
        items: q.replace ? items : [...old.items, ...items],
        page: last,
        total,
        search: "",
        kind: "all",
        revision: context.revision,
      }));
    } catch (e) {
      if (run === epoch.current) {
        failed.current = q;
        if (
          e instanceof AuthorRequestError &&
          (e.status === 404 || e.status === 401)
        )
          setList((old) => ({ ...old, items: [], total: 0 }));
        setError(e instanceof Error ? e.message : "列表加载失败");
      }
    } finally {
      if (run === epoch.current) {
        loading.current = false;
        setBusy(false);
      }
    }
  };
  const next = () => {
    const old = listRef.current;
    void load({
      page: old.page + 1,
      replace: false,
      search: old.search,
      kind: old.kind,
    });
  };
  useEffect(() => {
    if (!active) {
      wasActive.current = false;
      return;
    }
    const entering = !wasActive.current;
    wasActive.current = true;
    const old = listRef.current;
    // Recheck eligibility and privacy on return even if this account did not
    // perform the remote change. Preserve the loaded range and filter state.
    if (entering || old.page === 0 || old.revision !== context.revision)
      void load({
        page: 1,
        through: Math.max(1, old.page),
        replace: true,
        search: old.search,
        kind: old.kind,
      });
  }, [active, context.revision, list.revision]);
  useEffect(
    () => () => {
      epoch.current++;
      loading.current = false;
      // A replayed mount must replace the retired request even when cached
      // pages already match the account revision (for example Back from Detail).
      wasActive.current = false;
    },
    [],
  );
  // Drafts are private: only the signed-in account viewing its own Works tab
  // gets the card; visitors and guests never do.
  const draftsOwner =
    tab === "works" &&
    owner &&
    authorId !== null &&
    context.viewer !== null &&
    context.viewer.id === authorId
      ? authorId
      : null;
  const entries = useMemo<ListEntry[]>(
    () => (draftsOwner === null ? list.items : [draftsEntry, ...list.items]),
    [draftsOwner, list.items],
  );
  useEffect(() => {
    if (
      !sentinel.current ||
      !active ||
      busy ||
      error ||
      list.page === 0 ||
      list.page * 12 >= list.total
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((i) => i.isIntersecting)) next();
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [active, busy, error, list.page, list.total]);
  if (tab === "history" && !owner) return <p>浏览历史仅自己可见。</p>;
  return (
    <div>
      {!authorId && tab === "favorites" && (
        <p className="phase4-muted">
          收藏保存在此浏览器；登录后可合并到账户。清除浏览器数据可能移除本机收藏。
        </p>
      )}
      <CatalogMasonry<ListEntry>
        items={entries}
        getKey={(i) =>
          isDraftsEntry(i) ? "drafts" : `${i.target.type}:${i.target.id}`
        }
        isFullSpan={(i) =>
          !isDraftsEntry(i) &&
          !!i.media &&
          i.media.width / i.media.height >= 2.4
        }
        platform={shell.platform}
        feedLayout={shell.feedLayout}
        renderItem={(item, onMediaSettled) =>
          isDraftsEntry(item) ? (
            draftsOwner === null ? null : (
              <DraftsCard
                accountId={draftsOwner}
                active={active}
                onSettled={onMediaSettled}
              />
            )
          ) : (
            <ContentCard item={item} onMediaSettled={onMediaSettled} />
          )
        }
      />
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button
            className="phase4-button"
            onClick={() => {
              if (failed.current) void load(failed.current);
            }}
          >
            重试
          </button>
        </div>
      ) : !busy && !list.items.length ? (
        <p>暂无可显示的内容</p>
      ) : null}
      <div ref={sentinel} className="phase4-load">
        {busy ? (
          <span role="status">正在加载…</span>
        ) : !error && list.page * 12 < list.total ? (
          <button className="phase4-button" onClick={next}>
            加载更多
          </button>
        ) : null}
      </div>
    </div>
  );
};
