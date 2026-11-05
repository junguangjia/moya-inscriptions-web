"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SetStepNav } from "@payloadcms/ui";

import type {
  AdminMcpControlPage,
  AdminMcpSensitiveCategory,
  AdminMcpSwitchRow,
} from "@moya/contracts/internal/admin-mcp";

import styles from "../../community/community.module.css";
import { formatPreciseTime } from "../../community/api";
import { workspacePageLabel } from "../../workspace/routes";
import own from "./control.module.css";

const PAGE_LABEL = workspacePageLabel("/admin/mcp-control");

const SWITCH_NOTES: Readonly<Record<AdminMcpSensitiveCategory, string>> = {
  dm: "允许 AI 读取指定会话的私信内容，且必须说明目的。",
  evidence:
    "允许 AI 读取举报证据的文件和文件名。权利人联系方式在任何状态下都不提供。",
  rawIp:
    "允许 AI 读取原始 IP 与 UA 记录。访问分析的汇总与访客会话不受此开关影响。",
  selfOnly:
    "允许 AI 读取仅自己可见的作品、其下评论和相关举报。未发布的私人草稿不在其中。",
};

const FAILURE_TEXT: Readonly<Record<string, string>> = {
  AUDIT_UNAVAILABLE: "操作记录暂时无法写入，这次更改没有生效。",
  COMPLIANCE_CONFIRMATION_REQUIRED: "确认文字不一致，开关没有开启。",
  COMPLIANCE_ONE_SWITCH_AT_A_TIME: "一次只能开启一个开关。",
  ORIGIN_REQUIRED: "请从管理后台页面发起这次操作。",
  OWNER_ONLY: "需要 Owner 登录会话。",
  RENEW_FAILED: "续期没有生效，请刷新后重试。",
};

/**
 * A custom route answers `error`. Payload answers `errors[].data.code` until an
 * Admin page has built the shared instance, and from then on, in a production
 * build, only `errors[].message`: see `namedRefusal` in ../door.ts.
 */
const failureOf = async (response: Response): Promise<string> => {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    errors?: { data?: { code?: string }; message?: string }[];
  } | null;
  const failure = body?.errors?.[0];
  const code = body?.error ?? failure?.data?.code ?? failure?.message ?? "";
  return FAILURE_TEXT[code] ?? `操作没有执行（${response.status}）。`;
};

const saveControl = (body: Readonly<Record<string, unknown>>) =>
  fetch("/api/globals/mcp-control?depth=0", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const when = (value: string | null) =>
  value === null ? "未设置" : formatPreciseTime(value);

const SwitchRow = ({
  row,
  busy,
  act,
}: {
  readonly row: AdminMcpSwitchRow;
  readonly busy: boolean;
  readonly act: (
    work: () => Promise<Response>,
    done: string,
  ) => Promise<boolean>;
}) => {
  const { label } = row;
  const [typed, setTyped] = useState("");
  const [confirming, setConfirming] = useState(false);
  return (
    <li className={own.switchRow} data-mcp-switch={row.category}>
      <div className={own.switchHead}>
        <strong>{label}</strong>
        <span
          className={styles.chip}
          data-state={row.open ? "pending" : "kind"}
        >
          {row.open ? "已开启" : "已关闭"}
        </span>
        <span
          className={styles.chip}
          data-mcp-policy={row.policyCovers ? "covered" : "uncovered"}
          data-state={row.policyCovers ? "visible" : "hidden"}
        >
          {row.policyCovers ? "政策文本已覆盖" : "政策文本未覆盖"}
        </span>
      </div>
      <p className={styles.lead}>{SWITCH_NOTES[row.category]}</p>
      {row.openedAt === null ? null : (
        <p className={styles.lead}>最近开启：{when(row.openedAt)}</p>
      )}
      {row.open ? (
        <div className={styles.actions}>
          <button
            className={styles.actionButton}
            disabled={busy}
            onClick={() =>
              void act(
                () => saveControl({ [row.category]: false }),
                `已关闭「${label}」。`,
              )
            }
            type="button"
          >
            关闭
          </button>
        </div>
      ) : confirming ? (
        <form
          className={own.confirm}
          onSubmit={(event) => {
            event.preventDefault();
            void act(
              () =>
                saveControl({
                  [row.category]: true,
                  complianceConfirmation: typed,
                }),
              `已开启「${label}」，立即生效。`,
            ).then((saved) => {
              if (saved) setConfirming(false);
            });
          }}
        >
          <label>
            开启前请确认已更新公开政策，并输入：{row.phrase}
            <input
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
              value={typed}
            />
          </label>
          <div className={styles.actions}>
            <button
              className={styles.actionButton}
              data-danger="true"
              disabled={busy || typed !== row.phrase}
              type="submit"
            >
              确认开启
            </button>
            <button
              className={styles.actionButton}
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                setTyped("");
              }}
              type="button"
            >
              取消
            </button>
          </div>
        </form>
      ) : (
        <div className={styles.actions}>
          <button
            className={styles.actionButton}
            disabled={busy}
            onClick={() => setConfirming(true)}
            type="button"
          >
            开启…
          </button>
        </div>
      )}
    </li>
  );
};

/**
 * Reserved to the Owner. Every value arrives as a prop from the server view, and
 * every write crosses the same-origin Payload routes, which decide again.
 */
