"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { useSearchParams } from "next/navigation";
import {
  ADMIN_ANALYTICS_PROVINCE_CODES,
  adminAnalyticsReportSchema,
  type AdminAnalyticsReport,
  type AdminAnalyticsMetricRow,
} from "@moya/contracts/admin-analytics";

import { UiIcon } from "../workspace/Icon";
import styles from "./analytics.module.css";

type Resource = AdminAnalyticsReport["resource"];
type Report<R extends Resource> = Extract<
  AdminAnalyticsReport,
  { resource: R }
>;
type ReadState<R extends Resource> = {
  key: string;
  data: Report<R> | null;
  loading: boolean;
  error: string | null;
};
const count = (value: number) => value.toLocaleString("zh-CN");
const countryName = (value: string | null | undefined) => {
  if (!value) return "位置未提供";
  try {
    return (
      new Intl.DisplayNames(["zh-Hans"], { type: "region" }).of(value) || value
    );
  } catch {
    return value;
  }
};
const dateString = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const recentDates = (days: number) => {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);
  return { from: dateString(start), to: dateString(end) };
};

function useReport<R extends Resource>(
  resource: R,
  params: Record<string, string | number | undefined>,
  revision: number,
  enabled: boolean,
) {
  const query = new URLSearchParams({ resource });
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) query.set(name, String(value));
  }
  const url = `/api/analytics/report?${query}`;
  const key = `${revision}:${url}`;
  const [state, setState] = useState<ReadState<R>>({
    key: "",
    data: null,
    loading: false,
    error: null,
  });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState({ key, data: null, loading: true, error: null });
    void (async () => {
      const response = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          response.status === 401 || response.status === 403
            ? "当前登录状态无法读取统计，请重新登录后台。"
            : "暂时无法读取，请稍后重试。",
        );
      }
      const result = adminAnalyticsReportSchema.parse(await response.json());
      if (result.resource !== resource)
        throw new Error("暂时无法读取，请稍后重试。");
      if (!controller.signal.aborted)
        setState({
          key,
          data: result as Report<R>,
          loading: false,
          error: null,
        });
    })().catch((failure: unknown) => {
      if (!controller.signal.aborted)
        setState({
          key,
          data: null,
          loading: false,
          error:
            failure instanceof Error && failure.message.startsWith("当前登录")
              ? failure.message
              : "暂时无法读取，请稍后重试。",
        });
    });
    return () => controller.abort();
  }, [enabled, key, resource, url]);
  const current =
    state.key === key ? state : { data: null, loading: enabled, error: null };
  return { data: current.data, loading: current.loading, error: current.error };
}

function ReadNotice({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: string | null;
  retry: () => void;
}) {
  if (error)
    return (
      <div className={styles.notice} role="alert">
        <UiIcon name="error" size="sm" /> <span>{error}</span>
        <button type="button" onClick={retry}>
          重试
        </button>
      </div>
    );
  return loading ? (
    <p className={styles.note} role="status">
      正在读取…
    </p>
  ) : null;
}

