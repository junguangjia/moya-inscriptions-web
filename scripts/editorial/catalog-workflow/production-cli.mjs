import path from "node:path";
import { privateJSON } from "../../curation/adapter.mjs";
import { digest, fail, targetIdentity, validateManifest } from "./identity.mjs";
import {
  normalizeProductionAuthority,
  assertProductionCommand,
} from "./production-authority.mjs";
import {
  withProductionCatalogSession,
  productionLimits,
} from "./production-session.mjs";

/** Parse only; missing execution authority fails before reading any credential. */
export async function runProductionCommand(command, args) {
  const opts = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      ![
        "--manifest",
        "--input",
        "--authority",
        "--credential-file",
        "--state-dir",
      ].includes(args[i]) ||
      !path.isAbsolute(args[i + 1] ?? "") ||
      opts[args[i]]
    )
      fail("PRODUCTION_CLI_ARGUMENTS_INVALID");
    opts[args[i]] = args[i + 1];
  }
  if (Object.keys(opts).length !== 5) fail("PRODUCTION_CLI_ARGUMENTS_INVALID");
  const manifest = validateManifest(
    await privateJSON(opts["--manifest"], 16 * 1024 * 1024),
  );
  const authority = normalizeProductionAuthority(
    manifest,
    await privateJSON(opts["--authority"], 65536),
  );
  assertProductionCommand(authority, command, manifest);
  const input = await privateJSON(opts["--input"], 16 * 1024 * 1024);
  if (
    input?.version !== 1 ||
    !input.controlled ||
    !input.expectedNative ||
    !Array.isArray(input.conversions)
  )
    fail("PRODUCTION_INPUT_INVALID");
  const frozenInput = digest(input),
    frozenAuthority = digest(authority),
    frozenManifest = digest(manifest);
  if (frozenInput !== authority.inputSha256) fail("PRODUCTION_INPUT_CHANGED");
  const assertBindingActive = async () => {
    const current = normalizeProductionAuthority(
      manifest,
      await privateJSON(opts["--authority"], 65536),
    );
    if (
      digest(current) !== frozenAuthority ||
      digest(await privateJSON(opts["--manifest"], 16 * 1024 * 1024)) !==
        frozenManifest ||
      digest(await privateJSON(opts["--input"], 16 * 1024 * 1024)) !==
        frozenInput
    )
      fail("PRODUCTION_INPUT_CHANGED");
    assertProductionCommand(current, command, manifest);
  };
  const authorization = async () => {
    // Only this controlled program reads the already saved CMS credential.
    // Never return the file, credential, raw errors or authenticated URLs in reports.
    const saved = await privateJSON(opts["--credential-file"], 32768);
    if (
      saved?.version !== 1 ||
      saved.origin !== authority.origin ||
      saved.actorId !== authority.actorId ||
      !["JWT", "users API-Key"].includes(saved.scheme) ||
      typeof saved.credential !== "string"
    )
      fail("PRODUCTION_CREDENTIAL_BINDING_CHANGED");
    return `${saved.scheme} ${saved.credential}`;
  };
  return withProductionCatalogSession(
    {
      manifest,
      authority,
      input,
      command,
      directory: opts["--state-dir"],
      authorization,
      assertBindingActive,
      limits: productionLimits(authority),
      responseByteLimit: Math.min(131072, authority.caps.responseBodyTotal),
      deadline: Math.min(
        Date.now() + 120000,
        Date.parse(authority.expiresAt),
        Date.parse(authority.credentialExpiresAt),
      ),
      timeoutMs: 10000,
    },
    async (client) => {
      let outcome;
      if (command === "withdraw") outcome = await client.withdraw();
      else {
        if (
          command === "upload" ||
          (command === "run" && !client.snapshot().frozen)
        )
          await client.ensureMedia();
        if (command === "run" && !client.snapshot().frozen)
          await client.saveDraft();
        if (command === "run" && manifest.records[0].disposition === "draft")
          outcome = {
            status: "DRAFT_VERIFIED",
            native: await client.inspect(),
          };
        else if (["publish", "run"].includes(command))
          outcome = await client.publish();
        else
          outcome = {
            status: "MEDIA_PROOFS_VERIFIED",
            count: Object.keys(client.snapshot().proofs).length,
          };
      }
      return {
        version: 1,
        executionKind: "native-https",
        command,
        manifestSha256: frozenManifest,
        targetIdentitySha256: targetIdentity(manifest),
        authorityReferenceSha256: authority.authorityReferenceSha256,
        outcome,
        transport: client.metrics(),
        anonymousDeliveryVerified: false,
        credentialMaterialIncluded: false,
      };
    },
  );
}
