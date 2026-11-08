"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SetStepNav } from "@payloadcms/ui";

import type {
  AdminMcpAwaitingRun,
  AdminMcpControlPage,
  AdminMcpSensitiveCategory,
  AdminMcpStalledRun,
  AdminMcpSwitchRow,
  AdminPreviewConsequence,
  AdminRunState,
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

/** What each hazard means, as the preview named it; every one has its sentence. */
const CONSEQUENCE_TEXT: Readonly<Record<AdminPreviewConsequence, string>> = {
  body_deleted_permanently:
    "每条评论的正文会被永久删除，任何人都无法恢复，Owner 也不能；其下的回复保留。",
  thread_removed:
    "每个讨论串会连同其中所有回复离开公开页面；只有推翻移除的复核能恢复。",
  job_not_retried:
    "每个任务会停止，且不会再被排期；没做完的工作要有人手动重试。",
  purge_not_retried:
    "清除任务会停止：要清除的数据留在原处，也不会再被排期清除。",
  forwarded_to_other_party: "对方会立即收到这段文字，无法撤回或修改。",
  legal_hold_released:
    "案件的法律保全会解除；关闭超过三年的案件，证据可能随即按保留期删除。",
  identity_bound_permanently:
    "每个新身份会永久绑定到它的记录，即使撤回，也不能再指向其他记录。",
  subject_notified: "每位当事人都会收到一条关于此操作的消息，消息无法撤回。",
};

const STATE_TEXT: Readonly<Partial<Record<AdminRunState, string>>> = {
  planning: "规划中",
  running: "执行中",
  settling: "等待后台任务",
};

const FAILURE_TEXT: Readonly<Record<string, string>> = {
  AUDIT_UNAVAILABLE: "操作记录暂时无法写入，这次更改没有生效。",
  COMPLIANCE_CONFIRMATION_REQUIRED: "确认文字不一致，开关没有开启。",
  COMPLIANCE_ONE_SWITCH_AT_A_TIME: "一次只能开启一个开关。",
  CONCURRENT_OPERATION_BUSY: "这项操作正在执行，暂时不能取消，请稍后重试。",
  NOT_FOUND: "没有找到这项操作，请刷新页面。",
  ORIGIN_REQUIRED: "请从管理后台页面发起这次操作。",
  OWNER_ONLY: "需要 Owner 登录会话。",
  RENEW_FAILED: "续期没有生效，请刷新后重试。",
  RUN_ACTION_FAILED: "这项操作没有改变，请刷新后重试。",
  RUN_CANCELLED: "这项操作已经取消。",
  RUN_EXPIRED: "这项操作已过期，没有执行。",
  RUN_NOT_AWAITING: "这项操作已不在等待确认，请刷新页面。",
  RUN_STALE: "这项操作的定义已更新，原预览已失效，没有执行。",
  SEAL_HASH_MISMATCH: "这项操作的内容和页面显示的不一致，请刷新后重新查看。",
  SEAL_HASH_REQUIRED: "请刷新页面后再确认。",
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

type Act = (work: () => Promise<Response>, done: string) => Promise<boolean>;

const runAction = (
  runId: string,
  action: "confirm" | "cancel",
  body: Readonly<Record<string, unknown>> = {},
) =>
  fetch(`/api/mcp-control/runs/${runId}/${action}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const credentialOf = (run: {
  readonly credential: string;
  readonly credentialLabel: string | null;
}) =>
  run.credentialLabel === null
    ? run.credential
    : `${run.credentialLabel}（${run.credential}）`;

/**
 * One run past the threshold, as its preview froze it. Everything the caller wrote is
 * shown as text: React escapes it, and no field here is ever read as markup.
 */
const AwaitingRunRow = ({
  run,
  busy,
  act,
}: {
  readonly run: AdminMcpAwaitingRun;
  readonly busy: boolean;
  readonly act: Act;
}) => (
  <li className={own.runRow} data-mcp-run={run.runId}>
    <div className={own.switchHead}>
      <strong>
        <code>{run.op}</code>
      </strong>
      <span className={styles.chip} data-state="pending">
        {run.count} 个对象
      </span>
      {run.conflicts > 0 ? (
        <span className={styles.chip} data-state="kind">
          另有 {run.conflicts} 个预览时已冲突，不会执行
        </span>
      ) : null}
    </div>
    <p className={styles.lead}>
      来自 {credentialOf(run)}，{when(run.expiresAt)} 前未确认即过期。
    </p>
    {run.reason === null ? null : (
      <p className={own.reason}>
        <span>理由：</span>
        {run.reason}
      </p>
    )}
    {run.consequences.length === 0 ? null : (
      <ul className={own.facts}>
        {run.consequences.map((code) => (
          <li data-mcp-consequence={code} key={code}>
            {CONSEQUENCE_TEXT[code]}
          </li>
        ))}
      </ul>
    )}
    <ul className={own.facts}>
      {run.userNotifications > 0 ? (
        <li>{run.userNotifications} 位当事人会收到消息。</li>
      ) : null}
      {run.impact === null
        ? null
        : Object.entries(run.impact).map(([name, count]) => (
            <li key={name}>
              <code>{name}</code>：{count}
            </li>
          ))}
      {run.newIdentities === null ? null : (
        <li>
          永久绑定 {run.newIdentities.count} 个新身份
          {run.newIdentities.first.length === 0
            ? "。"
            : `，例如：${run.newIdentities.first
                .slice(0, 5)
                .map(({ field, value }) => `${field} ${value}`)
                .join("、")}`}
        </li>
      )}
      {run.sample.length === 0 ? null : (
        <li>
          示例对象：
          {run.sample
            .map(({ index, ref }) =>
              ref === null ? `#${index}` : `#${index} ${String(ref)}`,
            )
            .join("、")}
        </li>
      )}
    </ul>
    <div className={styles.actions}>
      <button
        className={styles.actionButton}
        data-danger="true"
        data-mcp-run-confirm={run.runId}
        disabled={busy}
        onClick={() =>
          void act(
            () =>
              runAction(run.runId, "confirm", {
                expectedSealHash: run.sealHash,
              }),
            `已确认，AI 可以继续执行这 ${run.count} 个对象。`,
          )
        }
        type="button"
      >
        确认执行
      </button>
      <button
        className={styles.actionButton}
        data-mcp-run-cancel={run.runId}
        disabled={busy}
        onClick={() =>
          void act(() => runAction(run.runId, "cancel"), "已取消这项操作。")
        }
        type="button"
      >
        取消操作
      </button>
    </div>
  </li>
);