function Trend({
  data,
  from,
  to,
}: {
  data: Report<"trend">["data"];
  from: string;
  to: string;
}) {
  if (!data.pageviews.length && !data.sessions.length)
    return (
      <p className={styles.note} role="status">
        当前日期范围没有访问记录。
      </p>
    );
  // The successful daily aggregate omits empty days; keep the selected date axis.
  const rows: string[] = [];
  const cursor = new Date(from + "T00:00:00");
  while (dateString(cursor) <= to && rows.length < 367) {
    rows.push(dateString(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  const visits = new Map(
    data.sessions.map((row) => [row.x.slice(0, 10), row.y]),
  );
  const views = new Map(
    data.pageviews.map((row) => [row.x.slice(0, 10), row.y]),
  );
  const maximum = Math.max(
    1,
    ...data.pageviews.map((row) => row.y),
    ...data.sessions.map((row) => row.y),
  );
  const points = (values: Map<string, number>) =>
    rows
      .map(
        (key, index) =>
          `${rows.length === 1 ? 400 : 16 + (index / (rows.length - 1)) * 768},${168 - ((values.get(key) || 0) / maximum) * 148}`,
      )
      .join(" ");
  return (
    <>
      <div className={styles.chartLegend}>
        <span data-series="visitors">实线 · 每日访客</span>
        <span>虚线 · 浏览量</span>
      </div>
      <div className={styles.chart}>
        <span className={styles.chartMaximum}>{count(maximum)}</span>
        <svg
          viewBox="0 0 800 180"
          preserveAspectRatio="none"
          role="img"
          aria-label="所选日期内的访客与浏览量趋势"
        >
          {[20, 94, 168].map((y) => (
            <line
              key={y}
              x1="16"
              x2="784"
              y1={y}
              y2={y}
              className={styles.gridLine}
            />
          ))}
          <polyline points={points(views)} className={styles.viewsLine} />
          <polyline points={points(visits)} className={styles.visitorsLine} />
          {rows.length === 1 && (
            <circle
              cx="400"
              cy={168 - ((visits.get(rows[0]!) || 0) / maximum) * 148}
              r="4"
              className={styles.trendPoint}
            />
          )}
        </svg>
      </div>
      <div className={styles.chartDates}>
        <span>{rows[0]?.slice(0, 10)}</span>
        <span>
          {rows.length > 1 ? rows.at(-1)?.slice(0, 10) : "仅此日有记录"}
        </span>
      </div>
      <details className={styles.details}>
        <summary>查看趋势数据</summary>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>日期</th>
              <th>访客</th>
              <th>浏览量</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((key) => (
              <tr key={key}>
                <td>{key.slice(0, 16)}</td>
                <td>{count(visits.get(key) || 0)}</td>
                <td>{count(views.get(key) || 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}

export function NativeAnalytics() {
  const [dates, setDates] = useState({ from: "", to: "" });
  const [draftDates, setDraftDates] = useState({ from: "", to: "" });
  const [preset, setPreset] = useState<number | null>(7);
  const [dateError, setDateError] = useState<string | null>(null);
  const [country, setCountry] = useState<string | undefined>();
  const [province, setProvince] = useState<string | undefined>();
  const [citySearch, setCitySearch] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [offset, setOffset] = useState(0);
  const [allProvinces, setAllProvinces] = useState(false);
  const [allCountries, setAllCountries] = useState(false);
  const [revision, setRevision] = useState(0);
  const [focusedProvince, setFocusedProvince] = useState("CN-BJ");
  const mapRef = useRef<SVGSVGElement>(null);
  const cityHeading = useRef<HTMLHeadingElement>(null);
  const navigationQuery = useSearchParams()?.toString() || "";
  const writtenQuery = useRef<string | null>(null);
  useEffect(() => {
    if (navigationQuery === writtenQuery.current) return;
    const restore = () => {
      const query = new URLSearchParams(navigationQuery);
      const from = query.get("from") || "";
      const to = query.get("to") || "";
      const fromTime = new Date(from + "T00:00:00").getTime();
      const toTime = new Date(to + "T00:00:00").getTime();
      const valid =
        /^\d{4}-\d{2}-\d{2}$/u.test(from) &&
        /^\d{4}-\d{2}-\d{2}$/u.test(to) &&
        Number.isFinite(fromTime) &&
        Number.isFinite(toTime) &&
        toTime >= fromTime &&
        toTime - fromTime <= 365 * 86400000 &&
        dateString(new Date(fromTime)) === from &&
        dateString(new Date(toTime)) === to;
      const next = valid ? { from, to } : recentDates(7);
      setDates(next);
      setDraftDates(next);
      setPreset(valid ? null : 7);
      setDateError(null);
      const initialCountry = query.get("country") || "";
      const initialProvince = query.get("province");
      const knownProvince = ADMIN_ANALYTICS_PROVINCE_CODES.some(
        (code) => code === initialProvince,
      );
      setCountry(
        knownProvince
          ? "CN"
          : /^[A-Z]{2}$/u.test(initialCountry)
            ? initialCountry
            : undefined,
      );
      setProvince(knownProvince ? initialProvince! : undefined);
      const q = query.get("q") || "";
      const search = q.length <= 100 && !/\p{Cc}/u.test(q) ? q : "";
      setCitySearch(search);
      setSearchDraft(search);
      const all = Boolean(search || query.get("cities") === "all");
      setExpanded(all);
      const pageOffset = query.get("offset") || "0";
      setOffset(
        all && /^\d+$/u.test(pageOffset) && Number(pageOffset) <= 100000
          ? Number(pageOffset)
          : 0,
      );
    };
    restore();
  }, [navigationQuery]);
  const ready = Boolean(dates.from && dates.to);
  useEffect(() => {
    if (!ready) return;
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries({
      from: dates.from,
      to: dates.to,
      country,
      province,
      q: citySearch || undefined,
      cities: expanded ? "all" : undefined,
      offset: expanded && offset > 0 ? String(offset) : undefined,
    })) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    writtenQuery.current = url.searchParams.toString();
    // Next copies its own history metadata and updates useSearchParams.
    window.history.replaceState(null, "", url);
  }, [
    ready,
    dates.from,
    dates.to,
    country,
    province,
    citySearch,
    expanded,
    offset,
  ]);
  const startAt = new Date(`${dates.from}T00:00:00`).getTime();
  const lastDay = new Date(`${dates.to}T00:00:00`);
  lastDay.setDate(lastDay.getDate() + 1);
  const endAt = lastDay.getTime() - 1;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const period = { startAt, endAt, unit: "day", timezone };
  const summary = useReport("summary", period, revision, ready);
  const trend = useReport("trend", period, revision, ready);
  const regions = useReport(
    "metrics",
    { ...period, type: "region", country: "CN", limit: 34 },
    revision,
    ready,
  );
  const countries = useReport(
    "metrics",
    { ...period, type: "country", limit: 500 },
    revision,
    ready,
  );
  const limit = expanded ? 20 : 10;
  const cities = useReport(
    "expanded",
    {
      ...period,
      type: "city",
      country,
      region: province,
      q: citySearch || undefined,
      limit,
      offset,
    },
    revision,
    ready,
  );
  const pages = useReport(
    "metrics",
    { ...period, type: "title", limit: 10 },
    revision,
    ready,
  );
  const events = useReport(
    "metrics",
    { ...period, type: "event", limit: 10 },
    revision,
    ready,
  );
  const map = useReport("map", {}, revision, ready);
  const retry = () => setRevision((value) => value + 1);
  const provinceCounts = useMemo(
    () =>
      new Map(
        (regions.data?.data || [])
          .filter((row) => row.x !== null)
          .map((row) => [row.x!, row.y]),
      ),
    [regions.data],
  );
  const maximum = Math.max(1, ...provinceCounts.values());
  const provinceShapes =
    map.data?.data.shapes.filter((shape) => !shape.decorative) || [];
  const selectedName = provinceShapes.find(
    (shape) => shape.code === province,
  )?.name;
  const cityScope =
    selectedName || (country ? countryName(country) : "全部地区");
  const chooseGeography = (nextCountry?: string, nextProvince?: string) => {
    setCountry(nextCountry);
    setProvince(nextProvince);
    setOffset(0);
    setCitySearch("");
    setSearchDraft("");
  };
  const mapKey = (event: KeyboardEvent<SVGPathElement>, code: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseGeography("CN", code);
      return;
    }
    const step = ["ArrowRight", "ArrowDown"].includes(event.key)
      ? 1
      : ["ArrowLeft", "ArrowUp"].includes(event.key)
        ? -1
        : 0;
    if (!step) return;
    event.preventDefault();
    const index = provinceShapes.findIndex((shape) => shape.code === code);
    const next =
      provinceShapes[
        (index + step + provinceShapes.length) % provinceShapes.length
      ]?.code;
    if (next) {
      setFocusedProvince(next);
      mapRef.current
        ?.querySelector<SVGPathElement>(`[data-province="${next}"]`)
        ?.focus();
    }
  };
  const applyDates = (event: FormEvent) => {
    event.preventDefault();
    const from = new Date(`${draftDates.from}T00:00:00`).getTime();
    const to = new Date(`${draftDates.to}T00:00:00`).getTime();
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      to < from ||
      to - from > 365 * 86400000
    ) {
      setDateError("请选择起止顺序正确、最长一年的日期范围。");
      return;
    }
    setDateError(null);
    setDates(draftDates);
    setPreset(null);
    setOffset(0);
  };
  const renderRanking = (
    rows: AdminAnalyticsMetricRow[],
    kind: "provinces" | "countries",
  ) =>
    rows.map((row, index) => {
      const code = row.x;
      const label =
        row.displayName ||
        (kind === "countries"
          ? countryName(code)
          : provinceShapes.find((shape) => shape.code === code)?.name ||
            code ||
            "位置未提供");
      return (
        <li key={code || "unassigned"}>
          <button
            type="button"
            disabled={!code}
            aria-pressed={
              kind === "provinces"
                ? province === code
                : country === code && !province
            }
            onClick={() =>
              kind === "provinces"
                ? chooseGeography("CN", code || undefined)
                : chooseGeography(code || undefined)
            }
          >
            <span className={styles.rank}>{index + 1}</span>
            <span className={styles.rankLabel}>{label}</span>
            <strong>{count(row.y)}</strong>
          </button>
        </li>
      );
    });
  return (
    <div className={styles.native} data-native-analytics>
      <div className={styles.dateToolbar}>
        <div className={styles.presets} role="group" aria-label="统计日期">
          {[7, 30, 90].map((days) => (
            <button
              key={days}
              type="button"
              aria-pressed={preset === days}
              onClick={() => {
                const next = recentDates(days);
                setDates(next);
                setDraftDates(next);
                setPreset(days);
                setDateError(null);
                setOffset(0);
              }}
            >
              最近 {days} 天
            </button>
          ))}
        </div>
        <form onSubmit={applyDates} className={styles.dateForm}>
          <label>
            <span className={styles.srOnly}>开始日期</span>
            <input
              type="date"
              aria-label="开始日期"
              required
              value={draftDates.from}
              onChange={(event) =>
                setDraftDates({ ...draftDates, from: event.target.value })
              }
            />
          </label>
          <span aria-hidden="true">—</span>
          <label>
            <span className={styles.srOnly}>结束日期</span>
            <input
              type="date"
              aria-label="结束日期"
              required
              value={draftDates.to}
              onChange={(event) =>
                setDraftDates({ ...draftDates, to: event.target.value })
              }
            />
          </label>
          <button type="submit">查看</button>
          <button
            type="button"
            onClick={retry}
            aria-label="刷新分析数据"
            title="刷新分析数据"
          >
            <UiIcon name="loading" size="sm" />
          </button>
        </form>
        {dateError && (
          <p className={styles.notice} role="alert">
            {dateError}
          </p>
        )}
      </div>
      <section aria-label="访问概览">
        <ReadNotice {...summary} retry={retry} />
        {summary.data && (
          <dl className={styles.overview}>
            {(
              [
                ["访客", count(summary.data.data.visitors)],
                ["访问次数", count(summary.data.data.visits)],
                ["浏览量", count(summary.data.data.pageviews)],
                [
                  "平均停留",
                  summary.data.data.visits
                    ? `${Math.round(summary.data.data.totaltime / summary.data.data.visits)} 秒`
                    : "—",
                ],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
      <section className={styles.card} aria-labelledby="analytics-trend-title">
        <h2 id="analytics-trend-title">访问趋势</h2>
        <ReadNotice {...trend} retry={retry} />
        {trend.data && (
          <Trend data={trend.data.data} from={dates.from} to={dates.to} />
        )}
      </section>
      <section
        className={styles.geography}
        aria-labelledby="analytics-geography-title"
      >
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="analytics-geography-title">地域分布</h2>
            <p className={styles.note}>
              选择省份或境外地区，查看对应城市。摘要和趋势仍为所选日期的全部访问。
            </p>
          </div>
        </div>
        <div className={styles.geoGrid}>
          <section className={styles.card} aria-label="中国省级访问分布">
            <div className={styles.sectionHeading}>
              <h3>中国省级访问分布</h3>
              <span className={styles.note}>仅对已解析省份着色</span>
            </div>
            <ReadNotice
              loading={map.loading || regions.loading}
              error={map.error || regions.error}
              retry={retry}
            />
            {map.data && (
              <>
                <svg
                  ref={mapRef}
                  viewBox={map.data.data.viewBox}
                  className={styles.chinaMap}
                  role="group"
                  aria-label="中国省级访问地图，使用方向键选择省份，回车查看城市"
                >
                  {map.data.data.shapes.map((shape) => {
                    if (shape.decorative)
                      return (
                        <path
                          key={shape.id}
                          d={shape.path}
                          className={styles.mapDecoration}
                          fill="none"
                          aria-hidden="true"
                        />
                      );
                    const value = shape.code
                      ? provinceCounts.get(shape.code)
                      : undefined;
                    const level =
                      value === undefined
                        ? 0
                        : value === 0
                          ? 0
                          : Math.max(1, Math.ceil((value / maximum) * 5));
                    return (
                      <path
                        key={shape.id}
                        d={shape.path}
                        fillRule="evenodd"
                        className={styles.province}
                        data-level={
                          regions.error || regions.loading ? 0 : level
                        }
                        data-province={shape.code}
                        role="button"
                        aria-pressed={province === shape.code}
                        aria-label={`${shape.name}：${regions.error ? "暂不可用" : regions.loading ? "正在读取" : value === undefined ? "暂无省级定位记录" : `${count(value)} 位访客`}`}
                        tabIndex={focusedProvince === shape.code ? 0 : -1}
                        onFocus={() =>
                          shape.code && setFocusedProvince(shape.code)
                        }
                        onClick={() =>
                          shape.code && chooseGeography("CN", shape.code)
                        }
                        onKeyDown={(event) =>
                          shape.code && mapKey(event, shape.code)
                        }
                      >
                        <title>
                          {shape.name} ·{" "}
                          {regions.error
                            ? "暂不可用"
                            : regions.loading
                              ? "正在读取"
                              : value === undefined
                                ? "暂无省级定位记录"
                                : `${count(value)} 位访客`}
                        </title>
                      </path>
                    );
                  })}
                </svg>
                <div className={styles.mapFooter}>
                  <label>
                    选择省份{" "}
                    <select
                      value={province || ""}
                      onChange={(event) =>
                        chooseGeography("CN", event.target.value || undefined)
                      }
                    >
                      <option value="">不限定省份</option>
                      {provinceShapes.map((shape) => (
                        <option value={shape.code || ""} key={shape.id}>
                          {shape.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className={styles.mapLegend}>
                    <span>较少</span>
                    {[1, 2, 3, 4, 5].map((level) => (
                      <i key={level} data-level={level} />
                    ))}
                    <span>较多</span>
                  </div>
                </div>
                <p className={styles.attribution}>
                  {map.data.data.attribution}{" "}
                  <a
                    href={map.data.data.referenceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    标准地图参考
                  </a>
                </p>
              </>
            )}
          </section>
          <section
            className={styles.card}
            aria-labelledby="analytics-cities-title"
          >
            <div className={styles.sectionHeading}>
              <h3 id="analytics-cities-title" ref={cityHeading} tabIndex={-1}>
                城市排行{" "}
                <span className={styles.scope} aria-live="polite">
                  {cityScope}
                </span>
              </h3>
              {(country || province) && (
                <button type="button" onClick={() => chooseGeography()}>
                  <UiIcon name="close" size="sm" /> 清除地域筛选
                </button>
              )}
            </div>
            <label className={styles.countryFilter}>
              国家 / 地区
              <select
                value={country || ""}
                onChange={(event) =>
                  chooseGeography(event.target.value || undefined)
                }
              >
                <option value="">全部地区</option>
                <option value="CN">中国</option>
                {(countries.data?.data || [])
                  .filter((row) => row.x && row.x !== "CN")
                  .map((row) => (
                    <option key={row.x!} value={row.x!}>
                      {row.displayName || countryName(row.x)}
                    </option>
                  ))}
              </select>
            </label>
            <form
              className={styles.searchForm}
              onSubmit={(event) => {
                event.preventDefault();
                setCitySearch(searchDraft.trim());
                setExpanded(true);
                setOffset(0);
              }}
            >
              <label className={styles.srOnly} htmlFor="analytics-city-search">
                搜索城市
              </label>
              <input
                id="analytics-city-search"
                type="search"
                maxLength={100}
                value={searchDraft}
                placeholder="搜索城市"
                onChange={(event) => setSearchDraft(event.target.value)}
              />
              <button type="submit" aria-label="搜索城市" title="搜索城市">
                <UiIcon name="search" size="sm" />
              </button>
              {citySearch && (
                <button
                  type="button"
                  onClick={() => {
                    setCitySearch("");
                    setSearchDraft("");
                    setOffset(0);
                  }}
                >
                  清除搜索
                </button>
              )}
              {!expanded && (
                <button
                  type="button"
                  className={styles.moreButton}
                  onClick={() => {
                    setExpanded(true);
                    setOffset(0);
                  }}
                >
                  查看全部城市
                </button>
              )}
              {expanded && (
                <button
                  type="button"
                  onClick={() => {
                    setExpanded(false);
                    setOffset(0);
                    setCitySearch("");
                    setSearchDraft("");
                  }}
                >
                  收起列表
                </button>
              )}
            </form>
            <ReadNotice {...cities} retry={retry} />
            {cities.data &&
              (cities.data.data.length ? (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>城市</th>
                      <th>国家 / 地区</th>
                      <th className={styles.number}>访客</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cities.data.data.map((row) => (
                      <tr key={`${row.country || ""}|${row.name}`}>
                        <td>{row.displayName || row.name}</td>
                        <td>{countryName(row.country)}</td>
                        <td className={styles.number}>{count(row.visitors)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className={styles.note} role="status">
                  当前范围没有符合条件的城市。可清除筛选或更换日期。
                </p>
              ))}
            {expanded && (
              <div className={styles.pagination}>
                <button
                  type="button"
                  disabled={cities.loading || offset === 0}
                  aria-label="上一页城市"
                  title="上一页城市"
                  onClick={() => {
                    setOffset(Math.max(0, offset - limit));
                    cityHeading.current?.focus();
                  }}
                >
                  <UiIcon name="previous" size="sm" />
                </button>
                <span>
                  第 {Math.floor(offset / limit) + 1} 页 · 每页最多 {limit} 项
                </span>
                <button
                  type="button"
                  disabled={
                    cities.loading ||
                    !cities.data ||
                    cities.data.data.length < limit
                  }
                  aria-label="下一页城市"
                  title="下一页城市"
                  onClick={() => {
                    setOffset(offset + limit);
                    cityHeading.current?.focus();
                  }}
                >
                  <UiIcon name="next" size="sm" />
                </button>
              </div>
            )}
          </section>
        </div>
        <div className={styles.rankColumn}>
          <section
            className={styles.card}
            aria-labelledby="analytics-provinces-title"
          >
            <h3 id="analytics-provinces-title">省份排行</h3>
            <ReadNotice {...regions} retry={retry} />
            {regions.data &&
              (regions.data.data.length ? (
                <>
                  <ol className={styles.ranking}>
                    {renderRanking(
                      allProvinces
                        ? regions.data.data
                        : regions.data.data.slice(0, 8),
                      "provinces",
                    )}
                  </ol>
                  {regions.data.data.length > 8 && (
                    <button
                      type="button"
                      className={styles.textButton}
                      aria-expanded={allProvinces}
                      onClick={() => setAllProvinces((value) => !value)}
                    >
                      {allProvinces ? "收起" : "查看全部省份"}
                    </button>
                  )}
                </>
              ) : (
                <p className={styles.note}>当前日期没有已解析的省份记录。</p>
              ))}
          </section>
          <section
            className={styles.card}
            aria-labelledby="analytics-countries-title"
          >
            <h3 id="analytics-countries-title">境外国家与地区</h3>
            <ReadNotice {...countries} retry={retry} />
            {countries.data &&
              (() => {
                const foreign = countries.data.data.filter(
                  (row) => row.x !== "CN",
                );
                return foreign.length ? (
                  <>
                    <ol className={styles.ranking}>
                      {renderRanking(
                        allCountries ? foreign : foreign.slice(0, 8),
                        "countries",
                      )}
                    </ol>
                    {foreign.length > 8 && (
                      <button
                        type="button"
                        className={styles.textButton}
                        onClick={() => setAllCountries((value) => !value)}
                      >
                        {allCountries ? "收起" : "查看全部地区"}
                      </button>
                    )}
                  </>
                ) : (
                  <p className={styles.note}>当前日期没有境外记录。</p>
                );
              })()}
          </section>
        </div>
      </section>
      <section className={styles.contentGrid} aria-label="内容访问">
        {(
          [
            ["热门页面", pages],
            ["内容互动", events],
          ] as const
        ).map(([label, state]) => (
          <section className={styles.card} key={label}>
            <h2>{label}</h2>
            <ReadNotice {...state} retry={retry} />
            {state.data &&
              (state.data.data.length ? (
                <ol className={styles.ranking}>
                  {state.data.data.map((row, index) => (
                    <li key={row.x || "empty"}>
                      <div>
                        <span className={styles.rank}>{index + 1}</span>
                        <span
                          className={styles.rankLabel}
                          title={row.displayName || row.x || "未提供名称"}
                        >
                          {row.displayName || row.x || "未提供名称"}
                        </span>
                        <strong>{count(row.y)}</strong>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className={styles.note}>当前日期没有记录。</p>
              ))}
          </section>
        ))}
      </section>
      <p className={styles.note}>
        IP
        位置是网络出口的大致位置。省市排行只包含已解析的位置；各排行独立去重，不能相加作为总访客数。
      </p>
    </div>
  );
}
