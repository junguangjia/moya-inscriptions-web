import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import process from "node:process";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  editorialApproveBatchSchema,
  editorialRestoreDraftSchema,
} from "@moya/contracts/internal/editorial";

type Manifest = {
  version: number;
  batchId: string;
  operation: string;
  items: Record<string, unknown>[];
};
type Prepared = {
  key: string;
  body: Record<string, unknown>;
  requestHash: string;
  file?: { sha256: string };
};
type Outcome = {
  ok: boolean;
  retryable?: boolean;
  code?: string;
  result?: Record<string, unknown>;
};
type RunOptions = {
  manifest: Manifest;
  directory: string;
  receiptFile: string;
  dryRun?: boolean;
  transport?: (operation: string, item: Prepared) => Promise<Outcome>;
  concurrency?: number;
  attempts?: number;
  retryDelayMs?: number;
  budgetMs?: number;
  now?: () => number;
  signal?: AbortSignal;
};
const { runBatch, prepareItems, createTransport } = (await import(
  new URL("../../scripts/editorial/batch.mjs", import.meta.url).href
)) as {
  runBatch: (options: RunOptions) => Promise<{
    total: number;
    succeeded: number;
    failed: number;
    pending: number;
    dryRun: boolean;
  }>;
  prepareItems: (manifest: Manifest, directory: string) => Promise<Prepared[]>;
  createTransport: (
    config: Record<string, unknown>,
    fetchImpl?: typeof fetch,
  ) => (operation: string, item: Prepared) => Promise<Outcome>;
};
const directories: string[] = [];
async function fixture(
  items: Record<string, unknown>[] = [
    {
      key: "record-one",
      content: {
        catalogId: "catalog-one",
        sourceId: "source-one",
        kind: "inscription",
        title: "Fictional inscription",
      },
    },
  ],
) {
  const directory = await mkdtemp(join(tmpdir(), "editorial-batch-"));
  directories.push(directory);
  return {
    directory,
    receiptFile: join(directory, "receipt.json"),
    manifest: {
      version: 1,
      batchId: "synthetic-batch",
      operation: "save-draft",
      items,
    },
    dryRun: false,
    retryDelayMs: 0,
  };
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** The doc's text with its wrapping gone, since a line break can fall anywhere. */
const docText = async (path: string) =>
  (await readFile(new URL(path, import.meta.url), "utf8")).replace(/\s+/gu, "");

describe("what the operations doc tells a client", () => {
  it("is what this client does with a locked document: rejected on the receipt, retried under the same key on a rerun", async () => {
    const context = await fixture();
    const keys: unknown[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      keys.push(
        (JSON.parse(String(init?.body)) as { idempotencyKey: unknown })
          .idempotencyKey,
      );
      return keys.length === 1
        ? new Response(
            JSON.stringify({
              ok: false,
              error: { code: "DOCUMENT_LOCKED", fields: [] },
            }),
            { status: 423 },
          )
        : new Response(
            JSON.stringify({ ok: true, result: { id: 7, revision: 2 } }),
          );
    });
    const transport = createTransport(
      {
        baseURL: "https://cms.example.invalid",
        apiKey: ["synthetic", "locked", "batch"].join("-"),
      },
      fetchImpl,
    );
    expect(await runBatch({ ...context, transport })).toMatchObject({
      succeeded: 0,
      failed: 1,
    });
    // One attempt only: a retryable failure would have been tried again here.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const receipt = await readFile(context.receiptFile, "utf8");
    expect(receipt).toContain('"code":"REQUEST_REJECTED"');
    expect(receipt).toContain('"retryable":false');
    expect(await runBatch({ ...context, transport })).toMatchObject({
      succeeded: 1,
      failed: 0,
    });
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(await docText("../../docs/cms/operations.md")).toContain(
      "`batch.mjs`把`DOCUMENT_LOCKED`记为`REQUEST_REJECTED`、`retryable:false`；用同一receipt重跑时，会用同一key重试它。",
    );
  });

  it("is that approve-batch and restore-draft take no key, and the limit that leaves is recorded", async () => {
    const approve = {
      automationUserId: 1,
      items: [{ id: 1, revision: 1 }],
    };
    const restore = { versionId: 1, expectedRevision: 1 };
    const idempotencyKey = "synthetic-key";
    expect(editorialApproveBatchSchema.safeParse(approve).success).toBe(true);
    expect(
      editorialApproveBatchSchema.safeParse({ ...approve, idempotencyKey })
        .success,
    ).toBe(false);
    expect(editorialRestoreDraftSchema.safeParse(restore).success).toBe(true);
    expect(
      editorialRestoreDraftSchema.safeParse({ ...restore, idempotencyKey })
        .success,
    ).toBe(false);
    expect(await docText("../../docs/cms/operations.md")).toContain(
      "`approve-batch`、`approve-article-batch`和`restore-draft`没有`idempotencyKey`",
    );
    const design = await docText(
      "../../docs/development/admin-mcp-completion-v1.md",
    );
    expect(design.slice(design.indexOf("Acceptedlimits,recorded"))).toContain(
      "AretryafterOUTCOME_UNKNOWNonapprove-batchcanleaveasecondactiveapproval",
    );
    expect(design).toContain(
      "sorevokingthatoneleavesthefirstactive,andautomationcanstillpublishwithit",
    );
  });
});

