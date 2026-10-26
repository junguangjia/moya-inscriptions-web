"use client";

import { useEffect, useState } from "react";
import { SetStepNav } from "@payloadcms/ui";
import {
  analyticsIpObservationsSchema,
  analyticsStatusSchema,
} from "@moya/contracts/analytics";
import type {
  AnalyticsStatus,
  AnalyticsIpObservations,
} from "@moya/contracts/analytics";

import styles from "./analytics.module.css";
import { excludeOwnerAnalyticsDevice } from "./device";
import { UiIcon } from "../workspace/Icon";
import { NativeAnalytics } from "./native";
import { workspacePageLabel } from "../workspace/routes";

const read = async (path: string, signal: AbortSignal) => {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("unavailable");
  return response.json() as Promise<unknown>;
};

export const AnalyticsClient = ({
  configured,
}: {
  readonly configured: boolean;
}) => {
  const [showIps, setShowIps] = useState(false);
  const [status, setStatus] = useState<AnalyticsStatus | null>(null);
  const [ips, setIps] = useState<AnalyticsIpObservations | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [ipsError, setIpsError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [deviceExcluded, setDeviceExcluded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void excludeOwnerAnalyticsDevice(controller.signal).then((excluded) => {
      if (!controller.signal.aborted) setDeviceExcluded(excluded);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setStatusError(false);
    setStatus(null);
    void read("/api/analytics/status", controller.signal)
      .then((result) => setStatus(analyticsStatusSchema.parse(result)))
      .catch(() => {
        if (!controller.signal.aborted) setStatusError(true);
      });
    return () => controller.abort();
  }, [revision]);

  useEffect(() => {
    if (!showIps) return;
    const controller = new AbortController();
    setIps(null);
    setIpsError(false);
    void read("/api/analytics/ips", controller.signal)
      .then((result) => setIps(analyticsIpObservationsSchema.parse(result)))
      .catch(() => {
        if (!controller.signal.aborted) setIpsError(true);
      });
    return () => controller.abort();
  }, [showIps, revision]);

  return (
    <section className={styles.root}>
      <SetStepNav nav={[{ label: "数据" }, { label: "访问分析" }]} />
      <header className={styles.header}>
        <div>
          <h1>{workspacePageLabel("/admin/analytics")}</h1>
          <p>查看访问趋势、地域分布和用户行为。</p>
        </div>
      </header>
      <p className={styles.note}>
        本人及开发测试流量应排除在统计之外。IP 位置表示网络出口的大致位置。
        {deviceExcluded ? " 本设备已加入排除。" : " 本设备排除状态尚未确认。"}
      </p>
      {configured ? (
        <NativeAnalytics />
      ) : (
        <p className={styles.notice} role="status">
          访问统计暂未连接，请联系维护人员。
        </p>
      )}
      <details
        className={styles.details}
        onToggle={(event) => setShowIps(event.currentTarget.open)}
      >
        <summary>IP 访问记录</summary>
        <button type="button" onClick={() => setRevision((value) => value + 1)}>
          <UiIcon name="loading" size="sm" /> 刷新访问记录
        </button>
        {showIps ? (
          <>
            <p className={styles.note}>
              最近 7 天的最新 50 批访问记录。地域分布见上方地图。
            </p>
            {ipsError ? (
              <p role="alert">暂时无法读取访问记录，请重试。</p>
            ) : ips ? (
              ips.items.length ? (
                <div className={styles.tableScroll}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>来源 IP</th>
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
              <p role="status">正在读取 IP 记录…</p>
            )}
          </>
        ) : null}
      </details>
      <details className={styles.details}>
        <summary>采集状态</summary>
        <button type="button" onClick={() => setRevision((value) => value + 1)}>
          <UiIcon name="loading" size="sm" /> 刷新采集状态
        </button>
        {statusError ? (
          <p role="alert">暂时无法读取采集状态，请刷新重试。</p>
        ) : status ? (
          <>
            <dl className={styles.metrics}>
              {[
                ["采集", status.enabled ? "已启用" : "未启用"],
                [
                  "统计分析连接",
                  status.forwardingConfigured ? "已配置" : "未配置",
                ],
                [
                  "本人账号排除",
                  status.ownerExclusionConfigured ? "已配置" : "未配置",
                ],
                ["24 小时事件", status.last24Hours.events],
                ["24 小时浏览器访客标识", status.last24Hours.visitors],
                ["24 小时登录账号", status.last24Hours.users],
                ["24 小时会话", status.last24Hours.sessions],
                ["待转发", status.outbox.pending],
                ["转发失败", status.outbox.failed],
                ["事件保留", `${status.eventRetentionDays} 天`],
                ["原始 IP 保留", `${status.ipRetentionDays} 天`],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <p className={styles.note}>
              事件是实际页面与内容行为；HTTP 请求、通知心跳及图片预加载不计入。
              浏览器标识包含匿名和登录行为，与登录账号分别去重，不能相加作为总人数。
              采集记录与上方访问统计使用不同去重口径，请分别查看。
            </p>
          </>
        ) : (
          <p role="status">正在读取采集状态…</p>
        )}
      </details>
    </section>
  );
};
