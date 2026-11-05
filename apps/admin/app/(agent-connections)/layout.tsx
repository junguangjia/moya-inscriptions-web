import type { ReactNode } from "react";

import "@moya/design-tokens/theme.css";

import styles from "../../src/agent-connections/connections.module.css";

/**
 * The consent landing lives OUTSIDE the Payload admin shell on purpose.
 *
 * The Owner's Payload session is `SameSite=Strict`, and the provider's
 * cross-site redirect does not carry it (measured, r15). Inside `/admin`,
 * Payload would see an unauthenticated request and bounce the Owner to a login
 * page they do not need — they are already signed in; the browser simply
 * withheld the cookie on that one navigation. So the landing is a plain page
 * that authenticates nobody, decides nothing, and offers one same-origin step.
 *
 * It has its own root layout because `app/(payload)/layout.tsx` is the Payload
 * shell, and a route outside that group needs one of its own.
 */
export default function AgentConnectionsLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className={styles.landingBody}>{children}</body>
    </html>
  );
}
