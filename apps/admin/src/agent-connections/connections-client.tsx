"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SetStepNav } from "@payloadcms/ui";
import { workspacePageLabel } from "../workspace/routes";

import styles from "./connections.module.css";

/**
 * What this page calls itself in the Admin breadcrumb, in one place because
 * two renders set it: this client, and the refusal branch in `View.tsx` that
 * never mounts this client at all.
 */
const PAGE_LABEL = workspacePageLabel("/admin/agent-connections");
const PAGE_NAV = [
  { label: "发布工具", url: "/admin/editorial-workflow" },
  { label: PAGE_LABEL },
];

/** The breadcrumb alone, for a branch that renders no connections UI. */
export const ConnectionsStepNav = () => <SetStepNav nav={PAGE_NAV} />;

interface ListedConnectionView {
  readonly id: string;
  readonly client: string;
  readonly clientLabel: string | null;
  readonly principalLabel: string;
  readonly oauthClientId: string;
  readonly environment: string;
  readonly preset: string;
  readonly status: string;
  readonly generation: number;
  readonly consentedAt: string | null;
  readonly revokedAt: string | null;
  readonly lastVerifiedAt: string | null;
  readonly hasCurrentGrant: boolean;
}

interface RegisteredClientView {
  readonly clientId: string;
  readonly family: string;
  readonly label: string;
}

/** What this deployment is, so a reader never has to assume. */
interface SurfaceView {
  readonly environment: string;
  readonly issuer: string;
  readonly resource: string;
  readonly authMethod: string;
}

/**
 * The `AI 连接` page.
 *
 * WHAT IT CLAIMS, AND WHAT IT REFUSES TO. It shows only what the database
 * recorded. There is no "online", no green dot and no "connected now":
 * nothing here observes liveness, and the nearest real fact — the last
 * request that actually authenticated — is shown as exactly that. A service
 * self-check, a protocol success, a desktop success and a phone success are
 * four different facts, and this page claims none of them on another's
 * behalf.
 *
 * NO SECRET REACHES THIS COMPONENT. The list endpoint sends no token, no key,
 * no cookie and no consent ticket, so there is nothing here for a copy button
 * to leak: a client obtains its own credential through the browser consent
 * flow, and a human never carries one.
 *
 * THE SHAPE. Four levels, in the order a daily user needs them: what is
 * connected, how to connect something new, past connections, and the
 * deployment's own technical detail. Identifiers live in the detail level and
 * never in a primary row, because "which of my applications is this" is
 * answered by a name.
 */

const PRESET_FAMILIES = ["cursor", "claude", "codex"] as const;

/**
 * Setup copy for the three families the Admin knows how to describe.
 *
 * PRESENTATION ONLY, and it classifies nothing. An earlier version of this
 * page used family membership to decide which registrations were "real" and
 * which were this task's test identities. An independent review showed that
 * rule is wrong in both directions, and this repository contains an example
 * of each: the integration guide tells an integrator that `family` is "any
 * value" and registers `example-agent`, which the rule would have badged as a
 * test utility and, outside Development, hidden entirely — leaving a
 * legitimately registered client with no button anywhere. Meanwhile the
 * acceptance harness registers a test identity under `family: "cursor"`,
 * which the rule would have offered as "Cursor Desktop".
 *
 * So the family now selects DESCRIPTION and nothing else. Every registration
 * is listed, under its own label, and the page makes no claim about which
 * ones are "real".
 */
const PRESETS: readonly {
  readonly family: (typeof PRESET_FAMILIES)[number];
  readonly name: string;
  readonly note: string;
}[] = [
  {
    family: "cursor",
    name: "Cursor Desktop",
    note: "在 Cursor 的 MCP 设置里添加 ArtVenn，授权后即可在对话中查询。",
  },
  {
    family: "claude",
    name: "Claude Code",
    note: "在 Claude Code 中添加 ArtVenn 作为远程 MCP 服务器，并完成浏览器授权。",
  },
  {
    family: "codex",
    name: "Codex",
    note: "在 Codex 的 MCP 配置中指向 ArtVenn，授权流程与其他客户端一致。",
  },
];

/**
 * The user-facing state of a connection.
 *
 * Deliberately small, and deliberately not the raw lifecycle enum: those
 * names appear once, in the technical detail, where somebody reading them
 * wants the database's word rather than the product's.
 */
const isRevoked = (connection: ListedConnectionView): boolean =>
  connection.status === "revoked" || connection.revokedAt !== null;

