import { z } from "zod";

import { adminMcpToolProfileSchema } from "./profiles.js";

/**
 * What the door names in a 401 beside the generic refusal. Only a holder of the
 * correct secret gets that far, so naming them is no oracle.
 */
export const ADMIN_MCP_DOOR_REFUSALS = [
  "KEY_EXPIRED",
  "KEY_OWNER_BOUND",
] as const;

/** `admin_whoami` data. No email: AI gets account ids. The key secret never appears. */
export const adminWhoamiDataSchema = z.strictObject({
  path: z.enum(["native", "plugin"]),
  user: z.strictObject({
    id: z.union([z.string().min(1), z.number().int().positive()]),
    role: z.enum(["ai_operator", "automation"]),
  }),
  key: z.strictObject({
    id: z.number().int().positive(),
    label: z.string().optional(),
    expiresAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().optional(),
    /** Present on ai_operator keys; automation keys keep their stored ticks. */
    toolProfile: adminMcpToolProfileSchema.optional(),
  }),
  /** While the Owner has paused MCP, only admin_whoami stays in `tools`. */
  paused: z.boolean(),
  /** Tools this key can call on this request, in listing order. */
  tools: z.array(z.string().min(1)),
  playbook: z.array(z.string().min(1)),
});

export type AdminMcpDoorRefusal = (typeof ADMIN_MCP_DOOR_REFUSALS)[number];
export type AdminWhoamiData = z.infer<typeof adminWhoamiDataSchema>;
