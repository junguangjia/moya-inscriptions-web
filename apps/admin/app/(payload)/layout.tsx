import config from "@payload-config";
import { RootLayout, handleServerFunctions } from "@payloadcms/next/layouts";
import type { ServerFunctionClient } from "payload";
import type { ReactNode } from "react";
import { importMap } from "./admin/importMap";
import "@payloadcms/next/css";
import "@moya/ui/styles.css";
import "../../src/workspace/theme.css";
import "../../src/branding/login.css";
const serverFunction: ServerFunctionClient = async function (args) {
  "use server";
  return handleServerFunctions({ ...args, config, importMap });
};
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootLayout
      config={config}
      importMap={importMap}
      serverFunction={serverFunction}
      htmlProps={{ lang: "zh-CN" }}
    >
      {children}
    </RootLayout>
  );
}
