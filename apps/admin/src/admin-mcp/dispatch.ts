import { definePlugin } from "payload";
import type { PayloadHandler, TypedUser } from "payload";

import { isConnectionToken } from "../agent-connections/contracts";
import { admitKey, bearerKeyOf, findKey, markRequestStart } from "./door";
import { nativeMcp } from "./native";

/**
 * One URL, two paths. A key bound to ai_operator goes to the native handler;
 * every other credential, refusals included, reaches the plugin handler
 * untouched, with its body unread.
 */
export const adminMcpDispatch =
  (pluginHandler: PayloadHandler): PayloadHandler =>
  async (req) => {
    markRequestStart(req);
    const presented = bearerKeyOf(req);
    if (presented === null || isConnectionToken(presented))
      return pluginHandler(req);
    const key = await findKey(req, presented);
    if (key === null || key.user.role !== "ai_operator")
      return pluginHandler(req);
    const admitted = await admitKey(req, key, "native");
    // As plugin dist/endpoints/mcp.js does before it runs a tool.
    req.payloadAPI = "MCP";
    req.user = key.user as unknown as TypedUser;
    return nativeMcp(req, admitted);
  };

/**
 * Wraps the two `/mcp` endpoints the MCP plugin pushed. Payload sorts plugins by
 * `order`, not by their place in the list, and the MCP plugin declares 10
 * (plugin dist/index.js:11), so this must declare a later one.
 */
export const adminMcpDispatchPlugin = definePlugin({
  slug: "admin-mcp-dispatch",
  order: 11,
  plugin: ({ config }) => ({
    ...config,
    endpoints: (config.endpoints ?? []).map((endpoint) =>
      endpoint.path === "/mcp" &&
      (endpoint.method === "post" || endpoint.method === "get")
        ? { ...endpoint, handler: adminMcpDispatch(endpoint.handler) }
        : endpoint,
    ),
  }),
});
