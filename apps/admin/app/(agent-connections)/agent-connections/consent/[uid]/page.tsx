import { notFound } from "next/navigation";

// Imported from the two modules directly, never from the package barrel: the
// barrel re-exports the endpoints and the control-plane runtime, and pulling
// `payload` and `pg` into a page whose whole job is to be unprivileged would
// make this the most capable page in the flow instead of the least.
import {
  oauthSurfaceEnabled,
  servedPreset,
} from "../../../../../src/agent-connections/composition";
import {
  consentReviewPath,
  interactionUidSchema,
} from "../../../../../src/agent-connections/consent";

import styles from "../../../../../src/agent-connections/connections.module.css";

/** The gate reads this process's settings, so no build may answer for it. */
export const dynamic = "force-dynamic";

/**
 * The consent LANDING. It authorizes nothing.
 *
 * This is the page the provider's redirect arrives at, and it is deliberately
 * the least capable page in the product:
 *
 *   * it authenticates nobody, because on this navigation the browser withheld
 *     the `SameSite=Strict` Owner cookie and no redirect chain changes that;
 *   * it reads no database and reveals nothing about the interaction beyond
 *     the fact that the uid is well formed, so a guessed uid learns nothing;
 *   * its one step is a same-origin navigation the browser DOES send the cookie
 *     on, and the page after it still needs a click and a ticket.
 *
 * Under `operator` that step takes itself, because a person who may know little
 * about computers should not have to click through a page that says nothing. A
 * meta refresh is initiated by this document, and the Strict session came back on
 * it from a cross-site link, a popup and an address bar alike, measured on Chromium
 * and WebKit. The plain link stays for a browser that declines to refresh, and it
 * is an `<a>` so nothing prefetches the page behind it, which arms a ticket. The
 * Development read-only profile keeps the click #141 measured.
 */
export default async function ConsentLandingPage({
  params,
}: {
  readonly params: Promise<{ readonly uid: string }>;
}) {
  if (!oauthSurfaceEnabled()) notFound();
  const { uid } = await params;
  const interaction = interactionUidSchema.safeParse(uid);
  if (!interaction.success) notFound();
  const review = consentReviewPath(interaction.data);

  if (servedPreset() === "operator")
    return (
      <main
        className={styles.landing}
        data-agent-consent-landing={interaction.data}
      >
        <meta content={`0;url=${review}`} httpEquiv="refresh" />
        <h1 className={styles.consentTitle}>正在打开授权页</h1>
        <p className={styles.consentText}>
          这一页不会授权任何事情。下一页会写清楚这个工具能做什么，由你决定是否允许。
        </p>
        <p className={styles.consentText}>
          <a
            className={styles.quietLink}
            data-agent-consent-continue
            href={review}
          >
            如果没有自动打开，请点这里继续
          </a>
        </p>
      </main>
    );

  return (
    <main
      className={styles.landing}
      data-agent-consent-landing={interaction.data}
    >
      <h1 className={styles.consentTitle}>继续授权 AI 连接</h1>
      <p className={styles.consentText}>
        一个应用请求以只读方式访问 ArtVenn。请在管理端确认这次请求的具体内容，
        然后决定是否同意。
      </p>
      <p className={styles.consentText}>
        <strong>这一页不会授权任何事情。</strong>
        点击下面的链接后，管理端会验证你的 Owner 登录状态并显示完整详情。
      </p>
      <p className={styles.consentText}>
        <a
          className={styles.quietLink}
          data-agent-consent-continue
          href={review}
        >
          在管理端继续
        </a>
      </p>
    </main>
  );
}
