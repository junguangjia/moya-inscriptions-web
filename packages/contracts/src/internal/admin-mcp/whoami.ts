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

/** What a client with no local process cannot do. Everything else is an HTTP tool. */
export const ADMIN_MCP_BYTE_WORK = [
  "upload",
  "original_download",
  "rendered_preview",
] as const;

/** `admin_whoami` data. No email: AI gets account ids. The key secret never appears. */
export const adminWhoamiDataSchema = z.strictObject({
  path: z.enum(["native", "plugin"]),
  user: z.strictObject({
    id: z.union([z.string().min(1), z.number().int().positive()]),
    role: z.enum(["ai_operator", "automation"]),
  }),
  key: z.strictObject({
    /** A key's row id, or `conn-<hex>` for a connection someone signed in to make. */
    id: z.union([
      z.number().int().positive(),
      z.string().regex(/^conn-[0-9a-f]{32}$/u),
    ]),
    label: z.string().optional(),
    expiresAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().optional(),
    /** Present on ai_operator keys; automation keys keep their stored ticks. */
    toolProfile: adminMcpToolProfileSchema.optional(),
    /** On a connection, the account that authorized it. An id, so never an email. */
    authorizedBy: z.number().int().positive().optional(),
  }),
  /** While the Owner has paused MCP, only admin_whoami stays in `tools`. */
  paused: z.boolean(),
  /** Tools this key can call on this request, in listing order. */
  tools: z.array(z.string().min(1)),
  playbook: z.array(z.string().min(1)),
  /** On a connection, which has no local process, so it never fails silently. */
  byteChannel: z
    .strictObject({
      available: z.literal(false),
      unavailable: z.array(z.enum(ADMIN_MCP_BYTE_WORK)),
    })
    .optional(),
});

export type AdminMcpDoorRefusal = (typeof ADMIN_MCP_DOOR_REFUSALS)[number];
export type AdminWhoamiData = z.infer<typeof adminWhoamiDataSchema>;
