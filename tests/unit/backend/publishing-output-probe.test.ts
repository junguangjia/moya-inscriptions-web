import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Output probing after a sandbox run. A host read fault on a received file is
 * the coordinator's infrastructure and must be retried; output the probe
 * refuses stays a permanent protocol violation. The read fault is injected
 * for one sentinel file name only.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args);
    if (!String(args[0]).endsWith("host-fault.webp")) return handle;
    return new Proxy(handle, {
      get(target, property) {
        if (property === "read")
          return async () => {
            throw Object.assign(new Error("synthetic read fault"), {
              code: "EIO",
            });
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return { ...actual, open, default: { ...actual, open } };
});

const { probeSandboxOutputs } =
  await import("@moya/backend-production/internal/publishing-processing");
const { SandboxProtocolError } =
  await import("@moya/backend-production/internal/publishing-sandbox");

type ProbeInput = Parameters<typeof probeSandboxOutputs>[0];

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "output-probe-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const resultFor = async (name: string, bytes: Buffer): Promise<ProbeInput> => {
  const filePath = path.join(directory, name);
  await writeFile(filePath, bytes, { mode: 0o600 });
  return {
    manifest: {
      outputs: [
        {
          name,
          bytes: bytes.byteLength,
          contentType: "image/webp",
          width: 4,
          height: 4,
        },
      ],
    },
    files: new Map([
      [name, { path: filePath, bytes: bytes.byteLength, sha256: "0" }],
    ]),
  } as unknown as ProbeInput;
};

describe("sandbox output probe", () => {
  it("retries a host read fault on a received output", async () => {
    await expect(
      probeSandboxOutputs(
        await resultFor("host-fault.webp", Buffer.alloc(64, 1)),
      ),
    ).rejects.toMatchObject({
      name: "MediaProcessingUnavailableError",
      systemCode: "EIO",
    });
  });

  it("keeps refusing output that is not what the manifest declared", async () => {
    const refused = await probeSandboxOutputs(
      await resultFor("display.webp", Buffer.alloc(64, 1)),
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SandboxProtocolError);
    expect(refused).toMatchObject({ violation: "output_invalid" });
  });
});
