"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { workspacePageLabel } from "../workspace/routes";
import { ConnectionsStepNav, CopyValue, whenText } from "./connections-client";

import community from "../community/community.module.css";
import styles from "./connections.module.css";

/**
 * The `AI 连接` page under the login door, for administrators who may know little
 * about computers, on a phone or a computer. The Development read-only profile keeps
 * its own page in `connections-client.tsx`.
 *
 * It offers no key, because a person connects by signing in. It shows only what the
 * database recorded: "last used" is the last request that authenticated, never a
 * claim that a tool is online. Any owner sees every connection and may stop any of
 * them, with equal power and a real risk of a stolen tool account. No secret reaches
 * this component: the list sends no token, key, cookie or ticket.
 *
 * A grant the issuer revoked itself is still listed until someone disconnects it,
 * which section 22 of the record states as a limit.
 */

const PAGE_LABEL = workspacePageLabel("/admin/agent-connections");

/** The name a tool shows for this connection. It is ours, not a vendor's field. */
const CONNECTOR_NAME = "由于艺后台";

interface ListedConnection {
  readonly id: string;
  readonly family: string;
  readonly tool: string | null;
  readonly authorizedBy: string | null;
  readonly mine: boolean;
  readonly consentedAt: string | null;
  readonly lastVerifiedAt: string | null;
}

interface ListedSurface {
  readonly resource: string;
  readonly families: ReadonlySet<string>;
  readonly connections: readonly ListedConnection[];
}

/**
 * Claude's own "add custom connector" dialog with the name and address filled in.
 * A team plan's administrator adds it once from the settings path instead. Claude
 * still asks the person to confirm, which is its rule and not ours.
 */
const claudeConnectorLink = (
  settings: "customize" | "admin-settings",
  address: string,
): string => {
  const link = new URL(`https://claude.ai/${settings}/connectors`);
  link.searchParams.set("modal", "add-custom-connector");
  link.searchParams.set("connectorName", CONNECTOR_NAME);
  link.searchParams.set("connectorUrl", address);
  return link.href;
};

/** Offered only for a tool on this deployment's closed list. */
const OTHER_TOOLS: readonly {
  readonly family: string;
  readonly name: string;
  readonly steps: (address: string) => readonly React.ReactNode[];
  /** The same tool from its terminal, where there is no settings window. */
  readonly terminal?: (address: string) => readonly React.ReactNode[];
}[] = [
  {
    family: "claude-code",
    name: "Claude Code",
    steps: (address) => [
      // User scope, so artvenn is there whichever folder claude starts in.
      <span className={styles.stepCopy} key="command">
        在终端运行：
        <CopyValue
          label="命令"
          value={`claude mcp add --transport http --scope user artvenn ${address}`}
        />
      </span>,
      "启动 claude，输入 /mcp，选择 artvenn，再选 Authenticate。",
      "浏览器打开后，登录后台并点「允许」。",
    ],
  },
  {
    family: "codex",
    name: "Codex",
    steps: () => [
      "打开设置，进入 MCP servers，点 Add server，填一个名字（例如 artvenn），选 Streamable HTTP。",
      "粘贴上面的地址，保存，然后重启 Codex。",
      "点 Authenticate，在浏览器里登录后台并点「允许」。",
    ],
    terminal: (address) => [
      <span className={styles.stepCopy} key="add">
        运行：
        <CopyValue
          label="命令"
          value={`codex mcp add artvenn --url ${address}`}
        />
      </span>,
      <span className={styles.stepCopy} key="login">
        再运行：
        <CopyValue label="命令" value="codex mcp login artvenn" />
      </span>,
      "浏览器打开后，登录后台并点「允许」。",
    ],
  },
  {
    family: "chatgpt",
    name: "ChatGPT",
    steps: () => [
      "打开 chatgpt.com/plugins，点 +，选 Add custom MCP server。",
      "填名称和上面的地址，认证方式选 OAuth，接受提示后创建并安装。",
      "在打开的页面里登录后台并点「允许」。",
    ],
  },
];

const FAILURE_TEXT: Readonly<Record<string, string>> = {
  CONNECTION_NOT_FOUND: "这条连接已经不存在了。",
  NETWORK: "网络没有响应，请稍后再试。",
  ORIGIN_REQUIRED: "请从后台页面发起这次操作。",
  OWNER_ONLY: "需要管理员登录。请刷新页面后重新登录。",
};

const failureSentence = (code: string): string =>
  FAILURE_TEXT[code] ?? "暂时无法完成，请稍后再试。";

