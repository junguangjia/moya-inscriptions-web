import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const supportRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(supportRoot, "../../..");
const sourceWebRoot = join(repositoryRoot, "apps/web");
// Playwright validates these test-only ports before launching either service.
const webPort = process.env.MOYA_E2E_WEB_PORT ?? "3100";

const typescriptCli = join(repositoryRoot, "node_modules/typescript/bin/tsc");
for (const [name, configuration] of [
  ["@moya/contracts", "packages/contracts/tsconfig.json"],
  ["@moya/design-tokens", "packages/design-tokens/tsconfig.json"],
  ["@moya/ui", "packages/ui/tsconfig.json"],
] as const) {
  const build = spawnSync(
    process.execPath,
    [typescriptCli, "-p", join(repositoryRoot, configuration)],
    { cwd: repositoryRoot, env: process.env, stdio: "inherit" },
  );
  if (build.error) throw build.error;
  if (build.status !== 0) {
    throw new Error(
      `Failed to build ${name} for Formal Web E2E (exit ${build.status ?? "unknown"}).`,
    );
  }
}

const temporaryRepositoryRoot = mkdtempSync(
  join(tmpdir(), "moya-t02p01-formal-web-"),
);
const temporaryWebRoot = join(temporaryRepositoryRoot, "apps/web");

const excludedWebEntries = new Set([
  ".next",
  ".turbo",
  "AGENTS.md",
  "CLAUDE.md",
  "node_modules",
  "tsconfig.tsbuildinfo",
]);

const cleanup = () => {
  rmSync(temporaryRepositoryRoot, { force: true, recursive: true });
};

try {
  mkdirSync(join(temporaryRepositoryRoot, "apps"), { recursive: true });
  cpSync(
    join(repositoryRoot, "tsconfig.base.json"),
    join(temporaryRepositoryRoot, "tsconfig.base.json"),
  );
  cpSync(sourceWebRoot, temporaryWebRoot, {
    filter: (source) => {
      const pathFromWebRoot = relative(sourceWebRoot, source);
      const topLevelEntry = pathFromWebRoot.split(sep)[0] ?? "";
      return !excludedWebEntries.has(topLevelEntry);
    },
    recursive: true,
  });
  // Only the disposable E2E copy disables the dev badge: its bottom-left
  // portal covers the accepted mobile Search submit button. Error overlays
  // remain enabled, and interaction tests continue using normal pointer clicks.
  const nextConfigPath = join(temporaryWebRoot, "next.config.ts");
  const nextConfig = readFileSync(nextConfigPath, "utf8");
  const exportStatement = "export default nextConfig;";
  if (nextConfig.split(exportStatement).length !== 2) {
    throw new Error("Unexpected disposable Next configuration export");
  }
  writeFileSync(
    nextConfigPath,
    nextConfig.replace(
      exportStatement,
      "export default { ...nextConfig, devIndicators: false } satisfies NextConfig;",
    ),
  );
  symlinkSync(
    join(repositoryRoot, "docs"),
    join(temporaryRepositoryRoot, "docs"),
    "dir",
  );
  symlinkSync(
    join(repositoryRoot, "packages"),
    join(temporaryRepositoryRoot, "packages"),
    "dir",
  );
  symlinkSync(
    join(sourceWebRoot, "node_modules"),
    join(temporaryWebRoot, "node_modules"),
    "dir",
  );
} catch (error) {
  cleanup();
  throw error;
}

const nextCli = join(sourceWebRoot, "node_modules/next/dist/bin/next");
const nextProcess = spawn(
  process.execPath,
  [
    nextCli,
    "dev",
    "--webpack",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(webPort),
  ],
  {
    cwd: temporaryWebRoot,
    env: process.env,
    stdio: "inherit",
  },
);

let shuttingDown = false;

const stop = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  nextProcess.kill(signal);
};

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

nextProcess.on("error", (error) => {
  cleanup();
  throw error;
});

nextProcess.on("exit", (code) => {
  cleanup();
  process.exit(code ?? (shuttingDown ? 0 : 1));
});
