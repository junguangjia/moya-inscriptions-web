import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  createPostgresPool,
  closePostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import { editorialMediaUploadStartSchema } from "@moya/contracts/internal/editorial";
import {
  pruneUploadSessions,
  readUploadSessionManifest,
  uploadSessionId,
  UPLOAD_SESSION_TTL,
  UPLOAD_COMPLETION_GRACE,
  type UploadGcOptions,
  type UploadGcLocks,
  type UploadSessionManifest,
} from "admin/upload-session-gc";
import { uploadGcPostgresLocks } from "admin/upload-session-gc-postgres";

let directory: string, root: string, mediaDirectory: string;
const digest = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");
const unlocked: UploadGcLocks = {
  allocation: (work) => work(),
  session: (_manifest, work) => work(),
};
const options = (extra: Partial<UploadGcOptions> = {}): UploadGcOptions => ({
  root,
  mediaDirectory,
  execute: true,
  ...extra,
});
async function fixture(age = UPLOAD_SESSION_TTL + 1000, completeAge?: number) {
  const data = Buffer.from("synthetic original bytes");
  const intent = editorialMediaUploadStartSchema.parse({
    transferId: digest(randomUUID()),
    catalogId: "SYN-GC",
    mediaId: `gc-${randomUUID()}`,
    sha256: digest(data),
    bytes: data.length,
    mimeType: "image/png",
    alt: "Synthetic upload",
  });
  const actorId = "synthetic-owner",
    uploadId = uploadSessionId(actorId, intent),
    createdAt = Date.now() - age;
  const manifest: UploadSessionManifest = {
    version: 1,
    uploadId,
    actorId,
    intent,
    createdAt,
    expiresAt: createdAt + UPLOAD_SESSION_TTL,
  };
  const folder = path.join(root, uploadId);
  await mkdir(folder, { mode: 0o700 });
  await writeFile(
    path.join(folder, "manifest.json"),
    JSON.stringify(manifest),
    { mode: 0o600 },
  );
  await writeFile(path.join(folder, "chunk-0.bin"), data, { mode: 0o600 });
  if (completeAge !== undefined) {
    const complete = path.join(folder, "complete.json");
    await writeFile(
      complete,
      JSON.stringify({
        reused: false,
        validatedBytes: data.length,
        validatedSha256: intent.sha256,
        media: {
          id: 1,
          catalogId: intent.catalogId,
          mediaId: intent.mediaId,
          objectKey: `editorial/${digest("catalog")}/${digest("media")}-${intent.sha256}.png`,
          sha256: intent.sha256,
          mimeType: intent.mimeType,
          filesize: data.length,
          filename: "synthetic.png",
          width: 1,
          height: 1,
          alt: intent.alt,
        },
      }),
      { mode: 0o600 },
    );
    const time = new Date(Date.now() - completeAge);
    await utimes(complete, time, time);
  }
  return { manifest, folder, data };
}
beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "yoyi-upload-gc-test-")),
  );
  root = path.join(directory, "editorial-upload-sessions");
  mediaDirectory = path.join(directory, "media");
  await mkdir(root, { mode: 0o700 });
  await mkdir(mediaDirectory, { mode: 0o700 });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("bounded private buffer retention", () => {
  it("collects without another start request and leaves canonical media unchanged", async () => {
    const f = await fixture();
    const canonical = path.join(mediaDirectory, "canonical.bin");
    await writeFile(canonical, f.data);
    const planned = await pruneUploadSessions(
      options({ execute: false }),
      unlocked,
    );
    expect(planned.sessions).toBe(1);
    expect(await readdir(root)).toEqual([f.manifest.uploadId]);
    await expect(lstat(root + "-gc")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await pruneUploadSessions(options(), unlocked)).sessions).toBe(1);
    expect(await readdir(root)).toEqual([]);
    expect(await readdir(root + "-gc")).toEqual([]);
    expect(await readFile(canonical)).toEqual(f.data);
    expect((await pruneUploadSessions(options(), unlocked)).sessions).toBe(0);
  });
  it.each(["same", "child", "parent"])(
    "refuses quarantine/canonical-media overlap (%s) before recovery deletes bytes",
    async (relationship) => {
      const f = await fixture();
      await expect(
        pruneUploadSessions(
          options({
            checkpoint: async (phase) => {
              if (phase === "claimed")
                throw new Error("SYNTHETIC_CLAIM_INTERRUPTION");
            },
          }),
          unlocked,
        ),
      ).rejects.toThrow("SYNTHETIC_CLAIM_INTERRUPTION");
      const quarantine = root + "-gc";
      const recovery = path.join(quarantine, f.manifest.uploadId);
      const media =
        relationship === "same"
          ? quarantine
          : relationship === "child"
            ? recovery
            : directory;
      await expect(
        pruneUploadSessions(options({ mediaDirectory: media }), unlocked),
      ).rejects.toThrow("UPLOAD_STORAGE_UNSAFE");
      expect(await readFile(path.join(recovery, "chunk-0.bin"))).toEqual(
        f.data,
      );
      expect(await readdir(quarantine)).toEqual([f.manifest.uploadId]);
    },
  );
  it("preserves active uploads and completion replay grace using the existing exact TTLs", async () => {
    const active = await fixture(UPLOAD_SESSION_TTL - 60_000);
    const replay = await fixture(60_000, UPLOAD_COMPLETION_GRACE - 60_000);
    const completed = await fixture(60_000, UPLOAD_COMPLETION_GRACE + 1000);
    expect((await pruneUploadSessions(options(), unlocked)).sessions).toBe(1);
    expect((await readdir(root)).sort()).toEqual(
      [active.manifest.uploadId, replay.manifest.uploadId].sort(),
    );
    await expect(lstat(completed.folder)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it.each([
    "before-rename",
    "claimed",
    "intent-written",
    "unlinked",
    "intent-unlinked",
  ])(
    "recovers interruption at %s while the old allocator sees only a valid session or no session",
    async (phase) => {
      const f = await fixture();
      let interrupted = false;
      await expect(
        pruneUploadSessions(
          options({
            checkpoint: async (at) => {
              // Same visibility as the old allocator, while its advisory allocation lock excludes mutations.
              for (const name of await readdir(root))
                expect(
                  await readUploadSessionManifest(root, name),
                ).toMatchObject({ uploadId: name });
              if (at === phase && !interrupted) {
                interrupted = true;
                throw new Error("SYNTHETIC_INTERRUPTION");
              }
            },
          }),
          unlocked,
        ),
      ).rejects.toThrow("SYNTHETIC_INTERRUPTION");
      expect(interrupted).toBe(true);
      await pruneUploadSessions(options(), unlocked);
      expect(await readdir(root)).toEqual([]);
      expect(await readdir(root + "-gc")).toEqual([]);
      await expect(lstat(f.folder)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("recovers the persisted claim even when manifest was already deleted", async () => {
    const f = await fixture();
    await expect(
      pruneUploadSessions(
        options({
          checkpoint: async (phase) => {
            if (phase === "intent-written") throw new Error("STOP");
          },
        }),
        unlocked,
      ),
    ).rejects.toThrow("STOP");
    await unlink(path.join(root + "-gc", f.manifest.uploadId, "manifest.json"));
    expect((await pruneUploadSessions(options(), unlocked)).sessions).toBe(1);
    expect(await readdir(root + "-gc")).toEqual([]);
  });
  it.each(["unknown", "malformed", "symlink", "hardlink", "permissions"])(
    "refuses %s before moving or deleting the source",
    async (kind) => {
      const f = await fixture(),
        chunk = path.join(f.folder, "chunk-0.bin");
      if (kind === "unknown")
        await writeFile(path.join(f.folder, "unknown.bin"), "private", {
          mode: 0o600,
        });
      if (kind === "malformed")
        await writeFile(path.join(f.folder, "manifest.json"), "{}");
      if (kind === "symlink") {
        await unlink(chunk);
        await symlink(path.join(mediaDirectory, "keep.bin"), chunk);
      }
      if (kind === "hardlink")
        await link(chunk, path.join(mediaDirectory, "keep.bin"));
      if (kind === "permissions") await chmod(chunk, 0o644);
      await expect(pruneUploadSessions(options(), unlocked)).rejects.toThrow(
        "UPLOAD_STORAGE_UNSAFE",
      );
      expect(await readdir(root)).toEqual([f.manifest.uploadId]);
    },
  );
  it("enforces session and byte budgets, and a stop before claiming leaves the source intact", async () => {
    await fixture();
    await fixture();
    expect(
      (await pruneUploadSessions(options({ maxBytes: 1 }), unlocked)).sessions,
    ).toBe(0);
    expect(
      (await pruneUploadSessions(options({ maxSessions: 1 }), unlocked))
        .sessions,
    ).toBe(1);
    await expect(
      pruneUploadSessions(options({ stopped: () => true }), unlocked),
    ).rejects.toThrow("UPLOAD_GC_STOPPED");
    expect(await readdir(root)).toHaveLength(1);
  });
  it("runs the actual Node 24 CLI without a Payload/Next startup", async () => {
    const cli = path.resolve(
      "../apps/admin/src/operations/upload-session-gc-cli.ts",
    );
    const child = spawn(process.execPath, [cli, "--unknown"], {
      env: { NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    const exit = await new Promise((resolve) => child.once("exit", resolve));
    expect(exit).toBe(1);
    expect(JSON.parse(stderr)).toEqual({
      status: "FAIL",
      category: "UPLOAD_GC_FAILED",
      credentialValuesPrinted: false,
    });
  });
});

it("recovers after a real process kill releases the PG locks and preserves a fresh same-ID session", async () => {
  const f = await fixture();
  const script = path.join(directory, "killed-reaper.mts");
  await writeFile(
    script,
    `
import { pruneUploadSessions } from ${JSON.stringify(import.meta.resolve("admin/upload-session-gc"))};
import { uploadGcPostgresLocks } from ${JSON.stringify(import.meta.resolve("admin/upload-session-gc-postgres"))};
import { createPostgresPool, parsePostgresConfig } from ${JSON.stringify(import.meta.resolve("@moya/catalog-postgres"))};
const pool = createPostgresPool(parsePostgresConfig({DATABASE_URL:process.env.CMS_TEST_DATABASE_URL}));
await pruneUploadSessions({root:${JSON.stringify(root)},mediaDirectory:${JSON.stringify(mediaDirectory)},execute:true,
 checkpoint:async phase=>{if(phase==='unlinked'){process.stdout.write('KILL_BOUNDARY\\n');await new Promise(()=>setInterval(()=>{},1000));}}},uploadGcPostgresLocks(pool));
`,
    { mode: 0o600 },
  );
  const child = spawn(process.execPath, [script], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (value) => {
    stderr += value;
  });
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const boundary = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("SYNTHETIC_CHILD_DEADLINE"));
    }, 5000);
    child.stdout.once("data", () => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve();
    });
    child.once("exit", (code) => {
      if (code !== null) {
        clearTimeout(timer);
        reject(new Error("SYNTHETIC_CHILD_FAILED"));
      }
    });
  });
  await boundary;
  expect((await closed).signal).toBe("SIGKILL");
  expect(stderr).toBe("");
  expect(await readdir(root)).toEqual([]);
  // An older allocator may already have accepted a fresh retry with the same transfer identity.
  const now = Date.now(),
    fresh = {
      ...f.manifest,
      createdAt: now,
      expiresAt: now + UPLOAD_SESSION_TTL,
    };
  await mkdir(f.folder, { mode: 0o700 });
  await writeFile(path.join(f.folder, "manifest.json"), JSON.stringify(fresh), {
    mode: 0o600,
  });
  await writeFile(path.join(f.folder, "chunk-0.bin"), f.data, { mode: 0o600 });
  expect(
    (await pruneUploadSessions(options(), uploadGcPostgresLocks(pool)))
      .sessions,
  ).toBe(1);
  expect(await readUploadSessionManifest(root, fresh.uploadId)).toEqual(fresh);
  expect(await readFile(path.join(f.folder, "chunk-0.bin"))).toEqual(f.data);
  expect(await readdir(root + "-gc")).toEqual([]);
});
it("runs the real independent CLI successfully using only dedicated synthetic settings", async () => {
  await fixture();
  const cli = path.resolve(
    "../apps/admin/src/operations/upload-session-gc-cli.ts",
  );
  const linkedCli = path.join(directory, "maintenance-current.ts");
  await symlink(cli, linkedCli);
  const child = spawn(process.execPath, [linkedCli, "--execute"], {
    env: {
      ...process.env,
      CMS_DATABASE_URL: connection!,
      CMS_MEDIA_DIR: mediaDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (value) => {
    stdout += value;
  });
  child.stderr.on("data", (value) => {
    stderr += value;
  });
  const code = await new Promise((resolve) => child.once("close", resolve));
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({
    status: "PASS",
    mode: "EXECUTED",
    sessions: 1,
    credentialValuesPrinted: false,
  });
  expect(await readdir(root)).toEqual([]);
});

const connection = process.env.CMS_TEST_DATABASE_URL;
if (
  !connection ||
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(connection).hostname) ||
  !/(^|_)(test|synthetic)(_|$)/i.test(new URL(connection).pathname.slice(1))
)
  throw new Error("TASK_OWNED_SYNTHETIC_POSTGRES_REQUIRED");
const pool = createPostgresPool(
  parsePostgresConfig({ DATABASE_URL: connection, DATABASE_POOL_MAX: "4" }),
);
beforeAll(async () => {
  const probe = await pool.query(
    "SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname=current_database()",
  );
  expect(probe.rows).toEqual([{ marker: "yoyi-disposable-test-target" }]);
});
afterAll(async () => {
  await closePostgresPool(pool);
});
it("uses the real allocation and session PG locks before any filesystem claim", async () => {
  const f = await fixture();
  const blocker = await pool.connect();
  const observer = await pool.connect();
  const key = `moya-editorial:media-upload-session:${f.manifest.uploadId}`;
  await blocker.query("BEGIN");
  await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    key,
  ]);
  let done = false;
  const collecting = pruneUploadSessions(
    options(),
    uploadGcPostgresLocks(pool),
  ).then((value) => {
    done = true;
    return value;
  });
  collecting.catch(() => undefined); // Attach immediately while observing a real blocked query.
  try {
    let waiting = false;
    const deadline = Date.now() + 3000;
    while (!waiting && Date.now() < deadline) {
      const result = await observer.query(
        "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting",
      );
      waiting = result.rows[0].waiting;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    expect(done).toBe(false);
    expect(await readFile(path.join(f.folder, "chunk-0.bin"))).toEqual(f.data);
    await blocker.query("COMMIT");
    expect((await collecting).sessions).toBe(1);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    observer.release();
    await collecting;
  }
});
