"use client";

import { YoyiLogo } from "@moya/ui";

import {
  ProductAccessRetry,
  ProductAccessSignIn,
  ProductAccessSignOut,
  ProductAccessWatcher,
} from "./product-access-actions";
import styles from "./product-access-notice.module.css";

export type ProductAccessNoticeState =
  | { readonly state: "sign_in_required" }
  | {
      readonly state: "restricted";
      readonly account: {
        readonly displayName: string;
        readonly handle: string;
      } | null;
    }
  | { readonly state: "unavailable" };

const copy = {
  sign_in_required: {
    title: "内测进行中",
    description:
      "由于艺目前仅向已获邀请的内测用户开放。如果你已获得内测资格，请登录后继续。",
  },
  restricted: {
    title: "暂未获得内测资格",
    description:
      "由于艺目前仅向已获邀请的内测用户开放，当前账号尚未获得内测资格。",
  },
  unavailable: {
    title: "暂时无法访问",
    description: "服务暂时不可用，请稍后再试。",
  },
} as const;

/**
 * Everything a visitor without product access receives: the brand, one short
 * explanation and the way forward. The page renders it instead of the product
 * and passes it only the access state, so no product data is loaded for it or
 * sent with it.
 */
export const ProductAccessNotice = ({
  access,
}: {
  readonly access: ProductAccessNoticeState;
}) => (
  <main className={styles.page} data-product-access={access.state}>
    {/* Supplementary only; access is decided by the server, not by crawlers. */}
    <meta content="noindex" name="robots" />
    <div className={styles.panel}>
      <div className={styles.brand}>
        <YoyiLogo aria-hidden="true" className={styles.logo} />
        <span className={`yoyi-wordmark ${styles.brandName}`}>由于艺</span>
      </div>
      <h1>{copy[access.state].title}</h1>
      <p className={styles.description}>{copy[access.state].description}</p>
      {access.state === "restricted" && access.account !== null && (
        <p className={styles.account}>
          当前账号：<strong>{access.account.displayName}</strong>（@
          {access.account.handle}）
        </p>
      )}
      <div className={styles.actions}>
        {access.state === "sign_in_required" && <ProductAccessSignIn />}
        {access.state === "restricted" && <ProductAccessSignOut />}
        {access.state === "unavailable" && <ProductAccessRetry />}
      </div>
    </div>
    <ProductAccessWatcher expected={access.state} />
  </main>
);
