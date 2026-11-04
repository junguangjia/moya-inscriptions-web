import {
  ADMIN_MCP_RESULT_SCHEMA,
  ADMIN_MCP_TOOL_PROFILES,
  adminActionsInputSchema,
  adminFindInputSchema,
  adminGetInputSchema,
  adminReadInputSchema,
  adminViewMediaInputSchema,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminMcpEnvelope,
  AdminMcpNext,
  AdminFindInput,
  AdminGetInput,
  AdminMcpToolProfile,
  AdminOpClass,
  AdminViewMediaInput,
} from "@moya/contracts/internal/admin-mcp";
import type { PayloadRequest } from "payload";
import { z } from "zod";

import { controlFor } from "../control/state";
import type { AdminMcpKey } from "../door";
import { findEnvelope } from "../locate";
import {
  ACTIONS_DESCRIPTION,
  ACTIONS_TOOL_NAME,
  actionsContinuation,
  actionsEnvelope,
} from "./actions";
import { FIND_DESCRIPTION, FIND_TOOL_NAME, findContinuation } from "./find";
import {
  GET_DESCRIPTION,
  GET_TOOL_NAME,
  getContinuation,
  getEnvelope,
} from "./get";
import {
  READ_DESCRIPTION,
  READ_TOOL_NAME,
  readContinuation,
  readEnvelope,
  readListedInput,
} from "./read";
import {
  VIEW_MEDIA_DESCRIPTION,
  VIEW_MEDIA_TOOL_NAME,
  viewMediaAnswer,
} from "./view-media";
import type { AdminMcpImageAnswer } from "./view-media";
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
  /** What tools/list shows, when the runtime check is wider so it can answer better. */
  readonly listedInput?: z.ZodObject;
  /** Text plus image: no result schema, and the official client accepts that. */
  readonly imageResult?: true;
  run(
    input: unknown,
    context: {
      readonly key: AdminMcpKey;
      readonly tools: readonly string[];
      readonly req: PayloadRequest;
    },
  ): Promise<AdminMcpEnvelope | AdminMcpImageAnswer>;
  /** How a result cut at the size cap continues, from the records it kept. */
  continuation?(
    input: unknown,
    kept: readonly unknown[],
  ): AdminMcpNext | undefined;
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
  {
    name: FIND_TOOL_NAME,
    description: FIND_DESCRIPTION,
    annotations: READ_ANNOTATIONS,
    klass: "read",
    profiles: ADMIN_MCP_TOOL_PROFILES,
    input: adminFindInputSchema,
    run: async (input, { tools, req }) =>
      findEnvelope(req, input as AdminFindInput, {
        tools,
        switches: await controlFor(req),
      }),
    continuation: findContinuation,
  },
  {
    name: GET_TOOL_NAME,
    description: GET_DESCRIPTION,
    annotations: READ_ANNOTATIONS,
    klass: "read",
    profiles: ADMIN_MCP_TOOL_PROFILES,
    input: adminGetInputSchema,
    run: async (input, { tools, req }) =>
      getEnvelope(req, input as AdminGetInput, {
        tools,
        switches: await controlFor(req),
      }),
    continuation: getContinuation,
  },
  {
    name: READ_TOOL_NAME,
    description: READ_DESCRIPTION,
    annotations: READ_ANNOTATIONS,
    klass: "read",
    profiles: ADMIN_MCP_TOOL_PROFILES,
    input: adminReadInputSchema,
    listedInput: readListedInput,
    run: (input, { key, req }) => readEnvelope(input, { key, req }),
    continuation: readContinuation,
  },
  {
    name: ACTIONS_TOOL_NAME,
    description: ACTIONS_DESCRIPTION,
    annotations: READ_ANNOTATIONS,
    klass: "read",
    profiles: ADMIN_MCP_TOOL_PROFILES,
    input: adminActionsInputSchema,
    run: async (input, { tools, req }) =>
      actionsEnvelope(input, tools, await controlFor(req)),
    continuation: actionsContinuation,
  },
  {
    name: VIEW_MEDIA_TOOL_NAME,
    description: VIEW_MEDIA_DESCRIPTION,
    annotations: READ_ANNOTATIONS,
    klass: "read",
    profiles: ADMIN_MCP_TOOL_PROFILES,
    input: adminViewMediaInputSchema,
    imageResult: true,
    run: (input, { req }) => viewMediaAnswer(req, input as AdminViewMediaInput),
  },
];

/** 2020-12 is the default dialect when a schema names none: 52 bytes a tool saved. */
const inputSchemaOf = (input: z.ZodObject) => {
  const schema = z.toJSONSchema(input, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  });
  delete schema.$schema;
  return schema;
};

export const listingTable = (tools: readonly AdminMcpTool[]) =>
  tools.map((tool) => ({
    tool,
    listing: {
      name: tool.name,
      description: tool.description,
      inputSchema: inputSchemaOf(tool.listedInput ?? tool.input),
      ...(tool.imageResult ? {} : { outputSchema: ADMIN_MCP_RESULT_SCHEMA }),
      annotations: tool.annotations,
    },
  }));

/** Built once per process, so a tools/list costs no schema conversion. */
const LISTED = listingTable(ADMIN_MCP_TOOLS);

/** While paused only admin_whoami is listed: a tool not listed is not offered. */
export const toolListingFor = (
  profile: AdminMcpToolProfile,
  paused: boolean,
  table: ReturnType<typeof listingTable> = LISTED,
) =>
  table
    .filter(
      ({ tool }) =>
        tool.profiles.includes(profile) &&
        (!paused || tool.name === WHOAMI_TOOL_NAME),
    )
    .map(({ listing }) => listing);

/** A tool outside the key's profile does not exist for that key. */
export const toolFor = (
  profile: AdminMcpToolProfile,
  name: string,
  tools: readonly AdminMcpTool[] = ADMIN_MCP_TOOLS,
): AdminMcpTool | undefined =>
  tools.find((tool) => tool.name === name && tool.profiles.includes(profile));
