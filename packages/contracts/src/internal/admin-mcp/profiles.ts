import { z } from "zod";

/** Chosen by the Owner when issuing an `ai_operator` key. */
export const ADMIN_MCP_TOOL_PROFILES = ["read", "operate", "full"] as const;

export const adminMcpToolProfileSchema = z.enum(ADMIN_MCP_TOOL_PROFILES);

export type AdminMcpToolProfile = z.infer<typeof adminMcpToolProfileSchema>;

/** The values of the Admin's `users.role`. */
export const ADMIN_USER_ROLES = ["owner", "automation", "ai_operator"] as const;

export type AdminUserRole = (typeof ADMIN_USER_ROLES)[number];

/**
 * The widest profile a person in this role may hand a tool by signing in, `null`
 * for no authorizing at all. A new role needs an entry, so nobody adds one without
 * deciding this. Profiles only filter the tool list, so a role that may moderate
 * but not publish would need more than this.
 */
export const ADMIN_MCP_AUTHORIZE_CEILING: Readonly<
  Record<AdminUserRole, AdminMcpToolProfile | null>
> = { owner: "full", automation: null, ai_operator: null };

/** The one `users` row every operator connection acts as, seeded with no password. */
export const ADMIN_MCP_OPERATOR_ROW_EMAIL = "ai-connection@operator.invalid";

/** A connection's hard limit from consent, whatever its tokens say: the issuer's Grant. */
export const ADMIN_MCP_CONNECTION_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;
