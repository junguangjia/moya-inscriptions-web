import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  SANDBOX_NODE_MAJOR,
  SANDBOX_SHARP_VERSION,
} from "@moya/backend-production/internal/publishing-processing";
import { describe, expect, it } from "vitest";

import { repositoryRoot } from "./workspace-scanner.js";

/*
 * The media sandbox image is reproducible from pinned inputs: digest-pinned
 * base images, a renderer runtime lockfile whose every integrity equals the
 * workspace pnpm-lock.yaml, and the sharp pin the worker's version handshake
 * requires (no dependency is upgraded by the image).
 */

const imageDirectory = path.join(
  repositoryRoot,
  "infra",
  "development",
  "work-publishing",
  "media-tools",
);

const pnpmIntegrity = (lock: string) => {
  const entries = new Map<string, string>();
  for (const match of lock.matchAll(
    /^ {2}'?(@?[^@\s']+(?:\/[^@\s']+)?)@([^:'(\s]+)'?:\n {4}resolution: \{integrity: ([^,}]+)/gmu,
  ))
    entries.set(`${match[1]}@${match[2]}`, match[3]!);
  return entries;
};

describe("media sandbox image", () => {
  it("pins every base image by digest and the Node runtime to 24.21.0", async () => {
    const dockerfile = await readFile(
      path.join(imageDirectory, "Dockerfile"),
      "utf8",
    );
    const nodeImage = /^ARG NODE_IMAGE=(\S+)$/mu.exec(dockerfile)?.[1];
    expect(nodeImage).toMatch(
      /^node:24\.21\.0-trixie-slim@sha256:[0-9a-f]{64}$/u,
    );
    expect(Number(nodeImage!.slice(5, 7))).toBe(SANDBOX_NODE_MAJOR);
    const froms = [...dockerfile.matchAll(/^FROM (\S+)/gmu)].map(
      (match) => match[1],
    );
    expect(froms).toEqual([
      "${NODE_IMAGE}",
      "debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132",
    ]);
    expect(dockerfile).toContain("npm ci --omit=dev --ignore-scripts");
    expect(dockerfile).toContain(
      `if(s.versions.sharp!=='${SANDBOX_SHARP_VERSION}')process.exit(1)`,
    );
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain('ENTRYPOINT ["/bin/false"]');
  });

  it("locks the renderer runtime to the workspace's own sharp packages", async () => {
    const runtime = JSON.parse(
      await readFile(
        path.join(imageDirectory, "runtime", "package.json"),
        "utf8",
      ),
    ) as { type?: string; dependencies?: Record<string, string> };
    expect(runtime.type).toBe("module");
    expect(runtime.dependencies).toEqual({ sharp: SANDBOX_SHARP_VERSION });
    const backend = JSON.parse(
      await readFile(
        path.join(
          repositoryRoot,
          "services",
          "backend-production",
          "package.json",
        ),
        "utf8",
      ),
    ) as { dependencies: Record<string, string> };
    expect(backend.dependencies.sharp).toBe(SANDBOX_SHARP_VERSION);
    const lock = JSON.parse(
      await readFile(
        path.join(imageDirectory, "runtime", "package-lock.json"),
        "utf8",
      ),
    ) as {
      lockfileVersion: number;
      packages: Record<string, { version?: string; integrity?: string }>;
    };
    expect(lock.lockfileVersion).toBe(3);
    const workspace = pnpmIntegrity(
      await readFile(path.join(repositoryRoot, "pnpm-lock.yaml"), "utf8"),
    );
    const locked = Object.entries(lock.packages).filter(([key]) => key !== "");
    expect(locked.length).toBeGreaterThan(8);
    for (const [key, entry] of locked) {
      const name = key.slice("node_modules/".length);
      expect(entry.integrity, name).toBe(
        workspace.get(`${name}@${entry.version}`),
      );
    }
    const versions = new Map(
      locked.map(([key, entry]) => [
        key.slice("node_modules/".length),
        entry.version,
      ]),
    );
    expect(versions.get("sharp")).toBe(SANDBOX_SHARP_VERSION);
    for (const platform of ["linux-x64", "linux-arm64"]) {
      expect(versions.get(`@img/sharp-${platform}`)).toBe(
        SANDBOX_SHARP_VERSION,
      );
      expect(versions.get(`@img/sharp-libvips-${platform}`)).toBe("1.3.3");
    }
  });
});
