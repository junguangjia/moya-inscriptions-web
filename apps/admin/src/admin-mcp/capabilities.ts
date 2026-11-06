import {
  ADMIN_ANALYTICS_REPORTS,
  ADMIN_MCP_TEXT_CAP_BYTES,
  ADMIN_MCP_TOKEN_BUDGET,
  ADMIN_MCP_TOOL_PROFILES,
  ADMIN_OP_NAMES,
  ADMIN_OP_TOOLS,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminAnalyticsReport,
  AdminOpName,
} from "@moya/contracts/internal/admin-mcp";

import { okEnvelope } from "./envelope";
import { adminOpMeta } from "./registry";
import { ADMIN_SURFACES } from "./surfaces";
import type { AdminSurface } from "./surfaces";
import { toolListingFor } from "./tools";
import { actionsIndex } from "./tools/actions";

const DESCRIPTION = `# Admin MCP capabilities

Generated from \`apps/admin/src/admin-mcp/registry.ts\`,
\`apps/admin/src/admin-mcp/surfaces.ts\` and the tool list in
\`apps/admin/src/admin-mcp/tools/index.ts\`. Do not edit by hand. To regenerate, run
\`pnpm --filter @moya/tests exec vitest run unit/backend/admin-mcp-registry.test.ts -u\`;
the same test fails while this file is stale.

Scope and rules: \`docs/development/admin-mcp-completion-v1.md\`. "Built" says whether
a slice has given the op its implementation yet; an op that is not built reports
\`not_available\`.
`;

/** A statistics read is a report on one tool, not an op (section 19). All on `base`. */
const ANALYTICS_REPORT_FACTS: Readonly<
  Record<
    AdminAnalyticsReport,
    { readonly source: string; readonly built: boolean }
  >
> = {
  status: { source: "canonical, config", built: true },
  overview: { source: "canonical, native block from Umami", built: true },
  trend: { source: "canonical, annotations from Umami", built: true },
  breakdown: {
    source: "canonical; Umami for province, city, device",
    built: true,
  },
  compare: { source: "canonical", built: true },
  funnel: { source: "canonical; Umami for a saved funnel", built: true },
  realtime: {
    source: "canonical, geography from Umami on request",
    built: true,
  },
  sessions: { source: "canonical; Umami on request or by place", built: true },
  session: { source: "canonical, and Umami from its session id", built: true },
  product: { source: "canonical, business tables", built: true },
  native: { source: "Umami", built: true },
  reconcile: { source: "canonical against Umami", built: true },
  traffic: { source: "hourly snapshot", built: false },
};

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** The registry test's estimate: 3 bytes a token. */
const TOOLS_LIST_CEILING_BYTES = ADMIN_MCP_TOKEN_BUDGET * 3;

/**
 * The share of the text cap past which the registry test fails, so the index is paged
 * by family before it is cut (extensibility plan 2.11), not after.
 */
export const ADMIN_ACTIONS_INDEX_ALARM_SHARE = 0.8;

const EVERY_SWITCH = { dm: true, evidence: true, rawIp: true, selfOnly: true };

/**
 * What each budget holds now, from the registry and the tool list. The index is the
 * whole one, on every op tool with every switch open and no AI token placed, which
 * files each built community op under that code: its largest form, whatever this
 * process holds.
 */
export const adminMcpBudgets = () => ({
  toolsList: {
    ceiling: TOOLS_LIST_CEILING_BYTES,
    profiles: ADMIN_MCP_TOOL_PROFILES.map((profile) => ({
      profile,
      bytes: bytesOf(toolListingFor(profile, false)),
    })),
    tools: toolListingFor("full", false).map((listing) => ({
      name: listing.name,
      bytes: bytesOf(listing),
    })),
  },
  index: {
    bytes: bytesOf(
      okEnvelope(actionsIndex([...ADMIN_OP_TOOLS], EVERY_SWITCH, () => false)),
    ),
    cap: ADMIN_MCP_TEXT_CAP_BYTES,
    alarm: Math.floor(
      ADMIN_MCP_TEXT_CAP_BYTES * ADMIN_ACTIONS_INDEX_ALARM_SHARE,
    ),
  },
});