const StalledRunRow = ({
  run,
  busy,
  act,
}: {
  readonly run: AdminMcpStalledRun;
  readonly busy: boolean;
  readonly act: Act;
}) => (
  <li className={own.runRow} data-mcp-stalled-run={run.runId}>
    <div className={own.switchHead}>
      <strong>
        <code>{run.op}</code>
      </strong>
      <span className={styles.chip} data-state="kind">
        {STATE_TEXT[run.state] ?? run.state}
      </span>
      <span className={styles.chip} data-state="pending">
        已完成 {run.done} / {run.count}
      </span>
    </div>
    <p className={styles.lead}>
      来自 {credentialOf(run)}，最近一次进展在 {when(run.updatedAt)}。
    </p>
    <div className={styles.actions}>
      <button
        className={styles.actionButton}
        data-mcp-run-cancel={run.runId}
        disabled={busy}
        onClick={() =>
          void act(() => runAction(run.runId, "cancel"), "已取消这项操作。")
        }
        type="button"
      >
        取消操作
      </button>
    </div>
  </li>
);

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
  connections,
  page,
}: {
  /** The login door is on. Off, the page reads as it did before the door. */
  readonly connections: boolean;
  readonly page: AdminMcpControlPage;
}) => {
  // The space keeps "所有 AI" apart, as Latin letters are after Chinese.
  const credentials = connections ? " AI 连接和密钥" : "密钥";
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
              ? `已暂停。所有${credentials}只能调用 admin_whoami，下一次请求起生效。`
              : `运行中。暂停后所有${credentials}只能调用 admin_whoami，后台页面不受影响。`}
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

        <section className={styles.card} data-mcp-awaiting-runs>
          <h2>等待确认的操作</h2>
          {page.runs === null ? (
            <p className={styles.notice} data-tone="error" role="alert">
              操作列表暂时无法读取。
            </p>
          ) : page.runs.awaiting.length === 0 ? (
            <p className={styles.lead}>没有等待确认的操作。</p>
          ) : (
            <>
              <p className={styles.lead}>
                对象数超过阈值的不可逆操作，确认一次即可由 AI
                继续执行；确认只对页面显示的这一批有效。
              </p>
              <ul className={own.runList}>
                {page.runs.awaiting.map((run) => (
                  <AwaitingRunRow
                    act={act}
                    busy={busy}
                    key={run.runId}
                    run={run}
                  />
                ))}
              </ul>
            </>
          )}
        </section>

        {page.runs === null || page.runs.stalled.length === 0 ? null : (
          <section className={styles.card} data-mcp-stalled-runs>
            <h2>停滞的操作</h2>
            <p className={styles.lead}>
              超过 10 分钟没有进展。原来的
              {connections ? " AI 连接或密钥" : "密钥"}
              可以继续执行，也可以在这里取消；已执行的对象保持原状。
            </p>
            <ul className={own.runList}>
              {page.runs.stalled.map((run) => (
                <StalledRunRow
                  act={act}
                  busy={busy}
                  key={run.runId}
                  run={run}
                />
              ))}
            </ul>
          </section>
        )}

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
          <h2>即将到期的{connections ? "自动化密钥" : "密钥"}</h2>
          {page.expiringKeys.length === 0 ? (
            <p className={styles.lead}>
              7 天内没有到期的{connections ? "自动化密钥" : "密钥"}。
            </p>
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
                {page.figures.irreversibleByCredential.map((row) => (
                  <li key={row.credential}>
                    <strong>{row.targets}</strong>
                    <span>其中 {row.credential}</span>
                  </li>
                ))}
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
            {connections ? (
              <a href="/admin/agent-connections">AI 连接</a>
            ) : null}
            <a href="/admin/collections/mcp-audit-events">AI 操作记录</a>
            <a href="/admin/collections/payload-mcp-api-keys">自动化密钥</a>
          </div>
        </section>
      </div>
    </div>
  );
};