const parsed = async (
  response: Response,
): Promise<{ ok?: unknown; error?: unknown; result?: unknown }> => {
  const payload: unknown = await response.json();
  return typeof payload === "object" && payload !== null ? payload : {};
};

const toolName = (connection: ListedConnection): string =>
  connection.tool ?? "已不在清单中的工具";

const authorizerName = (connection: ListedConnection): string =>
  `${connection.authorizedBy ?? "账号已不存在"}${connection.mine ? "（你）" : ""}`;

export const OperatorConnectionsClient = ({
  address,
}: {
  /** From this deployment's public address. Null falls back to the list's. */
  readonly address: string | null;
}) => {
  const [surface, setSurface] = useState<ListedSurface | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<ListedConnection | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const listHeadingRef = useRef<HTMLHeadingElement | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/agent-connections", {
        credentials: "same-origin",
      });
      const body = await parsed(response);
      if (!response.ok || body.ok !== true) {
        setFailure(typeof body.error === "string" ? body.error : "REFUSED");
        return;
      }
      const result = body.result as {
        resource?: string;
        clients?: readonly { readonly family: string }[];
        connections?: readonly ListedConnection[];
      };
      setSurface({
        resource: result.resource ?? "",
        families: new Set((result.clients ?? []).map(({ family }) => family)),
        connections: result.connections ?? [],
      });
      setFailure(null);
    } catch {
      setFailure("NETWORK");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A modal, so the platform supplies the focus trap, the backdrop and Escape.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (pending !== null && !dialog.open) dialog.showModal();
    if (pending === null && dialog.open) dialog.close();
  }, [pending]);

  // The button that opened the dialog leaves with its row, and focus would fall to
  // the page. The receipt is read out as a status; the list is where to go on from.
  useEffect(() => {
    if (receipt !== null) listHeadingRef.current?.focus();
  }, [receipt]);

  const disconnect = async (connection: ListedConnection) => {
    setPending(null);
    setBusy(true);
    setReceipt(null);
    try {
      const response = await fetch("/api/agent-connections/disconnect", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: connection.id }),
      });
      const body = await parsed(response);
      if (!response.ok || body.ok !== true) {
        setFailure(typeof body.error === "string" ? body.error : "REFUSED");
        return;
      }
      setFailure(null);
      await load();
      setReceipt(`已断开「${toolName(connection)}」。`);
    } catch {
      setFailure("NETWORK");
    } finally {
      setBusy(false);
    }
  };

  const toolAddress = address ?? surface?.resource ?? "";
  const families = surface?.families;
  const others = OTHER_TOOLS.filter(({ family }) => families?.has(family));

  return (
    <div
      className={community.workspace}
      data-agent-connections
      data-agent-connections-resource={surface?.resource}
    >
      <ConnectionsStepNav />
      <header className={community.header}>
        <div>
          <h1 className={community.title}>{PAGE_LABEL}</h1>
          <p className={community.lead}>
            {
              "在工具里点连接，用你的后台账号登录，再点允许，就连上了，不需要密钥。每个工具都需要你自己有这个工具的账号。"
            }
          </p>
        </div>
      </header>

      {failure === null ? null : (
        <p
          className={community.notice}
          data-agent-connections-error={failure}
          data-tone="error"
          role="alert"
        >
          {failureSentence(failure)}{" "}
          <small className={styles.code}>{failure}</small>
        </p>
      )}
      {receipt === null ? null : (
        <p className={community.notice} data-tone="success" role="status">
          {receipt}
        </p>
      )}

      {surface === null || toolAddress === "" ? null : (
        <section className={community.card} data-agent-connections-connect>
          <h2>连接一个工具</h2>
          {families?.has("claude") ? (
            <div className={styles.connectClaude}>
              <a
                className={styles.connectButton}
                data-agent-connections-claude
                href={claudeConnectorLink("customize", toolAddress)}
                rel="noopener noreferrer"
                target="_blank"
              >
                连接到 Claude
              </a>
              <p className={community.lead}>
                {
                  "在 Claude 打开的窗口里点 Add，再登录后台并点「允许」。之后在对话的 + 菜单里打开这个连接。"
                }
              </p>
              <a
                className={styles.quietLink}
                data-agent-connections-claude-team
                href={claudeConnectorLink("admin-settings", toolAddress)}
                rel="noopener noreferrer"
                target="_blank"
              >
                团队版管理员：为整个团队添加
              </a>
            </div>
          ) : null}
          <div className={styles.address} data-agent-connections-address>
            <span className={community.lead}>其他工具填这个地址：</span>
            <CopyValue label="地址" value={toolAddress} />
          </div>
          {others.length === 0 ? null : (
            <div className={styles.stepGrid}>
              {others.map(({ family, name, steps, terminal }) => (
                <details
                  className={styles.stepCard}
                  data-agent-connections-steps={family}
                  key={family}
                >
                  <summary>{name}</summary>
                  <ol className={styles.stepList}>
                    {steps(toolAddress).map((step, index) => (
                      <li key={index}>{step}</li>
                    ))}
                  </ol>
                  {terminal === undefined ? null : (
                    <>
                      <p className={styles.stepLabel}>在终端里用 {name}：</p>
                      <ol
                        className={styles.stepList}
                        data-agent-connections-terminal={family}
                      >
                        {terminal(toolAddress).map((step, index) => (
                          <li key={index}>{step}</li>
                        ))}
                      </ol>
                    </>
                  )}
                </details>
              ))}
            </div>
          )}
        </section>
      )}

      <section className={community.card}>
        <h2 ref={listHeadingRef} tabIndex={-1}>
          已连接的工具
        </h2>
        {surface === null ? null : surface.connections.length === 0 ? (
          <p className={community.lead} data-agent-connections-empty>
            还没有连接任何工具。
          </p>
        ) : (
          <table className={styles.connectionTable}>
            <thead>
              <tr>
                <th scope="col">工具</th>
                <th scope="col">授权人</th>
                <th scope="col">授权时间</th>
                <th scope="col">最近使用</th>
                <th scope="col">
                  <span className={styles.visuallyHidden}>操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {surface.connections.map((connection) => (
                <tr
                  data-agent-connection={connection.id}
                  data-agent-connection-family={connection.family}
                  key={connection.id}
                >
                  <td data-agent-connection-client data-label="工具">
                    {toolName(connection)}
                  </td>
                  <td data-agent-connection-authorized-by data-label="授权人">
                    {authorizerName(connection)}
                  </td>
                  <td
                    data-label="授权时间"
                    title={connection.consentedAt ?? undefined}
                  >
                    {whenText(connection.consentedAt)}
                  </td>
                  <td
                    data-agent-connection-last-verified={
                      connection.lastVerifiedAt ?? ""
                    }
                    data-label="最近使用"
                    title={connection.lastVerifiedAt ?? undefined}
                  >
                    {connection.lastVerifiedAt === null
                      ? "还没用过"
                      : whenText(connection.lastVerifiedAt)}
                  </td>
                  <td>
                    {/* Each row's button says whose tool it stops: at phone width the
                        rows are cards, and a screen reader may not read them as a table. */}
                    <button
                      aria-label={`断开「${toolName(connection)}」，授权人：${authorizerName(connection)}`}
                      className={community.actionButton}
                      data-agent-connection-disconnect={connection.id}
                      data-danger="true"
                      disabled={busy}
                      onClick={() => setPending(connection)}
                      type="button"
                    >
                      断开
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className={community.lead}>
          {
            "任何管理员都可以看到并断开这里的每一条连接，别人新连接的工具也会在后台提醒你。同一个人在第二台电脑上连接同一个工具，会结束第一台上的连接。"
          }
        </p>
        <p className={community.lead} data-agent-connections-pause>
          要一次停掉所有工具，到
          <a className={styles.quietLink} href="/admin/mcp-control">
            AI 控制
          </a>
          页暂停。
        </p>
      </section>

      <dialog
        aria-labelledby="agent-connections-confirm-title"
        className={styles.dialog}
        data-agent-connections-confirm
        onCancel={() => setPending(null)}
        onClose={() => setPending(null)}
        ref={dialogRef}
      >
        {pending === null ? null : (
          <div className={styles.dialogBody}>
            <h2
              className={styles.dialogTitle}
              id="agent-connections-confirm-title"
            >
              断开「{toolName(pending)}」？
            </h2>
            <p className={styles.dialogText}>
              断开后这个工具立刻不能再访问后台。要再用，需要重新连接并点允许。它之前读到的内容不会被撤回。
            </p>
            <div className={styles.dialogActions}>
              <button
                className={community.actionButton}
                data-agent-connections-confirm-cancel
                onClick={() => setPending(null)}
                type="button"
              >
                取消
              </button>
              <button
                className={community.actionButton}
                data-agent-connections-confirm-accept={pending.id}
                data-danger="true"
                disabled={busy}
                onClick={() => void disconnect(pending)}
                type="button"
              >
                确认断开
              </button>
            </div>
          </div>
        )}
      </dialog>
    </div>
  );
};
