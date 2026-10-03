import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { getPayload } from "payload";
import { provisionInitialOwner } from "../src/editorial/provision-owner";
import { assertInitialOwnerDatabaseTLS } from "../src/runtime-settings";

// Use `payload run scripts/provision-initial-owner.ts` with protected server
// configuration. No secret is accepted in argv and no synthetic bootstrap runs.
let file: Awaited<ReturnType<typeof open>> | undefined;
try {
  if (
    process.env.CMS_ENVIRONMENT !== "production" ||
    !process.env.CMS_INITIAL_OWNER_INPUT
  )
    throw new Error();
  file = await open(
    process.env.CMS_INITIAL_OWNER_INPUT,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const stat = await file.stat();
  if (
    !stat.isFile() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.uid !== process.getuid?.() ||
    stat.size < 1 ||
    stat.size > 4096
  )
    throw new Error();
  const bytes = Buffer.alloc(4097);
  let used = 0;
  while (used < bytes.length) {
    const result = await file.read(bytes, used, bytes.length - used, null);
    if (result.bytesRead === 0) break;
    used += result.bytesRead;
  }
  if (used > 4096) throw new Error();
  const input: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)),
  );
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !== "email,password" ||
    !("email" in input) ||
    typeof input.email !== "string" ||
    !("password" in input) ||
    typeof input.password !== "string"
  )
    throw new Error();
  assertInitialOwnerDatabaseTLS();
  const { default: config } = await import("../payload.config");
  const payload = await getPayload({ config });
  try {
    await provisionInitialOwner(payload, {
      email: input.email,
      password: input.password,
    });
    console.info("INITIAL_OWNER_CREATED");
  } finally {
    await payload.destroy();
  }
} catch {
  // Native/driver errors can contain credentials; never print the exception.
  // Payload run exits zero after a fulfilled module, so propagate only the
  // fixed category to its CLI error boundary.
  throw new Error("INITIAL_OWNER_SETUP_REFUSED");
} finally {
  await file?.close();
}
