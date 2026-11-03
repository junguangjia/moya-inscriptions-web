import { ADMIN_MCP_KEY_LIFETIME_MS } from "@moya/contracts/internal/admin-mcp";
import type { Endpoint } from "payload";

import { isHumanOwner } from "../../editorial/access";

const privateHeaders = { "cache-control": "private, no-store" };

const refuse = (error: string, status: number) =>
  Response.json({ error }, { status, headers: privateHeaders });

/**
 * One-click renewal from the control page. The server sets the date, so a browser
 * clock running ahead cannot trip the 30-day cap. The session cookie is
 * SameSite=Strict; the Origin check is the same second net as analytics/endpoints.ts.
 */
export const mcpControlEndpoints: Endpoint[] = [
  {
    path: "/mcp-control/keys/:id/renew",
    method: "post",
    handler: async (req) => {
      if (!isHumanOwner(req)) return refuse("OWNER_ONLY", 403);
      // Next may normalize req.url to its internal HTTP origin behind Nginx.
      const publicUrl = process.env.CMS_PUBLIC_URL ?? req.url;
      if (!publicUrl || req.headers.get("origin") !== new URL(publicUrl).origin)
        return refuse("ORIGIN_REQUIRED", 403);
      const id = Number(req.routeParams?.id);
      if (!Number.isSafeInteger(id) || id < 1) return refuse("NOT_FOUND", 404);
      try {
        const { expiresAt } = await req.payload.update({
          collection: "payload-mcp-api-keys",
          id,
          req,
          overrideAccess: false,
          depth: 0,
          select: { expiresAt: true },
          data: {
            expiresAt: new Date(
              Date.now() + ADMIN_MCP_KEY_LIFETIME_MS,
            ).toISOString(),
          },
        });
        return Response.json({ expiresAt }, { headers: privateHeaders });
      } catch {
        return refuse("RENEW_FAILED", 409);
      }
    },
  },
];
