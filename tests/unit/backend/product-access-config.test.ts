import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  describeProductAccess,
  loadProductAccess,
} from "@moya/backend-production/internal/product-access";
import { afterEach, describe, expect, it, vi } from "vitest";

const tester = "user-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f01";
const other = "user-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f02";
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const allowlist = (accounts: readonly unknown[]) =>
  JSON.stringify({ version: 1, accounts });

/** Installs the file the way an operator does: complete, private, then renamed into place. */
const install = (file: string, text: string, mode = 0o600) => {
  const next = `${file}.next`;
  writeFileSync(next, text, { mode });
  chmodSync(next, mode);
  renameSync(next, file);
};

const workspace = (text = allowlist([{ id: tester, label: "owner" }])) => {
  const directory = mkdtempSync(path.join(tmpdir(), "product-access-"));
  directories.push(directory);
  const file = path.join(directory, "product-access.json");
  install(file, text);
  return {
    file,
    environment: {
      PRODUCT_ACCESS_MODE: "closed-beta",
      PRODUCT_ACCESS_ALLOWLIST_FILE: file,
    },
  };
};

describe("product access configuration", () => {
  it("requires Production to name its mode and never opens the product by default", () => {
    for (const value of [
      undefined,
      "",
      "open",
      "PUBLIC",
      "closed_beta",
      " public",
    ])
      expect(() =>
        loadProductAccess(
          value === undefined ? {} : { PRODUCT_ACCESS_MODE: value },
          "production",
        ),
      ).toThrow("PRODUCT_ACCESS_MODE: must be closed-beta or public");
    expect(
      describeProductAccess(
        loadProductAccess({ PRODUCT_ACCESS_MODE: "public" }, "production"),
      ),
    ).toEqual({ mode: "public" });
  });

  it("keeps a Development stack that does not opt in public", () => {
    const policy = loadProductAccess({}, "development");
    expect(policy.mode).toBe("public");
    expect(policy.admits(other)).toBe(true);
    expect(() =>
      loadProductAccess({ PRODUCT_ACCESS_MODE: "beta" }, "development"),
    ).toThrow("PRODUCT_ACCESS_MODE");
  });

  it("refuses a closed beta without a readable, private, valid allowlist", () => {
    for (const environment of [
      { PRODUCT_ACCESS_MODE: "closed-beta" },
      {
        PRODUCT_ACCESS_MODE: "closed-beta",
        PRODUCT_ACCESS_ALLOWLIST_FILE: "product-access.json",
      },
    ])
      expect(() => loadProductAccess(environment, "production")).toThrow(
        "PRODUCT_ACCESS_ALLOWLIST_FILE: an absolute path is required",
      );
    const invalid =
      "PRODUCT_ACCESS_ALLOWLIST_FILE: invalid protected allowlist";
    const missing = workspace();
    rmSync(missing.file);
    expect(() => loadProductAccess(missing.environment, "production")).toThrow(
      invalid,
    );
    for (const text of [
      "",
      "not json",
      "[]",
      JSON.stringify({ accounts: [] }),
      JSON.stringify({ version: 2, accounts: [] }),
      JSON.stringify({ version: 1, accounts: [], everyone: true }),
      allowlist([tester]),
      allowlist([{ id: "dev-user-01" }]),
      allowlist([{ id: tester.toUpperCase() }]),
      allowlist([{ id: tester }, { id: tester }]),
      allowlist([{ id: tester, handle: "owner" }]),
      allowlist([{ id: tester, label: "x".repeat(81) }]),
      allowlist(
        Array.from({ length: 501 }, (_, index) => ({
          id: `user-${index.toString(16).padStart(32, "0")}`,
        })),
      ),
    ])
      expect(() =>
        loadProductAccess(workspace(text).environment, "production"),
      ).toThrow(invalid);
    // Readable by another account, or reached through a link: not protected.
    const shared = workspace();
    chmodSync(shared.file, 0o640);
    expect(() => loadProductAccess(shared.environment, "production")).toThrow(
      invalid,
    );
    const linked = workspace();
    const link = `${linked.file}.link`;
    symlinkSync(linked.file, link);
    expect(() =>
      loadProductAccess(
        { ...linked.environment, PRODUCT_ACCESS_ALLOWLIST_FILE: link },
        "production",
      ),
    ).toThrow(invalid);
  });

  it("admits exactly the listed account ids; an empty list admits nobody", () => {
    const policy = loadProductAccess(workspace().environment, "production");
    expect(policy.mode).toBe("closed_beta");
    expect(policy.admits(tester)).toBe(true);
    expect(policy.admits(other)).toBe(false);
    expect(policy.admits("owner")).toBe(false);
    expect(describeProductAccess(policy)).toEqual({
      mode: "closed_beta",
      accounts: 1,
    });
    const empty = loadProductAccess(
      workspace(allowlist([])).environment,
      "production",
    );
    expect(empty.admits(tester)).toBe(false);
    expect(describeProductAccess(empty)).toEqual({
      mode: "closed_beta",
      accounts: 0,
    });
  });

  it("applies a changed allowlist without a restart and denies everyone while it is missing or invalid", () => {
    const { file, environment } = workspace();
    let now = 0;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const policy = loadProductAccess(environment, "production", {
      now: () => now,
      recheckMs: 1_000,
    });
    expect(policy.admits(tester)).toBe(true);

    install(file, allowlist([{ id: other }]));
    // Within the interval the previous answer stands; after it the file decides.
    now = 999;
    expect(policy.admits(tester)).toBe(true);
    now = 1_000;
    expect(policy.admits(tester)).toBe(false);
    expect(policy.admits(other)).toBe(true);

    install(file, "not json");
    now = 2_000;
    expect(policy.admits(other)).toBe(false);
    rmSync(file);
    now = 3_000;
    expect(policy.admits(other)).toBe(false);
    install(file, allowlist([{ id: tester }]), 0o644);
    now = 4_000;
    expect(policy.admits(tester)).toBe(false);

    install(file, allowlist([{ id: tester }]));
    now = 5_000;
    expect(policy.admits(tester)).toBe(true);
    // Reports carry counts and never an account id.
    const logged = [...info.mock.calls, ...error.mock.calls].flat().join("\n");
    expect(logged).toContain("reloaded (1 accounts)");
    expect(logged).toContain("every account is denied");
    expect(logged).not.toContain("user-");
  });

  it("validates a configuration or a candidate file from the command line without printing account ids", () => {
    const { file } = workspace(allowlist([{ id: tester }, { id: other }]));
    const check = fileURLToPath(
      new URL(
        "../../../services/backend-production/dist/access/check.js",
        import.meta.url,
      ),
    );
    const run = (
      args: readonly string[],
      env: Readonly<Record<string, string>> = {},
    ) =>
      execFileSync(process.execPath, [check, ...args], {
        env: { PATH: process.env.PATH, ...env, NODE_ENV: "production" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    expect(JSON.parse(run(["--file", file]))).toEqual({
      mode: "closed_beta",
      accounts: 2,
    });
    expect(JSON.parse(run(["--file", file, "--has", tester]))).toEqual({
      mode: "closed_beta",
      accounts: 2,
      admitted: true,
    });
    expect(
      JSON.parse(
        run([], {
          PRODUCT_ACCESS_MODE: "closed-beta",
          PRODUCT_ACCESS_ALLOWLIST_FILE: file,
        }),
      ),
    ).toEqual({ mode: "closed_beta", accounts: 2 });
    install(file, "not json");
    for (const args of [["--file", file], [], ["--unknown", "x"]])
      expect(() => run(args)).toThrow(/PRODUCT_ACCESS_REFUSED/u);
  });
});
