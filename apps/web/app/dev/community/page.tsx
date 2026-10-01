import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { communitySessionCookieName } from "../../../lib/public-api/community-session-cookie";
import { fetchServerCurrentUser } from "../../../lib/public-api/server";
import styles from "./page.module.css";
import { CommunitySessionNotification } from "../../../features/authors/session-notification";

import type { CurrentUserTransportResult } from "../../../lib/public-api/community-session";

/**
 * Handles seeded by infra/development/community-development-accounts.sql. The
 * seed file is the source of truth; this list only pre-fills the form.
 */
const developmentAccountHandles = [
  "dev-user-01",
  "dev-user-02",
  "dev-user-03",
] as const;

const notices: Readonly<Record<string, string>> = {
  "signed-in": "登录成功，Backend 已签发会话。",
  "signed-out": "已登出，Backend 已撤销会话。",
  "invalid-request": "账号格式无效。",
  "unknown-account": "不存在这个 Development 测试账号。",
  unavailable: "Backend 暂时不可用，未改变登录状态。",
  error: "请求失败，未改变登录状态。",
};

const describeState = (result: CurrentUserTransportResult): string => {
  switch (result.state) {
    case "success":
      return "已登录";
    case "unauthenticated":
      return "未登录";
    case "unavailable":
      return "Backend 暂时不可用";
    case "unexpected-error":
      return "无法确认登录状态";
  }
};

export default async function CommunityDevelopmentPage({
  searchParams,
}: {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}) {
  if (process.env.NODE_ENV !== "development") {
    notFound();
  }

  const token = (await cookies()).get(communitySessionCookieName)?.value;
  const result: CurrentUserTransportResult =
    token === undefined
      ? { state: "unauthenticated" }
      : await fetchServerCurrentUser(token);
  const query = (await searchParams) ?? {};
  const suggestedHandle =
    typeof query.handle === "string" &&
    /^[a-z][a-z0-9-]{2,31}$/.test(query.handle)
      ? query.handle
      : developmentAccountHandles[0];
  // Own-property lookup only: a crafted notice must never reach the prototype.
  const notice =
    typeof query.notice === "string" && Object.hasOwn(notices, query.notice)
      ? notices[query.notice]
      : undefined;

  return (
    <main className={styles.page} data-community-development-entry="">
      {query.notice === "signed-in" || query.notice === "signed-out" ? (
        <CommunitySessionNotification change={query.notice} />
      ) : null}
      <h1 className={styles.title}>Community 开发登录</h1>
      <p className={styles.lede}>
        仅 Development 环境可用的测试账号入口：Backend
        真实签发、校验、过期与撤销会话； Production
        不存在此入口，也没有任何登录方式。
      </p>
      {notice === undefined ? null : (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      <section className={styles.panel} aria-labelledby="community-state">
        <h2 id="community-state" className={styles.panelTitle}>
          当前状态：{describeState(result)}
        </h2>
        {result.state === "success" ? (
          <>
            <dl className={styles.profile} data-community-profile="">
              <dt>显示名</dt>
              <dd data-community-display-name="">
                {result.profile.displayName}
              </dd>
              <dt>Handle</dt>
              <dd data-community-handle="">@{result.profile.handle}</dd>
              <dt>用户 ID</dt>
              <dd data-community-user-id="">{result.profile.id}</dd>
            </dl>
            <form method="post" action="/api/community/development/sign-out">
              <button type="submit" className={styles.button}>
                登出
              </button>
            </form>
          </>
        ) : (
          <form
            method="post"
            action="/api/community/development/sign-in"
            className={styles.form}
          >
            <label htmlFor="community-handle">测试账号 handle</label>
            <input
              id="community-handle"
              name="handle"
              list="community-handles"
              required
              autoComplete="off"
              pattern="[a-z][a-z0-9\-]{2,31}"
              defaultValue={suggestedHandle}
              className={styles.input}
            />
            <datalist id="community-handles">
              {developmentAccountHandles.map((handle) => (
                <option key={handle} value={handle} />
              ))}
            </datalist>
            <button type="submit" className={styles.button}>
              登录
            </button>
          </form>
        )}
      </section>
      <p>
        <a href="/?notifications=comments">打开评论与提到我测试</a>
      </p>
      <p>
        <a href="/?notifications=likes">打开赞通知测试</a>
      </p>
      <p className={styles.footnote}>
        同源接口：<code>GET /api/community/me</code>{" "}
        返回当前身份；本页的表单调用
        <code>/api/community/development/sign-in</code> 与
        <code>/api/community/development/sign-out</code>。会话凭证只存在于
        HttpOnly cookie，浏览器脚本不可读。
      </p>
    </main>
  );
}
