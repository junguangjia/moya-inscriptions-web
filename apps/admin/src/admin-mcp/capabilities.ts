import { ADMIN_OP_NAMES } from "@moya/contracts/internal/admin-mcp";
import type { AdminOpName } from "@moya/contracts/internal/admin-mcp";

import { adminOpMeta } from "./registry";
import { ADMIN_SURFACES } from "./surfaces";
import type { AdminSurface } from "./surfaces";

const DESCRIPTION = `# Admin MCP capabilities

Generated from \`apps/admin/src/admin-mcp/registry.ts\` and
\`apps/admin/src/admin-mcp/surfaces.ts\`. Do not edit by hand. To regenerate, run
\`pnpm --filter @moya/tests exec vitest run unit/backend/admin-mcp-registry.test.ts -u\`;
the same test fails while this file is stale.

Scope and rules: \`docs/development/admin-mcp-completion-v1.md\`. "Built" says whether
a slice has given the op its implementation yet; an op that is not built reports
\`not_available\`.
`;

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
    `## Ops (${ADMIN_OP_NAMES.length})\n`,
    ...ops,
    `## Surfaces\n\nEvery route of \`community/endpoints.ts\` and \`editorial/endpoints.ts\` not listed here maps to the op of its own name.\n\n| Surface | Covered by, or why not | Note |\n| --- | --- | --- |\n${surfaces.join("\n")}\n`,
  ].join("\n");
};