const usage = (bytes: number, ceiling: number) =>
  `${bytes} | ${ceiling} | ${Math.round((bytes / ceiling) * 100)}% | ${ceiling - bytes}`;

const budgetSection = () => {
  const { toolsList, index } = adminMcpBudgets();
  const rows = [
    ...toolsList.profiles.map(
      ({ profile, bytes }) =>
        `| tools/list, profile \`${profile}\` | ${usage(bytes, toolsList.ceiling)} |`,
    ),
    `| \`admin_actions\` index | ${usage(index.bytes, index.cap)} |`,
  ];
  const tools = toolsList.tools.map(
    ({ name, bytes }) => `| \`${name}\` | ${bytes} |`,
  );
  return `## Budgets\n\nBytes of JSON as a client receives it. tools/list counts against \`ADMIN_MCP_TOKEN_BUDGET\` at 3 bytes a token. The \`admin_actions\` index counts against the ${index.cap}-byte text cap, measured on every op tool with every switch open and no AI token placed, its largest form; the registry test fails past ${index.alarm} bytes, ${ADMIN_ACTIONS_INDEX_ALARM_SHARE * 100}% of the cap.\n\n| Measure | Bytes | Ceiling | Used | Left |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\n| Tool | Bytes listed |\n| --- | --- |\n${tools.join("\n")}\n`;
};

const familyOf = (name: AdminOpName) => name.slice(0, name.indexOf("."));

const opRow = (name: AdminOpName) => {
  const entry = adminOpMeta[name] as (typeof adminOpMeta)[AdminOpName];
  const klass = entry.risesWhen
    ? `${entry.klass}; irreversible when ${entry.risesWhen}`
    : entry.klass;
  return `| \`${name}\` | ${klass} | \`${entry.tool}\` | ${entry.completion.kind} | ${entry.recovery} | ${entry.credential} | ${entry.sensitive ?? ""} | ${entry.run ? "yes" : "no"} |`;
};

const OP_HEADER = `| Op | Class | Tool | Completion | Recovery | Credential | Switch | Built |
| --- | --- | --- | --- | --- | --- | --- | --- |`;

const covers = (surface: AdminSurface): readonly [string, string] => {
  const code = (names: readonly string[]) =>
    names.map((name) => `\`${name}\``).join(", ");
  if ("excluded" in surface) return [surface.excluded, surface.why];
  const note = surface.note ?? "";
  if ("op" in surface) return [code(surface.op), note];
  if ("tool" in surface) return [code(surface.tool), note];
  return [code(surface.companion), note];
};

/** The whole document, unformatted: the test runs it through the repo's Prettier. */
export const renderAdminMcpCapabilities = (): string => {
  const families = [...new Set(ADMIN_OP_NAMES.map(familyOf))];
  const ops = families.map((family) => {
    const names = ADMIN_OP_NAMES.filter((name) => familyOf(name) === family);
    return `### ${family} (${names.length})\n\n${OP_HEADER}\n${names.map(opRow).join("\n")}\n`;
  });
  const surfaces = Object.entries(ADMIN_SURFACES).map(
    ([surface, target]) => `| \`${surface}\` | ${covers(target).join(" | ")} |`,
  );
  return [
    DESCRIPTION,
    budgetSection(),
    `## Ops (${ADMIN_OP_NAMES.length})\n`,
    ...ops,
    `## Reports on \`admin_analytics\` (${ADMIN_ANALYTICS_REPORTS.length})\n\nEvery report reads on the \`base\` credential and takes the same range, time zone and filter arguments. One that is not built reports \`NOT_AVAILABLE\`.\n\n| Report | Source | Built |\n| --- | --- | --- |\n${ADMIN_ANALYTICS_REPORTS.map((report) => `| \`${report}\` | ${ANALYTICS_REPORT_FACTS[report].source} | ${ANALYTICS_REPORT_FACTS[report].built ? "yes" : "no"} |`).join("\n")}\n`,
    `## Surfaces\n\nEvery route of \`community/endpoints.ts\` and \`editorial/endpoints.ts\` not listed here maps to the op of its own name.\n\n| Surface | Covered by, or why not | Note |\n| --- | --- | --- |\n${surfaces.join("\n")}\n`,
  ].join("\n");
};
