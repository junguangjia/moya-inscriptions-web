import {
  ADMIN_MCP_TOOL_PROFILES,
  adminMcpEnvelopeSchema,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminMcpEnvelope,
  AdminMcpToolProfile,
  AdminOpClass,
} from "@moya/contracts/internal/admin-mcp";
import { z } from "zod";

import type { AdminMcpKey } from "../door";
import {
  WHOAMI_DESCRIPTION,
  WHOAMI_TOOL_NAME,
  whoamiEnvelope,
  whoamiInputSchema,
} from "./whoami";

/** Codex treats a missing destructiveHint as needing approval: all four, always. */
export interface AdminMcpAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface AdminMcpTool {
  readonly name: string;
  readonly description: string;
  readonly annotations: AdminMcpAnnotations;
  /** A read gets an audit finish row; anything else a start and a finish. */
  readonly klass: AdminOpClass;
  readonly profiles: readonly AdminMcpToolProfile[];
  readonly input: z.ZodObject;
  run(
    input: unknown,
    context: { readonly key: AdminMcpKey; readonly tools: readonly string[] },
  ): Promise<AdminMcpEnvelope>;
}

const READ_ANNOTATIONS: AdminMcpAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Listing order is this order. A slice adds a tool here, never at runtime. */
export const ADMIN_MCP_TOOLS: readonly AdminMcpTool[] = [
  {
    name: WHOAMI_TOOL_NAME,
    description: WHOAMI_DESCRIPTION,
    annotations: READ_ANNOTATIONS,
    klass: "read",
    profiles: ADMIN_MCP_TOOL_PROFILES,
    input: whoamiInputSchema,
    run: async (_input, { key, tools }) => whoamiEnvelope(key, tools),
  },
];

const OUTPUT_SCHEMA = z.toJSONSchema(adminMcpEnvelopeSchema, {
  target: "draft-2020-12",
});

/** Built once per process, so a tools/list costs no schema conversion. */
const LISTED = ADMIN_MCP_TOOLS.map((tool) => ({
  tool,
  listing: {
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.input, {
      target: "draft-2020-12",
      io: "input",
      unrepresentable: "any",
    }),
    outputSchema: OUTPUT_SCHEMA,
    annotations: tool.annotations,
  },
}));

/** While paused only admin_whoami is listed: a tool not listed is not offered. */
export const toolListingFor = (profile: AdminMcpToolProfile, paused: boolean) =>
  LISTED.filter(
    ({ tool }) =>
      tool.profiles.includes(profile) &&
      (!paused || tool.name === WHOAMI_TOOL_NAME),
  ).map(({ listing }) => listing);

/** A tool outside the key's profile does not exist for that key. */
export const toolFor = (
  profile: AdminMcpToolProfile,
  name: string,
): AdminMcpTool | undefined =>
  ADMIN_MCP_TOOLS.find(
    (tool) => tool.name === name && tool.profiles.includes(profile),
  );
