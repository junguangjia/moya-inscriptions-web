"use client";

import { useEffect, useState } from "react";
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

type Tab = "workspace" | "ips" | "status";

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
  workspacePath,
}: {
  readonly workspacePath: string | null;
}) => {
  const [tab, setTab] = useState<Tab>("workspace");
  const [status, setStatus] = useState<AnalyticsStatus | null>(null);
  const [ips, setIps] = useState<AnalyticsIpObservations | null>(null);
  const [error, setError] = useState(false);
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
    setError(false);
    void read("/api/analytics/status", controller.signal)
      .then((result) => setStatus(analyticsStatusSchema.parse(result)))
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [revision]);

  useEffect(() => {
    if (tab !== "ips") return;
    const controller = new AbortController();
    setIps(null);
    setError(false);
    void read("/api/analytics/ips", controller.signal)
      .then((result) => setIps(analyticsIpObservationsSchema.parse(result)))
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [tab, revision]);

  return (
    <section className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1>数据分析</h1>
          <p>省市分布、访问和用户行为 · Umami 只读工作台</p>
        </div>
        <button onClick={() => setRevision((value) => value + 1)} type="button">
          刷新状态
        </button>
      </header>
      <p className={styles.note}>
        本人及开发测试流量在采集时排除。IP 位置表示网络出口的大致位置。
        {deviceExcluded ? " 本设备已加入排除。" : " 本设备正在设置排除。"}
      </p>
      <nav aria-label="分析页面" className={styles.tabs}>
        {(
          [
            ["workspace", "访问与行为"],
            ["ips", "IP 记录"],
            ["status", "采集状态"],
          ] as const
        ).map(([value, label]) => (
          <button
            aria-current={tab === value ? "page" : undefined}
            key={value}
            onClick={() => setTab(value)}
            type="button"
          >
            {label}
          </button>
        ))}
      </nav>
      {error ? (
        <p role="alert">暂时无法读取采集数据。请检查服务配置后刷新。</p>
      ) : null}
      {tab === "workspace" ? (
        workspacePath ? (
          <>
            <p className={styles.note}>
              默认显示省份与城市排行；点击省份可筛选城市，国家保留为筛选条件。
              台湾省纳入省份排行，省市名称以中文显示；定位缺失不猜补。
              <a href={workspacePath} rel="noreferrer" target="_blank">
                全屏打开
              </a>
            </p>
            <iframe
              className={styles.workspace}
              referrerPolicy="no-referrer"
              src={workspacePath}
              title="Umami 访问与行为分析"
            />
          </>
        ) : (
          <p role="status">
            Umami 尚未配置。完成独立数据库、只读账号及省市看板初始化并配置看板
            后，这里将显示实际看板。
          </p>
        )
      ) : null}
      {tab === "ips" ? (
        <>
          <p className={styles.note}>
            最近 7 天内最新 50 批访问的可信来源 IP，仅限管理员。地域分布请查看
            Umami 工作台。
          </p>
          {ips ? (
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
      {tab === "status" ? (
        status ? (
          <>
            <dl className={styles.metrics}>
              {[
                ["采集", status.enabled ? "已启用" : "未启用"],
                [
                  "Umami 转发",
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
              这里按事件 ID 去重；Umami
              是异步投递后的分析视图，重试和原生会话口径可能使计数不同。
            </p>
          </>
        ) : (
          <p role="status">正在读取采集状态…</p>
        )
      ) : null}
    </section>
  );
};
