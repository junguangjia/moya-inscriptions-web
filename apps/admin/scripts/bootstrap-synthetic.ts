import { randomBytes } from "node:crypto";
import { writeFile, chmod } from "node:fs/promises";
import { getPayload, type Payload } from "payload";
import config from "../payload.config";

/**
 * One synthetic Owner, one scoped automation identity and one MCP key for a
 * verification session, handed over through the session's mode-restricted
 * file.
 *
 * The disposable CMS database this runs against is created once per task and
 * never reset, and the verification session that runs this script stops only
 * its child processes: the rows of an earlier session stay. The identities
 * therefore carry a per-session namespace instead of fixed addresses, so a
 * repeated cumulative validation on the same database never meets its own
 * leftovers. Every consumer reads the actual addresses from the handoff file;
 * nothing hardcodes them.
 *
 * A failure prints one fixed line carrying a bare category and nothing else.
 * The orchestrator keeps that category and never forwards raw child output.
 */
const FAILURE_CATEGORY = /^[A-Z][A-Z_]{2,63}$/u;
const report = (category: string): void => {
  console.log(JSON.stringify({ syntheticBootstrap: "FAIL", category }));
};
function refuse(category: string): never {
  report(category);
  throw new Error(category);
}

if (process.env.CMS_ENVIRONMENT !== "synthetic")
  refuse("SYNTHETIC_ENVIRONMENT_REQUIRED");
const destination = process.env.CMS_QA_HANDOFF_FILE;
if (!destination) refuse("SYNTHETIC_HANDOFF_REQUIRED");
let payload: Payload | undefined;
try {
  payload = await getPayload({ config });
  const namespace = randomBytes(6).toString("hex");
  const ownerEmail = `owner-${namespace}@editorial.example.invalid`;
  const automationEmail = `automation-${namespace}@editorial.example.invalid`;
  const ownerPassword = randomBytes(24).toString("hex");
  const automationPassword = randomBytes(24).toString("hex");
  const existing = await payload.find({
    collection: "users",
    where: { email: { equals: ownerEmail } },
    limit: 1,
  });
  if (existing.totalDocs) refuse("SYNTHETIC_OWNER_ALREADY_EXISTS");
  const owner = await payload.create({
    collection: "users",
    overrideAccess: true,
    data: {
      email: ownerEmail,
      password: ownerPassword,
      role: "owner",
      scopeCatalogIds: [],
    },
  });
  const automation = await payload.create({
    collection: "users",
    overrideAccess: true,
    data: {
      email: automationEmail,
      password: automationPassword,
      role: "automation",
      scopeCatalogIds: ["catalog-synthetic-mcp-1", "catalog-synthetic-mcp-2"],
    },
  });
  const bearer = randomBytes(32).toString("hex");
  const restKey = randomBytes(32).toString("hex");
  await payload.update({
    collection: "users",
    id: automation.id,
    overrideAccess: true,
    data: { enableAPIKey: true, apiKey: restKey },
  });
  await payload.create({
    collection: "payload-mcp-api-keys",
    overrideAccess: true,
    data: {
      user: automation.id,
      label: "Synthetic Codex editorial",
      enableAPIKey: true,
      apiKey: bearer,
      "payload-mcp-tool": {
        editorialQuery: true,
        editorialRead: true,
        editorialSaveDraft: true,
        editorialPublishApproved: true,
        editorialBatchResults: true,
      },
    },
  });
  await writeFile(
    destination,
    JSON.stringify({
      ownerEmail,
      ownerPassword,
      ownerId: owner.id,
      automationEmail,
      automationPassword,
      automationId: automation.id,
      bearer,
      restKey,
    }),
    { mode: 0o600, flag: "wx" },
  );
  await chmod(destination, 0o600);
  console.log(
    JSON.stringify({
      syntheticBootstrap: "created",
      identities: 2,
      mcpKey: "scoped",
    }),
  );
} catch (error) {
  // Own refusals were reported above; anything else collapses to one bare
  // category, so a driver or validation message never reaches stdout.
  if (!(error instanceof Error && FAILURE_CATEGORY.test(error.message)))
    report("SYNTHETIC_BOOTSTRAP_FAILED");
  throw error;
} finally {
  await payload?.destroy();
}
