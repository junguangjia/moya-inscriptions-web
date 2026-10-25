import type { UploadGcLocks } from "./upload-session-gc.ts";

/** Structural pg client interface: the package reuses the existing locked catalog PostgreSQL pool. */
export type UploadGcPool = {
  connect: () => Promise<{
    query: (text: string, values?: string[]) => Promise<unknown>;
    release: (destroy?: boolean) => void;
  }>;
};
export function uploadGcPostgresLocks(pool: UploadGcPool): UploadGcLocks {
  let current: Awaited<ReturnType<UploadGcPool["connect"]>> | undefined;
  const lock = async (key: string) => {
    if (!current) throw new Error("UPLOAD_GC_TRANSACTION_REQUIRED");
    await current.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`moya-editorial:${key}`],
    );
  };
  return {
    allocation: async (work) => {
      if (current) throw new Error("UPLOAD_GC_TRANSACTION_NESTED");
      const client = await pool.connect();
      current = client;
      let destroy = false;
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '5s'");
        await lock("media-upload-allocation");
        const result = await work();
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          destroy = true;
        }
        throw error;
      } finally {
        current = undefined;
        client.release(destroy);
      }
    },
    session: async (manifest, work) => {
      await lock(`media-upload-media:${manifest.intent.mediaId}`);
      await lock(`media-upload-session:${manifest.uploadId}`);
      return work();
    },
  };
}
