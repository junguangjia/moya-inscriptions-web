import { z } from "zod";

/** Chosen by the Owner when issuing an `ai_operator` key. */
export const ADMIN_MCP_TOOL_PROFILES = ["read", "operate", "full"] as const;

export const adminMcpToolProfileSchema = z.enum(ADMIN_MCP_TOOL_PROFILES);

export type AdminMcpToolProfile = z.infer<typeof adminMcpToolProfileSchema>;
