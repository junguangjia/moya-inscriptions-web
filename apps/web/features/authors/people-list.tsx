"use client";
import { UserIdentity } from "./user-identity";
import { useEffect, useRef, useState } from "react";
import { authorClient, AuthorRequestError } from "./author-data";
import { useAuthors } from "./author-context";
import { AuthorDialog } from "./author-dialog";
import { requestIdentity } from "../shell/request-identity";
import { useProductShell } from "../product-shell/product-shell";
type Page = Awaited<ReturnType<typeof authorClient.people>>;
type Person = Page["items"][number];
type Outcome = { id: string; name: string; message: string; success: boolean };

/** One full-page list owns one history entry. Close it before opening an author. */
export const PeopleList = ({
  id,
  list,
  revision,
  owner = false,
  onClose,
}: {
  id: string;
  list: "following" | "followers";
  revision: number;
  owner?: boolean;
  onClose: () => void;
}) => {
  const author = useAuthors();
  const shell = useProductShell();
  const canManage = owner && author.viewer?.id === id;
  const allowed = canManage && !author.checking && !author.sessionError;
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [closing, setClosing] = useState(false);
  const nextPerson = useRef<{ id: string; trigger: HTMLElement } | null>(null);
  const epoch = useRef(0),
    snapshot = useRef<Page | null>(null),
    loading = useRef(false),
    writing = useRef(false),
    mounted = useRef(true);
  const identity = `${author.viewer?.id ?? "guest"}:${id}:${list}`;
  const latest = useRef({ identity, allowed });
  latest.current = { identity, allowed };
  const previousIdentity = useRef(identity);
  const failed = useRef<{ page: number; through: number; all: boolean } | null>(
    null,
  );
  const action = list === "following" ? "取关" : "拉黑";
  const load = async (n = 1, through = n, all = false) => {
    const run = ++epoch.current;
    loading.current = true;
    setBusy(true);
    setSelectingAll(all);
    setError("");
    try {
      const items: Person[] = [];
      let result: Page | null = null;
      for (let current = n; current <= through; current++) {
        result = await authorClient.people(id, list, current);
        if (run !== epoch.current) return;
        items.push(...result.items);
        if (all) {
          through = Math.max(1, Math.ceil(result.total / result.pageSize));
          if (
            through > 10000 ||
            (current < through && result.items.length === 0)
          )
            throw Error("名单已变化，请重新读取后再全选");
        }
      }
      if (!result) return;
      const next = {
        ...result,
        items: [
          ...new Map(
            [...(n === 1 ? [] : (snapshot.current?.items ?? [])), ...items].map(
              (p) => [p.id, p],
            ),
          ).values(),
        ],
      };
      if (all && next.items.length !== next.total)
        throw Error("名单已变化，请重新读取后再全选");
      snapshot.current = next;
      setPage(next);
      if (all) setSelected(new Set(next.items.map((p) => p.id)));
      else
        setSelected(
          (old) =>
            new Set(
              [...old].filter((key) => next.items.some((p) => p.id === key)),
            ),
        );
      failed.current = null;
    } catch (e) {
      if (run !== epoch.current) return;
      if (
        e instanceof AuthorRequestError &&
        [401, 403, 404].includes(e.status)
      ) {
        snapshot.current = null;
        setPage(null);
        setSelected(new Set());
      }
      failed.current = { page: n, through, all };
      setError(e instanceof Error ? e.message : "无法读取列表");
    } finally {
      if (run === epoch.current) {
        loading.current = false;
        setBusy(false);
        setSelectingAll(false);
      }
    }
  };
  useEffect(() => {
    mounted.current = true;
    if (previousIdentity.current !== identity) {
      previousIdentity.current = identity;
      snapshot.current = null;
      setPage(null);
      setSelected(new Set());
      setOutcomes([]);
    }
    void load(1, Math.max(1, snapshot.current?.page ?? 1));
    return () => {
      epoch.current++;
      loading.current = false;
      mounted.current = false;
    };
  }, [identity, revision]);

  const apply = async (people: Person[]) => {
    if (
      !latest.current.allowed ||
      writing.current ||
      loading.current ||
      !people.length
    )
      return;
    const description = list === "following" ? "取消关注" : "拉黑";
    if (
      !window.confirm(
        `${description}这 ${people.length} 位用户？${list === "followers" ? "双方的关注关系将移除。" : ""}`,
      )
    )
      return;
    const accountRun = authorClient.accountEpoch(),
      origin = identity;
    const current = () =>
      mounted.current &&
      latest.current.identity === origin &&
      latest.current.allowed &&
      authorClient.accountEpoch() === accountRun;
    if (!current()) return;
    writing.current = true;
    setMutating(true);
    setError("");
    setOutcomes([]);
    const results: Outcome[] = [];
    try {
      for (const person of people) {
        if (!current()) break;
        try {
          await authorClient.command(
            `relationships/${list === "following" ? "follow" : "block"}`,
            {
              requestId: requestIdentity(),
              targetId: person.id,
              enabled: list === "followers",
            },
          );
          if (!current()) break;
          results.push({
            id: person.id,
            name: person.displayName,
            message: list === "following" ? "已取关" : "已拉黑",
            success: true,
          });
          const previous = snapshot.current;
          if (previous) {
            const next = {
              ...previous,
              items: previous.items.filter((p) => p.id !== person.id),
              total: Math.max(0, previous.total - 1),
            };
            snapshot.current = next;
            setPage(next);
          }
          setSelected((old) => {
            const next = new Set(old);
            next.delete(person.id);
            return next;
          });
        } catch (e) {
          if (!current()) break;
          results.push({
            id: person.id,
            name: person.displayName,
            message: e instanceof Error ? e.message : "操作未完成",
            success: false,
          });
        }
        setOutcomes([...results]);
      }
      if (mounted.current && latest.current.identity === origin) {
        if (results.length < people.length)
          setError(
            "账户状态已变化，未继续处理剩余用户。请确认账户后重新读取名单。",
          );
        if (results.some((item) => item.success)) author.mutate();
      }
    } finally {
      writing.current = false;
      if (mounted.current && latest.current.identity === origin)
        setMutating(false);
    }
  };
  return (
    <AuthorDialog
      title={list === "following" ? "关注" : "粉丝"}
      dismissible={!mutating}
      closeRequested={closing}
      onClose={() => {
        onClose();
        const person = nextPerson.current;
        if (person) shell.openProfile(person.id, person.trigger);
      }}
    >
      <section
        aria-busy={busy || mutating}
        aria-label={list === "following" ? "关注列表" : "粉丝列表"}
      >
        {canManage && (
          <div className="phase4-people-tools">
            <button
              className="phase4-button"
              type="button"
              disabled={!allowed || busy || mutating || closing}
              onClick={() => void load(1, 1, true)}
            >
              {selectingAll ? "正在加载全部名单…" : "全选"}
            </button>
            <button
              className="phase4-button"
              type="button"
              disabled={!selected.size || busy || mutating || closing}
              onClick={() => setSelected(new Set())}
            >
              取消选择
            </button>
            <button
              className="phase4-button"
              type="button"
              disabled={
                !allowed || !selected.size || busy || mutating || closing
              }
              onClick={() =>
                void apply(
                  page?.items.filter((person) => selected.has(person.id)) ?? [],
                )
              }
            >
              {action}所选（{selected.size}）
            </button>
          </div>
        )}
        {page && (
          <p className="phase4-muted">
            已显示 {page.items.length} / {page.total} 位
            {selected.size ? ` · 已选择 ${selected.size} 位` : ""}
          </p>
        )}
        {!busy && page?.total === 0 && (
          <p>暂无{list === "following" ? "关注" : "粉丝"}</p>
        )}
        <ul className="phase4-people-list">
          {page?.items.map((person) => (
            <li key={person.id}>
              {canManage && (
                <label className="phase4-person-select">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${person.displayName}（@${person.handle}）`}
                    checked={selected.has(person.id)}
                    disabled={!allowed || busy || mutating || closing}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setSelected((old) => {
                        const next = new Set(old);
                        if (checked) next.add(person.id);
                        else next.delete(person.id);
                        return next;
                      });
                    }}
                  />
                </label>
              )}
              <button
                className="phase4-person-identity"
                type="button"
                disabled={mutating || closing}
                onClick={(event) => {
                  nextPerson.current = {
                    id: person.id,
                    trigger: event.currentTarget,
                  };
                  setClosing(true);
                }}
              >
                <span className="phase4-person-avatar">
                  {person.avatar ? (
                    <img
                      src={person.avatar.src}
                      alt=""
                      width={48}
                      height={48}
                    />
                  ) : (
                    person.displayName.slice(0, 1)
                  )}
                </span>
                <span>
                  <strong>
                    <UserIdentity
                      name={person.displayName}
                      studioName={person.studioName}
                    />
                  </strong>
                  <small>@{person.handle}</small>
                </span>
              </button>
              {canManage && (
                <button
                  className="phase4-button phase4-person-action"
                  type="button"
                  disabled={!allowed || busy || mutating || closing}
                  onClick={() => void apply([person])}
                >
                  {action}
                </button>
              )}
            </li>
          ))}
        </ul>
        {page && page.items.length < page.total && (
          <button
            className="phase4-button"
            type="button"
            disabled={busy || mutating || closing}
            onClick={() => {
              if (!loading.current) void load(page.page + 1);
            }}
          >
            加载更多
          </button>
        )}
        {(busy || mutating) && (
          <p role="status">
            {mutating
              ? "正在逐一处理，请稍候…"
              : selectingAll
                ? "正在读取完整名单，全选将在读取完成后生效。"
                : "读取中…"}
          </p>
        )}
        {outcomes.length > 0 && (
          <div role="status">
            <p>
              已完成 {outcomes.filter((item) => item.success).length} 位，未完成{" "}
              {outcomes.filter((item) => !item.success).length} 位
            </p>
            <ul aria-label="操作结果">
              {outcomes.map((item) => (
                <li key={item.id}>
                  {item.name}：{item.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && (
          <p role="alert">
            {error}
            {failed.current && (
              <button
                className="phase4-button"
                type="button"
                disabled={busy || mutating || closing}
                onClick={() => {
                  const request = failed.current;
                  if (request && !loading.current)
                    void load(request.page, request.through, request.all);
                }}
              >
                重试
              </button>
            )}
          </p>
        )}
      </section>
    </AuthorDialog>
  );
};
