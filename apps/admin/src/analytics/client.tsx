"use client";
import { useEffect, useState } from "react";
import { SetStepNav } from "@payloadcms/ui";
import {
  analyticsIpObservationsSchema,
  analyticsStatusSchema,
} from "@moya/contracts/analytics";
import type {
  AnalyticsIpObservations,
  AnalyticsStatus,
} from "@moya/contracts/analytics";
import {
  excludeOwnerAnalyticsDevice,
  prepareOwnerAnalyticsEntry,
} from "./device";
import { workspacePageLabel } from "../workspace/routes";
import { UiIcon } from "../workspace/Icon";
import styles from "./analytics.module.css";

export const AnalyticsClient = ({
  mode,
  workspacePath,
}: {
  readonly mode: "open" | "board" | "ips" | "status";
  readonly workspacePath?: string | null;
}) => {
  const isEntry = mode === "open" || mode === "board";
  const [ips, setIps] = useState<AnalyticsIpObservations | null>(null);
  const [status, setStatus] = useState<AnalyticsStatus | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const path =
    mode === "board"
      ? "/admin/analytics/board"
      : mode === "ips"
        ? "/admin/analytics/ips"
        : mode === "status"
          ? "/admin/analytics/status"
          : "/admin/analytics";
  const title = workspacePageLabel(path);
  useEffect(() => {
    const controller = new AbortController();
    void (
      isEntry
        ? prepareOwnerAnalyticsEntry(controller.signal)
        : excludeOwnerAnalyticsDevice(controller.signal)
    ).then(() => {
      // Finish the bounded exclusion attempts before crossing documents.
      if (!controller.signal.aborted && isEntry && workspacePath)
        window.location.replace(workspacePath);
    });
    return () => controller.abort();
  }, [isEntry, workspacePath]);
  useEffect(() => {
    if (isEntry) return;
    const controller = new AbortController();
    setError(false);
    setIps(null);
    setStatus(null);
    void fetch(`/api/analytics/${mode}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("UNAVAILABLE");
        return response.json() as Promise<unknown>;
      })
      .then((value) => {
        if (mode === "ips") setIps(analyticsIpObservationsSchema.parse(value));
        else setStatus(analyticsStatusSchema.parse(value));
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [isEntry, mode, revision]);
  return (
    <section className={styles.root}>
      <SetStepNav
        nav={[{ label: "数据", url: "/admin/analytics" }, { label: title }]}
      />
      <header className={styles.header}>
        <div>
          <h1>{title}</h1>
          <p>
            {mode === "ips"
              ? "最近7天最新50批访问的可信来源IP，仅限管理员。"
              : mode === "status"
                ? "查看采集、同步、排除规则和数据保留状态。"
                : "完整的网站分析、筛选和访问详情。"}
          </p>
        </div>
        {!isEntry && (
          <button
            type="button"
            onClick={() => setRevision((v) => v + 1)}
            aria-label="刷新"
            title="刷新"
          >
            <UiIcon name="loading" size="sm" />
          </button>
        )}
      </header>
      {isEntry ? (
        workspacePath ? (
          <p role="status">
            正在打开完整访问分析… <a href={workspacePath}>继续打开</a>
          </p>
        ) : (
          <p role="alert">
            暂时无法连接统计。<a href={path}>重新读取</a>
            ，或联系维护人员。
          </p>
        )
      ) : error ? (
        <p role="alert">暂时无法读取，请刷新重试。</p>
      ) : mode === "ips" ? (
        ips ? (
          ips.items.length ? (
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>来源IP</th>
                    <th>访问时间</th>
                    <th>登录用户 / 匿名访客</th>
                    <th>自动过期</th>
                  </tr>
                </thead>
                <tbody>
                  {ips.items.map((item) => (
                    <tr key={item.id}>
                      <td>{item.ip}</td>
                      <td>
                        {new Date(item.receivedAt).toLocaleString("zh-CN")}
                      </td>
                      <td>{item.userId ?? item.visitorId}</td>
                      <td>
                        {new Date(item.expiresAt).toLocaleString("zh-CN")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p role="status">当前没有符合条件的访问记录。</p>
          )
        ) : (
          <p role="status">正在读取…</p>
        )
      ) : status ? (
        <>
          <dl className={styles.metrics}>
            {[
              ["采集", status.enabled ? "已启用" : "未启用"],
              ["数据同步", status.forwardingConfigured ? "已配置" : "未配置"],
              [
                "本人账号排除",
                status.ownerExclusionConfigured ? "已配置" : "未配置",
              ],
              ["24小时事件", status.last24Hours.events],
              ["24小时浏览器访客标识", status.last24Hours.visitors],
              ["24小时登录账号", status.last24Hours.users],
              ["24小时会话", status.last24Hours.sessions],
              ["待同步", status.outbox.pending],
              ["同步失败", status.outbox.failed],
              ["事件保留", `${status.eventRetentionDays}天`],
              ["原始IP保留", `${status.ipRetentionDays}天`],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className={styles.note}>
            浏览器访客标识与登录账号分别去重，不能相加作为总人数。采集记录与分析服务使用不同口径，请分别查看。
          </p>
        </>
      ) : (
        <p role="status">正在读取…</p>
      )}
    </section>
  );
};