const describeStatus = (
  connection: ListedConnectionView,
): { readonly text: string; readonly tone: string } => {
  // `revokedAt` is a revocation whatever the status column says. `lifecycle`
  // and `admission` both guard on it deliberately, so that a consent cannot
  // launder a revoked row clean; this page was the one surface that did.
  if (isRevoked(connection)) return { text: "已断开", tone: "muted" };
  if (connection.status === "awaiting-consent")
    return { text: "等待授权", tone: "pending" };
  if (connection.status === "authorized")
    return connection.hasCurrentGrant
      ? { text: "已授权", tone: "active" }
      : // Authorized in the record, with no grant behind it: the application
        // has not finished, or its grant was destroyed. "已授权" would be a
        // promise this row cannot keep.
        { text: "需要重新授权", tone: "attention" };
  return { text: "未知 / 暂不可用", tone: "muted" };
};

const AUTH_METHOD_LABEL: Readonly<Record<string, string>> = {
  "oauth-browser-consent": "OAuth（浏览器授权）",
};

const PRESET_LABEL: Readonly<Record<string, string>> = {
  "read-only": "只读",
};

/** A timestamp a person can read, with the exact value kept in `title`. */
const whenText = (value: string | null): string => {
  if (value === null) return "—";
  const at = Date.parse(value);
  if (Number.isNaN(at)) return value;
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 86_400)} 天前`;
  return new Date(at).toLocaleDateString();
};

const CopyValue = ({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) => {
  const [copied, setCopied] = useState(false);
  // The confirmation is a moment, not a state. Without this the button says
  // 已复制 for the rest of the session and a second copy looks like a no-op.
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <span className={styles.mono}>{value}</span>
      <button
        className={styles.copy}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(value)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
        title={`复制${label}`}
        type="button"
      >
        {copied ? "已复制" : "复制"}
      </button>
    </>
  );
};

export const AgentConnectionsClient = () => {
  const [connections, setConnections] = useState<ListedConnectionView[]>([]);
  const [clients, setClients] = useState<RegisteredClientView[]>([]);
  const [surface, setSurface] = useState<SurfaceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pendingDisconnect, setPendingDisconnect] =
    useState<ListedConnectionView | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const advancedRef = useRef<HTMLDetailsElement | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/agent-connections", {
        credentials: "same-origin",
      });
      const payload: unknown = await response.json();
      const body =
        typeof payload === "object" && payload !== null
          ? (payload as { ok?: unknown; error?: unknown; result?: unknown })
          : {};
      if (!response.ok || body.ok !== true) {
        setError(typeof body.error === "string" ? body.error : "REFUSED");
        return;
      }
      const result = body.result as {
        connections?: ListedConnectionView[];
        clients?: RegisteredClientView[];
        environment?: string;
        issuer?: string;
        resource?: string;
        authMethod?: string;
      };
      setConnections(result.connections ?? []);
      setClients(result.clients ?? []);
      setSurface(
        result.environment === undefined
          ? null
          : {
              environment: result.environment,
              issuer: result.issuer ?? "",
              resource: result.resource ?? "",
              authMethod: result.authMethod ?? "",
            },
      );
      setError(null);
    } catch {
      setError("NETWORK");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The dialog is opened as a MODAL, so the platform supplies the focus trap,
  // the backdrop and Escape. Nothing here reimplements those.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (pendingDisconnect !== null && !dialog.open) {
      try {
        dialog.showModal();
      } catch {
        // Not every environment implements the modal mode. Falling back to
        // the open attribute keeps the confirmation reachable rather than
        // leaving a destructive action with no way to confirm it.
        dialog.open = true;
      }
    }
    if (pendingDisconnect === null && dialog.open) dialog.close();
  }, [pendingDisconnect]);

  useEffect(() => {
    if (!advancedOpen) return;
    advancedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [advancedOpen]);

  const post = async (path: string, body: unknown) => {
    setBusy(true);
    try {
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload: unknown = await response.json();
      const parsed =
        typeof payload === "object" && payload !== null
          ? (payload as { ok?: unknown; error?: unknown })
          : {};
      if (!response.ok || parsed.ok !== true)
        setError(typeof parsed.error === "string" ? parsed.error : "REFUSED");
      else setError(null);
      await load();
    } catch {
      setError("NETWORK");
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (connection: ListedConnectionView): string =>
    connection.clientLabel ?? connection.client;

  const presetFamilies = new Set<string>(PRESET_FAMILIES);
  // Grouped for DESCRIPTION, never filtered for legitimacy: every registered
  // client appears somewhere on this page, under the label its registration
  // gave it. A family the Admin has no setup copy for is listed plainly
  // rather than hidden or renamed.
  const othersClients = clients.filter(
    (client) => !presetFamilies.has(client.family),
  );
  const active = connections.filter((connection) => !isRevoked(connection));
  const history = connections.filter(isRevoked);

  /** Every registration in a family, so a second one is never unreachable. */
  const clientsIn = (family: string) =>
    clients.filter((client) => client.family === family);

  /**
   * The live state of one registration, which decides what its card offers.
   *
   * It must agree with `describeStatus`, because both describe the same rows
   * on the same screen. An earlier version treated every non-revoked row as
   * connected, so a connection the card above called 需要重新授权 was called
   * 已连接 here -- the page contradicting itself about one client, with no
   * action offered anywhere.
   *
   * ONE DELIBERATE EXCEPTION, and it is not here. When a pair is ambiguous,
   * `ClientAction` overrides the badge to 未知 / 暂不可用 while the row cards
   * still read 等待授权 or 需要重新授权. Those cards are right about their own
   * rows; the badge is right that nothing can finish. The override lives
   * there, not in this function, so the ordering below stays a pure fold --
   * but do not read the paragraph above as an invariant that holds in every
   * state, because that one was broken on purpose.
   */
  const stateOf = (clientId: string) => {
    const all = connections.filter(
      (connection) => connection.oauthClientId === clientId,
    );
    const rows = all.filter((connection) => !isRevoked(connection));
    // A disconnected client is NOT available. `resolveConnection` returns
    // early on any existing row, revoked included -- `findForClient` has no
    // status filter -- so 开始连接 would POST, succeed, change nothing, and
    // leave the button sitting there, while the dialog the reader just
    // dismissed told them reconnecting needs fresh authorization.
    if (rows.length === 0 && all.length > 0) return "disconnected" as const;
    // Each registration holds at most one live row today, which is what makes
    // this fold agree with `describeStatus` row for row. That invariant is
    // enforced two layers away and NOT by this file; until it is, the
    // ordering below decides what a client with several rows reports.
    // Strongest state first. Checking `awaiting` first would let a client
    // that holds a live connection AND a half-finished one read
    // 等待应用完成授权 here while its own card read 已授权 -- the same
    // disagreement, one row over.
    if (rows.some((row) => row.status === "authorized" && row.hasCurrentGrant))
      return "connected" as const;
    if (rows.some((row) => row.status === "authorized"))
      return "needs-consent" as const;
    if (rows.some((row) => row.status === "awaiting-consent"))
      return "awaiting" as const;
    if (rows.length > 0) return "unknown" as const;
    return "available" as const;
  };

  /**
   * Two live rows for one registration is a state the control plane refuses:
   * `findForClient` raises AMBIGUOUS_CLIENT_CONNECTION and consent then fails
   * with CONSENT_UNAVAILABLE. Telling that reader to authorize once more in
   * the application would send them round a loop that cannot close, so the
   * recovery hint is withheld exactly where it would be false.
   */
  const ambiguous = (clientId: string) =>
    connections.filter((connection) => connection.oauthClientId === clientId)
      .length > 1;

  /**
   * Whether re-authorizing in the application can actually restore a
   * disconnected client. `reconnectConnection` accepts only a row whose
   * status column reads `revoked`; `authorizeConnection` refuses any row
   * carrying `revokedAt`. A row that is `authorized` WITH `revokedAt` set
   * satisfies neither and cannot be recovered from here, so the page does
   * not offer to.
   */
  const reconnectable = (clientId: string) =>
    !ambiguous(clientId) &&
    connections
      .filter((connection) => connection.oauthClientId === clientId)
      .every((connection) => connection.status === "revoked");

  /**
   * One registration's action. Named by ITS OWN label, never by a preset's,
   * so two registrations in one family are told apart and a card can never
   * start something other than what it says.
   */
  const ClientAction = ({
    client,
  }: {
    readonly client: RegisteredClientView;
  }) => {
    const state = stateOf(client.clientId);
    if (state === "connected")
      return (
        <span className={styles.badge} data-tone="neutral">
          已连接
        </span>
      );
    if (
      (state === "awaiting" || state === "needs-consent") &&
      ambiguous(client.clientId)
    )
      return (
        <span className={styles.presetAction}>
          <span className={styles.badge} data-tone="muted">
            未知 / 暂不可用
          </span>
          <span className={styles.presetHint}>
            这个客户端有多条记录，授权无法完成
          </span>
        </span>
      );
    if (state === "awaiting")
      return (
        <span className={styles.badge} data-tone="pending">
          等待应用完成授权
        </span>
      );
    if (state === "needs-consent")
      return (
        <span className={styles.badge} data-tone="attention">
          需要重新授权
        </span>
      );
    if (state === "unknown")
      return (
        <span className={styles.badge} data-tone="muted">
          未知 / 暂不可用
        </span>
      );
    if (state === "disconnected")
      return (
        <span className={styles.presetAction}>
          <span className={styles.badge} data-tone="muted">
            已断开
          </span>
          <span className={styles.presetHint}>
            {reconnectable(client.clientId)
              ? "在应用里重新授权即可重新连上"
              : "暂时无法在这里重新连上"}
          </span>
        </span>
      );
    return (
      <button
        className={`${styles.button} ${styles.buttonPrimary}`}
        data-agent-connections-start={client.clientId}
        disabled={busy}
        onClick={() =>
          void post("/api/agent-connections/start", {
            clientId: client.clientId,
          })
        }
        type="button"
      >
        开始连接
      </button>
    );
  };

  return (
    <section className={styles.page} data-agent-connections>
      {/* Reset Payload's client breadcrumb for direct and in-app navigation. */}
      <SetStepNav nav={PAGE_NAV} />
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{PAGE_LABEL}</h1>
          {surface === null ? null : (
            <span
              className={styles.badge}
              data-agent-connections-environment={surface.environment}
              data-tone="neutral"
            >
              {/* Capitalised for the badge only. The exact value the server
                  sent stays on the data attribute and in 高级信息, because
                  that is the one a reader may need to match against a
                  configuration file. */}
              {surface.environment.charAt(0).toUpperCase() +
                surface.environment.slice(1)}
            </span>
          )}
          <span className={styles.badge} data-tone="neutral">
            只读
          </span>
        </div>
        <p className={styles.lead}>
          {
            "连接 AI 应用访问 ArtVenn。当前仅提供只读连接：可以查询内容，不能修改、发布、删除或代你审批。"
          }
        </p>
      </header>

      {error !== null ? (
        <p
          className={styles.notice}
          data-agent-connections-error={error}
          role="alert"
        >
          读取失败：{error}
        </p>
      ) : null}

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionTitle}>已连接</h3>
          <p className={styles.sectionNote}>
            「最近一次通过验证的请求」是最后一次成功访问的时间，不代表此刻在线。
          </p>
        </div>
        {active.length === 0 ? (
          <p className={styles.empty} data-agent-connections-empty>
            还没有已连接的应用。在下面选择一个应用开始连接。
          </p>
        ) : (
          <div className={styles.cards}>
            {active.map((connection) => {
              const status = describeStatus(connection);
              const open = expanded === connection.id;
              return (
                <article
                  className={styles.card}
                  data-agent-connection={connection.id}
                  key={connection.id}
                >
                  <div className={styles.cardMain}>
                    <div className={styles.cardTitleRow}>
                      <h4
                        className={styles.cardTitle}
                        data-agent-connection-client
                      >
                        {nameOf(connection)}
                      </h4>
                      <span
                        className={styles.badge}
                        data-agent-connection-status={connection.status}
                        data-tone={status.tone}
                      >
                        {status.text}
                      </span>
                      <span
                        className={styles.badge}
                        data-agent-connection-preset={connection.preset}
                        data-tone="neutral"
                      >
                        {PRESET_LABEL[connection.preset] ?? connection.preset}
                      </span>
                    </div>
                    <div className={styles.cardMeta}>
                      <span
                        data-agent-connection-last-verified
                        title={connection.lastVerifiedAt ?? undefined}
                      >
                        最近一次通过验证的请求：
                        {connection.lastVerifiedAt === null
                          ? "尚未观察到"
                          : whenText(connection.lastVerifiedAt)}
                      </span>
                      <span title={connection.consentedAt ?? undefined}>
                        授权时间：{whenText(connection.consentedAt)}
                      </span>
                    </div>
                    {status.text === "需要重新授权" &&
                    !ambiguous(connection.oauthClientId) ? (
                      <p className={styles.cardHint} data-agent-connection-hint>
                        {
                          "在应用里重新登录 ArtVenn、完成一次授权即可重新连上。不需要先断开这条连接。"
                        }
                      </p>
                    ) : null}
                    {open ? (
                      <dl className={styles.detailList}>
                        <dt>连接 ID</dt>
                        <dd>
                          <CopyValue label="连接 ID" value={connection.id} />
                        </dd>
                        <dt>OAuth 客户端</dt>
                        <dd>
                          <CopyValue
                            label="OAuth 客户端 ID"
                            value={connection.oauthClientId}
                          />
                        </dd>
                        <dt>机器身份</dt>
                        <dd>
                          <span className={styles.mono}>
                            {connection.principalLabel}
                          </span>
                        </dd>
                        <dt>代数 / 状态</dt>
                        <dd>
                          <span className={styles.mono}>
                            {connection.generation} · {connection.status}
                          </span>
                        </dd>
                      </dl>
                    ) : null}
                  </div>
                  <div className={styles.cardActions}>
                    <button
                      aria-expanded={open}
                      className={styles.button}
                      data-agent-connection-details={connection.id}
                      onClick={() => setExpanded(open ? null : connection.id)}
                      type="button"
                    >
                      {open ? "收起详情" : "查看详情"}
                    </button>
                    <button
                      className={`${styles.button} ${styles.buttonQuietDanger}`}
                      data-agent-connection-disconnect={connection.id}
                      disabled={busy}
                      onClick={() => setPendingDisconnect(connection)}
                      type="button"
                    >
                      断开
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionTitle}>连接新应用</h3>
        </div>
        <div className={styles.presetGrid}>
          {PRESETS.map((preset) => {
            const registered = clientsIn(preset.family);
            return (
              <article
                className={styles.preset}
                data-agent-connections-preset={preset.family}
                key={preset.family}
              >
                <h4 className={styles.presetName}>{preset.name}</h4>
                <p className={styles.presetNote}>{preset.note}</p>
                {registered.length === 0 ? (
                  <div className={styles.presetFoot}>
                    <span className={styles.badge} data-tone="muted">
                      未配置
                    </span>
                  </div>
                ) : (
                  registered.map((client) => (
                    <div className={styles.presetFoot} key={client.clientId}>
                      {/* The registration's OWN label, shown when it says
                          something the heading does not. Two registrations in
                          one family are two rows here, each starting the one
                          it names -- the earlier version silently offered
                          only the first and called it by the preset's name. */}
                      {registered.length === 1 &&
                      client.label === preset.name ? null : (
                        <span
                          className={styles.presetClient}
                          data-agent-connections-client-label
                        >
                          {client.label}
                        </span>
                      )}
                      <ClientAction client={client} />
                    </div>
                  ))
                )}
              </article>
            );
          })}
          <article className={styles.preset} data-agent-connections-other>
            <h4 className={styles.presetName}>其他 MCP 客户端</h4>
            <p className={styles.presetNote}>
              {
                "客户端要先由本部署登记——这里没有自助注册。登记之后，任何符合当前 MCP 和 OAuth 接入要求的客户端都能用同一套 ArtVenn 工具：把下面的两个地址填进它的 MCP 配置，再完成一次浏览器授权。"
              }
            </p>
            {/* This used to link to the integration guide on `main`, where that
                file does not exist: every reader got a 404. The addresses an
                integrator needs are already on this page, so the card opens
                them rather than promising a document. */}
            {surface === null ? null : (
              <div className={styles.presetFoot}>
                <button
                  className={styles.button}
                  aria-controls="agent-connections-advanced"
                  aria-expanded={advancedOpen}
                  data-agent-connections-show-advanced
                  onClick={() => setAdvancedOpen(true)}
                  type="button"
                >
                  查看接入地址
                </button>
              </div>
            )}
          </article>
        </div>
        <p className={styles.presetGridNote}>
          {
            "「开始连接」只创建一条尚未授权的记录，本身不授予任何权限。随后在应用里完成授权，浏览器会带你回到这里确认。"
          }
        </p>
      </section>

      {othersClients.length === 0 ? null : (
        <details className={styles.disclosure} data-agent-connections-others>
          <summary>其他已注册客户端（{othersClients.length}）</summary>
          <div className={styles.disclosureBody}>
            <p className={styles.sectionNote}>
              {
                "这些客户端已在本部署登记，可以正常连接；只是 Admin 还没有为它们准备一份设置说明。"
              }
            </p>
            {othersClients.map((client) => (
              <div className={styles.presetFoot} key={client.clientId}>
                <span
                  className={styles.presetClient}
                  data-agent-connections-client-label
                >
                  {client.label}
                </span>
                <ClientAction client={client} />
              </div>
            ))}
          </div>
        </details>
      )}

      {history.length === 0 ? null : (
        <details className={styles.disclosure} data-agent-connections-history>
          <summary>历史连接（{history.length}）</summary>
          <div className={styles.disclosureBody}>
            {history.map((connection) => (
              <div
                className={styles.cardTitleRow}
                data-agent-connection={connection.id}
                key={connection.id}
              >
                <span className={styles.cardTitle}>{nameOf(connection)}</span>
                <span
                  className={styles.badge}
                  data-agent-connection-status={connection.status}
                  data-tone="muted"
                >
                  已断开
                </span>
                <span
                  className={styles.sectionNote}
                  title={connection.revokedAt ?? undefined}
                >
                  {whenText(connection.revokedAt)}
                </span>
                {/* History rows carry no 查看详情, so the one row whose raw
                    status a reader would actually want -- the one where the
                    status column disagrees with this page -- would otherwise
                    have it nowhere on screen. */}
                {connection.status === "revoked" ? null : (
                  <span className={styles.sectionNote}>
                    数据库状态：
                    <span className={styles.mono}>{connection.status}</span>
                  </span>
                )}
              </div>
            ))}
          </div>
        </details>
      )}

      {surface === null ? null : (
        <details
          className={styles.disclosure}
          data-agent-connections-advanced
          id="agent-connections-advanced"
          onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          open={advancedOpen}
          ref={advancedRef}
        >
          <summary>高级信息</summary>
          <div className={styles.disclosureBody}>
            <dl className={styles.detailList}>
              <dt>MCP 地址</dt>
              <dd>
                <CopyValue label="MCP 地址" value={surface.resource} />
              </dd>
              <dt>授权服务</dt>
              <dd>
                <CopyValue label="授权服务地址" value={surface.issuer} />
              </dd>
              <dt>环境</dt>
              <dd>
                <span className={styles.mono}>{surface.environment}</span>
              </dd>
              <dt>认证方式</dt>
              <dd>
                <span
                  className={styles.mono}
                  data-agent-connections-auth-method={surface.authMethod}
                >
                  {AUTH_METHOD_LABEL[surface.authMethod] ?? surface.authMethod}
                </span>
              </dd>
            </dl>
            <p className={styles.sectionNote}>
              {
                "这里不会显示任何令牌、密钥或凭据：客户端通过浏览器授权自行获取，不需要你复制任何东西。"
              }
            </p>
          </div>
        </details>
      )}

      <dialog
        aria-labelledby="agent-connections-confirm-title"
        className={styles.dialog}
        data-agent-connections-confirm
        onCancel={() => setPendingDisconnect(null)}
        onClose={() => setPendingDisconnect(null)}
        ref={dialogRef}
      >
        {pendingDisconnect === null ? null : (
          <div className={styles.dialogBody}>
            <h3
              className={styles.dialogTitle}
              id="agent-connections-confirm-title"
            >
              断开 {nameOf(pendingDisconnect)}？
            </h3>
            {/* Named by the connection, not by a product. The earlier copy said
                "Cursor" for every row, including ones another client had
                registered. */}
            <p className={styles.dialogText}>
              {`断开会立即拒绝这条连接上的访问，包括还没过期的令牌和已经打开的会话。${nameOf(pendingDisconnect)} 本地保存的配置不会被删除，之前已经读取到的信息也不会被撤回。重新连接需要重新授权。`}
            </p>
            <div className={styles.dialogActions}>
              <button
                className={styles.button}
                data-agent-connections-confirm-cancel
                onClick={() => setPendingDisconnect(null)}
                type="button"
              >
                取消
              </button>
              <button
                className={`${styles.button} ${styles.buttonDanger}`}
                data-agent-connections-confirm-accept={pendingDisconnect.id}
                disabled={busy}
                onClick={() => {
                  const id = pendingDisconnect.id;
                  setPendingDisconnect(null);
                  void post("/api/agent-connections/disconnect", { id });
                }}
                type="button"
              >
                确认断开
              </button>
            </div>
          </div>
        )}
      </dialog>
    </section>
  );
};
