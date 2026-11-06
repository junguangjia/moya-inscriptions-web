import {
  ADMIN_MCP_CONTRACT_VERSION,
  ADMIN_MCP_RESULT_SCHEMA,
  ADMIN_MCP_TOOL_PROFILES,
  adminActionsInputSchema,
  adminAnalyticsInputSchema,
  adminExecuteInputSchema,
  adminFindInputSchema,
  adminGetInputSchema,
  adminJobInputSchema,
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

import { analyticsEnvelope } from "../analytics/service";
import { controlFor } from "../control/state";
import type { AdminMcpKey } from "../door";
import { findEnvelope } from "../locate";
import { textHash } from "../text-window";
import {
  ACTIONS_DESCRIPTION,
  ACTIONS_TOOL_NAME,
  actionsCatalogHash,
  actionsContinuation,
  actionsEnvelope,
} from "./actions";
import {
  ANALYTICS_DESCRIPTION,
  ANALYTICS_TOOL_NAME,
  analyticsListedInput,
} from "./analytics";
import {
  EXECUTE_DESCRIPTION,
  EXECUTE_TOOL_NAME,
  executeContinuation,
  executeEnvelope,
  executeListedInput,
  executeReferences,
} from "./execute";
import {
  FIND_DESCRIPTION,
  FIND_TOOL_NAME,
  findContinuation,
  findListedInput,
} from "./find";
import {
  GET_DESCRIPTION,
  GET_TOOL_NAME,
  getContinuation,
  getEnvelope,
  getListedInput,
} from "./get";
import {
  JOB_DESCRIPTION,
  JOB_TOOL_NAME,
  jobContinuation,
  jobEnvelope,
  jobListedInput,
} from "./job";
import {
  READ_DESCRIPTION,
  READ_TOOL_NAME,
  readContinuation,
  readEnvelope,
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
  /** Safe references for the audit rows of a write, from the unchecked arguments. */
  references?(args: unknown): {
    readonly op?: string;
    readonly requestId?: string;
    readonly count?: number;
    readonly targetType?: string;
    readonly targetId?: string;
  };
  /** How a result cut at the size cap continues, from the records it kept. */
  continuation?(
    input: unknown,
    kept: readonly unknown[],
  ): AdminMcpNext | null | undefined;
}

const READ_ANNOTATIONS: AdminMcpAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Reversible, and the same requestId replays. */
const EXECUTE_ANNOTATIONS: AdminMcpAnnotations = {
  readOnlyHint: false,
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
    run: async (_input, { key, tools }) =>
      whoamiEnvelope(key, tools, contractOf(key)),
  },
  {
    name: FIND_TOOL_NAME,
    description: FIND_DESCRIPTION,
    annotations: READ_ANNOTATIONS,
    klass: "read",
    profiles: ADMIN_MCP_TOOL_PROFILES,
    input: adminFindInputSchema,
    listedInput: findListedInput,
    run: async (input, { key, tools, req }) =>
      findEnvelope(req, input as AdminFindInput, {
        tools,
        userId: key.user.id,
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
    listedInput: getListedInput,
    run: async (input, { key, tools, req }) =>
      getEnvelope(req, input as AdminGetInput, {
        tools,
        userId: key.user.id,
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
    run: (input, { key, req }) => readEnvelope(input, { key, req }),
    continuation: readContinuation,
  },
  {
    name: ANALYTICS_TOOL_NAME,
    description: ANALYTICS_DESCRIPTION,
    annotations: READ_ANNOTATIONS,
    klass: "read",
    profiles: ADMIN_MCP_TOOL_PROFILES,
    input: adminAnalyticsInputSchema,
    listedInput: analyticsListedInput,
    run: (input) => analyticsEnvelope(input),
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
  {
    name: JOB_TOOL_NAME,
    description: JOB_DESCRIPTION,
    annotations: READ_ANNOTATIONS,
    klass: "read",
    profiles: ADMIN_MCP_TOOL_PROFILES,
    input: adminJobInputSchema,
    listedInput: jobListedInput,
    run: (input, { req }) => jobEnvelope(input, req),
    continuation: jobContinuation,
  },
  {
    name: EXECUTE_TOOL_NAME,
    description: EXECUTE_DESCRIPTION,
    annotations: EXECUTE_ANNOTATIONS,
    klass: "reversible",
    profiles: ["operate", "full"],
    input: adminExecuteInputSchema,
    listedInput: executeListedInput,
    references: executeReferences,
    run: (input, { key, req }) => executeEnvelope(input, { key, req }),
    continuation: executeContinuation,
  },
];

const isEmptyObject = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  Object.keys(value).length === 0;

/**
 * What changes no call, and keeps tools/list inside its budget: Zod's safe-integer
 * bounds and the empty keys of an open object. A closed object stays closed, because a
 * model reads that.
 */
const withoutNoise = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutNoise);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const open = isEmptyObject(source.additionalProperties);
  return Object.fromEntries(
    Object.entries(source)
      .filter(
        ([key, item]) =>
          !(
            ((key === "maximum" || key === "minimum") &&
              Math.abs(item as number) === Number.MAX_SAFE_INTEGER) ||
            (open &&
              (key === "additionalProperties" ||
                key === "propertyNames" ||
                (key === "properties" && isEmptyObject(item))))
          ),
      )
      .map(([key, item]) => [key, withoutNoise(item)]),
  );
};

/** 2020-12 is the default dialect when a schema names none: 52 bytes a tool saved. */
const inputSchemaOf = (input: z.ZodObject) => {
  const schema = z.toJSONSchema(input, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  });
  delete schema.$schema;
  return withoutNoise(schema) as typeof schema;
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

/**
 * What admin_whoami says of the contract: the version served, the op catalog and this
 * key's tools/list, each as a short hash, so a client can tell a release changed them.
 */
export const contractOf = (
  key: Pick<AdminMcpKey, "toolProfile" | "paused">,
) => ({
  version: ADMIN_MCP_CONTRACT_VERSION,
  catalog: actionsCatalogHash(),
  tools: textHash(
    JSON.stringify(toolListingFor(key.toolProfile, key.paused)),
  ).slice(0, 16),
});

/** A tool outside the key's profile does not exist for that key. */
export const toolFor = (
  profile: AdminMcpToolProfile,
  name: string,
  tools: readonly AdminMcpTool[] = ADMIN_MCP_TOOLS,
): AdminMcpTool | undefined =>
  tools.find((tool) => tool.name === name && tool.profiles.includes(profile));