describe("deterministic editorial batch", () => {
  it("dry-run transfers no content and writes no receipt", async () => {
    const context = await fixture();
    const transport = vi.fn();
    expect(
      await runBatch({ ...context, dryRun: true, transport }),
    ).toMatchObject({ dryRun: true, total: 1, pending: 1 });
    expect(transport).not.toHaveBeenCalled();
    await expect(stat(context.receiptFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reads approved original text directly and preserves the idempotency key across retries", async () => {
    const original = "虛構原文\n甲　乙\u200b丙\n〔缺一字〕😀";
    const context = await fixture([
      { key: "one", contentFile: "approved.json" },
    ]);
    await writeFile(
      join(context.directory, "approved.json"),
      JSON.stringify({
        catalogId: "catalog-one",
        sourceId: "source-one",
        transcription: original,
      }),
    );
    const keys: unknown[] = [];
    const transport = vi.fn(async (_operation, item: Prepared) => {
      keys.push(item.body.idempotencyKey);
      expect(item.body.content).toMatchObject({ transcription: original });
      return keys.length === 1
        ? { ok: false, retryable: true, code: "TRANSPORT_UNCERTAIN" }
        : { ok: true, result: { id: 7, revision: 1 } };
    });
    expect(await runBatch({ ...context, transport })).toMatchObject({
      succeeded: 1,
      failed: 0,
    });
    expect(keys[0]).toBe(keys[1]);
    expect((await stat(context.receiptFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(context.receiptFile, "utf8")).not.toContain(original);
    transport.mockClear();
    expect(await runBatch({ ...context, transport })).toMatchObject({
      succeeded: 1,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("continues independent items and resumes only failed requests", async () => {
    const context = await fixture(
      ["one", "two", "three"].map((key) => ({
        key,
        content: {
          catalogId: `catalog-${key}`,
          sourceId: `source-${key}`,
          kind: "inscription",
        },
      })),
    );
    const transport = vi.fn(async (_operation, item: Prepared) =>
      item.key === "two"
        ? { ok: false, retryable: false, code: "CONFLICT" }
        : { ok: true, result: { id: item.key, revision: 1 } },
    );
    expect(await runBatch({ ...context, transport })).toMatchObject({
      succeeded: 2,
      failed: 1,
    });
    transport.mockImplementation(async () => ({
      ok: true,
      result: { id: "two", revision: 2 },
    }));
    transport.mockClear();
    expect(await runBatch({ ...context, transport })).toMatchObject({
      succeeded: 3,
      failed: 0,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[1].key).toBe("two");
  });

  it("rejects source changes under a receipt and duplicate batch keys before writing", async () => {
    const context = await fixture();
    const transport = vi.fn(async () => ({
      ok: true,
      result: { id: 7, revision: 1 },
    }));
    await runBatch({ ...context, transport });
    context.manifest.items[0]!.content = {
      catalogId: "catalog-one",
      title: "Changed",
    };
    await expect(runBatch({ ...context, transport })).rejects.toMatchObject({
      code: "RECEIPT_INPUT_CHANGED",
    });
    context.manifest.items.push(context.manifest.items[0]!);
    await expect(runBatch({ ...context, transport })).rejects.toMatchObject({
      code: "ITEM_IDENTITY_INVALID",
    });
  });

  it("stops bounded retries and leaves unstarted records pending when budget expires", async () => {
    const context = await fixture(
      ["one", "two", "three"].map((key) => ({
        key,
        content: { catalogId: `catalog-${key}` },
      })),
    );
    // The injected clock, not the runner's speed, decides when the budget
    // expires: receipt and lock setup take no clock time, and the first request
    // alone outlasts the budget. The real in-flight abort timer stays far
    // beyond the test's own runtime.
    const budgetMs = 120_000;
    let clock = 0;
    const transport = vi.fn(async () => {
      clock += budgetMs + 20;
      return { ok: false, retryable: true, code: "SERVER_RETRYABLE" };
    });
    expect(
      await runBatch({
        ...context,
        transport,
        concurrency: 1,
        budgetMs,
        attempts: 5,
        now: () => clock,
      }),
    ).toMatchObject({ failed: 1, pending: 2 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("resumes a journal with an interrupted final append without replaying completed records", async () => {
    const context = await fixture();
    const transport = vi.fn(async () => ({
      ok: true,
      result: { id: 7, revision: 1 },
    }));
    await runBatch({ ...context, transport });
    await appendFile(context.receiptFile, '{"key":"interrupted');
    transport.mockClear();
    expect(await runBatch({ ...context, transport })).toMatchObject({
      succeeded: 1,
    });
    expect(transport).not.toHaveBeenCalled();
    expect(await readFile(context.receiptFile, "utf8")).not.toContain(
      "interrupted",
    );
  });

  it("cancels an in-flight batch, releases its lock and resumes the same pending identity", async () => {
    const context = await fixture();
    const controller = new AbortController();
    let originalKey: unknown;
    const interrupted = vi.fn(async (_operation: string, item: Prepared) => {
      originalKey = item.body.idempotencyKey;
      const lock = JSON.parse(
        await readFile(`${context.receiptFile}.lock`, "utf8"),
      );
      expect(lock.pid).toBe(process.pid);
      expect((await stat(`${context.receiptFile}.lock`)).mode & 0o777).toBe(
        0o600,
      );
      controller.abort();
      return { ok: false, retryable: true, code: "TRANSPORT_UNCERTAIN" };
    });
    expect(
      await runBatch({
        ...context,
        transport: interrupted,
        signal: controller.signal,
      }),
    ).toMatchObject({ succeeded: 0, failed: 0, pending: 1 });
    expect(interrupted).toHaveBeenCalledTimes(1);
    await expect(stat(`${context.receiptFile}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await runBatch({
        ...context,
        transport: async (_operation, item) => {
          expect(item.body.idempotencyKey).toBe(originalKey);
          return { ok: true, result: { id: 7, revision: 1 } };
        },
      }),
    ).toMatchObject({ succeeded: 1, pending: 0 });
  });

  it("retains durable pending identity after an actual process kill and requires explicit stale-lock recovery", async () => {
    const context = await fixture();
    const childFile = join(context.directory, "synthetic-worker.mjs");
    const readyFile = join(context.directory, "ready.json");
    const moduleURL = new URL(
      "../../scripts/editorial/batch.mjs",
      import.meta.url,
    ).href;
    await writeFile(
      childFile,
      `
      import { runBatch } from ${JSON.stringify(moduleURL)};
      import { writeFile } from 'node:fs/promises';
      setInterval(() => {}, 1000);
      await runBatch({ ...${JSON.stringify(context)}, transport: async (_operation, item) => {
        await writeFile(${JSON.stringify(readyFile)}, JSON.stringify({ key: item.body.idempotencyKey }), { mode: 0o600 });
        await new Promise(() => {});
      }});
    `,
      { mode: 0o600 },
    );
    const child = spawn(process.execPath, [childFile], { stdio: "ignore" });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", () =>
        reject(new Error("Synthetic worker could not start")),
      );
    });
    try {
      let ready: { key: string } | undefined;
      for (let attempt = 0; attempt < 300 && !ready; attempt += 1) {
        try {
          ready = JSON.parse(await readFile(readyFile, "utf8"));
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(ready?.key).toBeTypeOf("string");
      child.kill("SIGKILL");
      await exited;
      const transport = vi.fn(async (_operation: string, item: Prepared) => {
        expect(item.body.idempotencyKey).toBe(ready?.key);
        return { ok: true, result: { id: 7, revision: 1 } };
      });
      await expect(runBatch({ ...context, transport })).rejects.toMatchObject({
        code: "RECEIPT_LOCKED",
      });
      expect(transport).not.toHaveBeenCalled();
      expect((await stat(context.receiptFile)).mode & 0o777).toBe(0o600);
      // The test has positively observed this worker's exit before recovery.
      await rm(`${context.receiptFile}.lock`);
      expect(await runBatch({ ...context, transport })).toMatchObject({
        succeeded: 1,
        pending: 0,
      });
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
    }
  });

  it("binds receipts to the configured target and identity", async () => {
    const context = await fixture();
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ ok: true, result: { id: 7, revision: 1 } }),
        ),
    );
    const transport = createTransport(
      {
        baseURL: "https://cms.example.invalid",
        apiKey: "synthetic-secondary-batch-key",
      },
      fetchImpl,
    );
    await runBatch({ ...context, transport });
    const different = createTransport(
      {
        baseURL: "https://other-cms.example.invalid",
        apiKey: "synthetic-secondary-batch-key",
      },
      fetchImpl,
    );
    await expect(
      runBatch({ ...context, transport: different }),
    ).rejects.toMatchObject({ code: "RECEIPT_SCOPE_MISMATCH" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not interpret source paths as retrieval URLs", async () => {
    const context = await fixture([
      { key: "one", contentFile: "https://example.invalid/source.json" },
    ]);
    await expect(
      prepareItems(context.manifest, context.directory),
    ).rejects.toMatchObject({ code: "LOCAL_FILE_REQUIRED" });
  });

  it("uses only the configured origin, rejects redirects, and sanitizes remote errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(
        "https://cms.example.invalid/api/editorial/save-draft",
      );
      expect(init?.redirect).toBe("error");
      return new Response(
        JSON.stringify({ error: "Untrusted server detail", ok: false }),
        { status: 503 },
      );
    });
    const transport = createTransport(
      {
        baseURL: "https://cms.example.invalid",
        apiKey: "synthetic-secondary-batch-key",
      },
      fetchImpl,
    );
    expect(
      await transport("save-draft", {
        key: "one",
        requestHash: "unused",
        body: {},
      }),
    ).toEqual({ ok: false, retryable: true, code: "SERVER_RETRYABLE" });
    expect(() =>
      createTransport({
        baseURL: "https://cms.example.invalid/?redirect=1",
        apiKey: "synthetic-secondary-batch-key",
      }),
    ).toThrow("CONFIG_ENDPOINT_INVALID");
  });

  it("reconciles media after a lost upload reply and verifies original bytes on replay", async () => {
    const context = await fixture();
    const bytes = Buffer.from("explicitly fictional test image bytes");
    await writeFile(join(context.directory, "image.bin"), bytes);
    context.manifest.operation = "upload-media";
    context.manifest.items = [
      {
        key: "image-one",
        file: "image.bin",
        mimeType: "image/png",
        metadata: {
          mediaId: "media-one",
          catalogId: "catalog-one",
          alt: "Fictional test",
        },
      },
    ];
    const [item] = await prepareItems(context.manifest, context.directory);
    let created = false;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "GET")
        return new Response(
          JSON.stringify({
            docs: created
              ? [
                  {
                    id: 10,
                    mediaId: "media-one",
                    alt: "Fictional test",
                    catalogId: "catalog-one",
                    sha256: item!.file!.sha256,
                  },
                ]
              : [],
          }),
        );
      expect(init?.body).toBeInstanceOf(FormData);
      const upload = (init!.body as FormData).get("file") as File;
      expect(Buffer.from(await upload.arrayBuffer())).toEqual(bytes);
      expect(upload.name).toMatch(/^[a-f0-9]{64}\.png$/);
      created = true;
      throw new Error("Fictional connection interruption");
    });
    const transport = createTransport(
      {
        baseURL: "https://cms.example.invalid",
        apiKey: "synthetic-secondary-batch-key",
      },
      fetchImpl,
    );
    expect(await runBatch({ ...context, transport })).toMatchObject({
      succeeded: 1,
    });
    expect(
      fetchImpl.mock.calls.filter((call) => call[1]?.method === "POST"),
    ).toHaveLength(1);
  });
});
