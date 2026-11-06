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

/**
 * The work that goes through the companion, so a client with no local process cannot
 * do it (the record's section 20): bytes and a password never travel in a tool result.
 * Each is a Behavior Matrix row, and `download` is any other file to disk. Image views
 * and every other HTTP tool stay.
 */
export const ADMIN_MCP_BYTE_WORK = [
  "upload",
  "download",
  "canonical_export",
  "report_csv",
  "rendered_preview",
  "deep_zoom_master",
  "local_import",
  "legacy_plan",
  "account_provision",
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
  /**
   * On the native path: the contract served, a hash of the op catalog (names, tools,
   * classes, inputs) and one of this credential's tools/list. A changed catalog means
   * admin_actions is worth reading again; a changed tools hash, tools/list.
   */
  contract: z
    .strictObject({
      version: z.string().min(1),
      catalog: z.string().regex(/^[0-9a-f]{16}$/u),
      tools: z.string().regex(/^[0-9a-f]{16}$/u),
    })
    .optional(),
});

export type AdminMcpDoorRefusal = (typeof ADMIN_MCP_DOOR_REFUSALS)[number];
export type AdminWhoamiData = z.infer<typeof adminWhoamiDataSchema>;
