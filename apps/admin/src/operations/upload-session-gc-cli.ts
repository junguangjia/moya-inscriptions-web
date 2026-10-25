/** Node 24 standalone maintenance entry; imports neither Payload config nor the Admin application. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import {
  createPostgresPool,
  closePostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  pruneUploadSessions,
  UploadSessionGcError,
} from "./upload-session-gc.ts";
import { uploadGcPostgresLocks } from "./upload-session-gc-postgres.ts";

export async function uploadSessionGcMain(
  argv: string[],
  env: NodeJS.ProcessEnv,
) {
  if (
    argv.some((arg) => arg !== "--execute") ||
    argv.length > 1 ||
    !env.CMS_MEDIA_DIR ||
    !env.CMS_DATABASE_URL
  )
    throw new Error("UPLOAD_GC_CONFIGURATION_INVALID");
  const deadline = Date.now() + 45_000;
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // An OS/runtime stall cannot silently hold the advisory lock beyond the run deadline.
  const hardStop = setTimeout(() => {
    process.stderr.write(
      '{"status":"FAIL","category":"UPLOAD_GC_DEADLINE","credentialValuesPrinted":false}\n',
    );
    process.exit(1);
  }, 50_000);
  hardStop.unref();
  const config = parsePostgresConfig({
    DATABASE_URL: env.CMS_DATABASE_URL,
    DATABASE_SSL_CA_FILE: env.CMS_DATABASE_SSL_CA_FILE,
    DATABASE_POOL_MAX: "1",
  });
  const pool = createPostgresPool(config);
  try {
    const parent = await realpath(path.dirname(env.CMS_MEDIA_DIR));
    const mediaDirectory = path.join(parent, path.basename(env.CMS_MEDIA_DIR));
    const result = await pruneUploadSessions(
      {
        root: path.join(parent, "editorial-upload-sessions"),
        mediaDirectory,
        execute: argv.includes("--execute"),
        deadline,
        stopped: () => stopped,
      },
      uploadGcPostgresLocks(pool),
    );
    return {
      status: "PASS",
      mode: argv.includes("--execute") ? "EXECUTED" : "PLAN_ONLY",
      ...result,
      credentialValuesPrinted: false,
    };
  } finally {
    clearTimeout(hardStop);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await closePostgresPool(pool);
  }
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  uploadSessionGcMain(process.argv.slice(2), process.env).then(
    (result) => console.log(JSON.stringify(result)),
    (error: unknown) => {
      console.error(
        JSON.stringify({
          status: "FAIL",
          category:
            error instanceof UploadSessionGcError
              ? error.code
              : "UPLOAD_GC_FAILED",
          credentialValuesPrinted: false,
        }),
      );
      process.exitCode = 1;
    },
  );
}