export const McpControlClient = ({
  page,
}: {
  readonly page: AdminMcpControlPage;
}) => {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [threshold, setThreshold] = useState(String(page.threshold));
  const [receipt, setReceipt] = useState<{
    readonly tone: "success" | "error";
    readonly text: string;
  } | null>(null);

  const act = async (work: () => Promise<Response>, done: string) => {
    if (busy) return false;
    setBusy(true);
    try {
      const response = await work();
      if (!response.ok) {
        setReceipt({ tone: "error", text: await failureOf(response) });
        return false;
      }
      setReceipt({ tone: "success", text: done });
      router.refresh();
      return true;
    } catch {
      setReceipt({ tone: "error", text: "网络没有响应，更改可能没有生效。" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const renew = (id: number) =>
    act(
      () =>
        fetch(`/api/mcp-control/keys/${id}/renew`, {
          method: "POST",
          credentials: "same-origin",
        }),
      "已续期 30 天。",
    );

  return (
    <div className={styles.workspace} data-mcp-control>
      <SetStepNav
        nav={[
          { label: "设置", url: "/admin/community-moderation/settings" },
          { label: PAGE_LABEL },
        ]}
      />
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>{PAGE_LABEL}</h1>
          <p className={styles.lead}>
            这里的设置只有 Owner 能更改，任何密钥都无法读取或修改。
          </p>
        </div>
      </header>

      {receipt === null ? null : (
        <p
          className={styles.notice}
          data-tone={receipt.tone}
          role={receipt.tone === "error" ? "alert" : "status"}
        >
          {receipt.text}
        </p>
      )}

      <div>
        <section className={styles.card} data-mcp-pause={page.pause}>
          <h2>紧急暂停</h2>
          <p className={styles.lead}>
            {page.pause
              ? "已暂停。所有 AI 连接和密钥只能调用 admin_whoami，下一次请求起生效。"
              : "运行中。暂停后所有 AI 连接和密钥只能调用 admin_whoami，后台页面不受影响。"}
          </p>
          <div className={styles.actions}>
            <button
              className={styles.actionButton}
              data-danger={!page.pause || undefined}
              disabled={busy}
              onClick={() =>
                void act(
                  () => saveControl({ pause: !page.pause }),
                  page.pause ? "已恢复。" : "已暂停，下一次请求起生效。",
                )
              }
              type="button"
            >
              {page.pause ? "恢复" : "立即暂停"}
            </button>
          </div>
        </section>

        <section className={styles.card}>
          <h2>不可逆操作确认阈值</h2>
          <p className={styles.lead}>
            单次不可逆操作的对象数超过此数时，需要 Owner 确认一次。
          </p>
          <form
            className={styles.filters}
            onSubmit={(event) => {
              event.preventDefault();
              void act(
                () => saveControl({ threshold: Number(threshold) }),
                `阈值已设为 ${threshold}。`,
              );
            }}
          >
            <label>
              对象数
              <input
                inputMode="numeric"
                min={1}
                onChange={(event) => setThreshold(event.target.value)}
                step={1}
                type="number"
                value={threshold}
              />
            </label>
            <button
              className={styles.actionButton}
              disabled={busy || !/^[1-9][0-9]*$/u.test(threshold)}
              type="submit"
            >
              保存
            </button>
          </form>
        </section>

        <section className={styles.card}>
          <h2>敏感数据开关</h2>
          <p className={styles.lead}>
            默认全部关闭。政策文本状态只作提示，不会阻止开启；先更新公开政策再开启由
            Owner 把握。
          </p>
          <ul className={own.switchList}>
            {page.switches.map((row) => (
              <SwitchRow act={act} busy={busy} key={row.category} row={row} />
            ))}
          </ul>
        </section>

        <section className={styles.card}>
          <h2>即将到期的自动化密钥</h2>
          {page.expiringKeys.length === 0 ? (
            <p className={styles.lead}>7 天内没有到期的自动化密钥。</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>到期时间</th>
                    <th>最近使用</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {page.expiringKeys.map((key) => (
                    <tr data-mcp-key={key.id} key={key.id}>
                      <td>{key.label ?? `密钥 ${key.id}`}</td>
                      <td>{when(key.expiresAt)}</td>
                      <td>
                        {key.lastUsedAt === null ? "—" : when(key.lastUsedAt)}
                      </td>
                      <td>
                        <button
                          className={styles.actionButton}
                          disabled={busy}
                          onClick={() => void renew(key.id)}
                          type="button"
                        >
                          续期 30 天
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className={styles.card}>
          <h2>运行情况</h2>
          {page.figures === null ? (
            <p className={styles.notice} data-tone="error" role="alert">
              操作记录暂时无法读取。
            </p>
          ) : (
            <>
              <ul className={styles.stats}>
                <li>
                  <strong>{page.figures.irreversibleTargets}</strong>
                  <span>24 小时内不可逆操作对象数</span>
                </li>
                <li>
                  <strong>{page.figures.outcomeUnknown}</strong>
                  <span>7 天内结果未知的写入</span>
                </li>
              </ul>
              {page.figures.timings.length === 0 ? (
                <p className={styles.lead}>7 天内没有工具调用。</p>
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>工具</th>
                        <th>调用次数</th>
                        <th>p95（毫秒）</th>
                        <th>预算（毫秒）</th>
                      </tr>
                    </thead>
                    <tbody>
                      {page.figures.timings.map((row) => (
                        <tr data-mcp-timing={row.tool} key={row.tool}>
                          <td>{row.tool}</td>
                          <td>{row.calls}</td>
                          <td>{row.p95Ms}</td>
                          <td>{row.budgetMs ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          <div className={styles.links}>
            <a href="/admin/agent-connections">AI 连接</a>
            <a href="/admin/collections/mcp-audit-events">AI 操作记录</a>
            <a href="/admin/collections/payload-mcp-api-keys">自动化密钥</a>
          </div>
        </section>
      </div>
    </div>
  );
};
