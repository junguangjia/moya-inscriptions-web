import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@moya/design-tokens/theme.css";
import "@moya/ui/styles.css";

import "./globals.css";

import { AuthReturnProvider } from "../features/auth/auth-return";

import { PRODUCT_BOOT_SCRIPT } from "../features/product-shell/product-boot";
import {
  DEFAULT_THEME_PREFERENCE,
  defaultFeedLayoutFor,
} from "../features/product-shell/preferences";

export const metadata: Metadata = {
  title: "由于艺",
  icons: {
    icon: {
      url: "/packages/ui/src/assets/brand/yoyi-logo.svg",
      type: "image/svg+xml",
    },
  },
  description:
    "来源无关的中国文化艺术 Catalog，当前公开范围为碑刻（inscription）与书帖（calligraphy）。",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html
      suppressHydrationWarning
      lang="zh-CN"
      data-device-class="desktop"
      data-home-layout={defaultFeedLayoutFor("pc")}
      data-orientation="portrait"
      data-platform="pc"
      data-theme={DEFAULT_THEME_PREFERENCE}
      data-theme-preference={DEFAULT_THEME_PREFERENCE}
      data-yoyi-boot="pending"
    >
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: PRODUCT_BOOT_SCRIPT }}
          id="yoyi-product-boot"
        />
      </head>
      <body className="yoyi-paper yoyi-paper--visible">
        <AuthReturnProvider>{children}</AuthReturnProvider>
      </body>
    </html>
  );
}
