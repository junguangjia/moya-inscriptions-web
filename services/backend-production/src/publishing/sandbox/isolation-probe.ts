import { randomBytes } from "node:crypto";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";

import { SANDBOX_ALLOWED_ENVIRONMENT_KEYS } from "./protocol.js";
import { SANDBOX_LIMITS } from "../processing/profiles.js";

import type { SandboxIsolationFacts } from "./protocol.js";

/*
 * The in-container isolation probe of the worker's startup self-check. It
 * reads the effective identity, network, mount, environment and cgroup state
 * of the sandbox process and reports content-free facts; the coordinator
 * compares them with the expected constants and refuses to start on any
 * difference. Nothing here reads input bytes or reaches the network beyond
 * one connection attempt to a reserved documentation address (RFC 5737).
 */

export interface IsolationProbePaths {
  readonly root: string;
  readonly app: string;
  readonly input: string;
  readonly tmp: string;
  readonly work: string;
  readonly output: string;
}

const UNREACHABLE_ADDRESS = "192.0.2.1";
const CONNECT_TIMEOUT_MS = 1500;
const MAX_VISIBLE_PROCESSES = 8;

const readText = async (file: string): Promise<string | null> => {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
};

const statusField = (status: string, name: string): string | null => {
  const line = status.split("\n").find((entry) => entry.startsWith(`${name}:`));
  return line === undefined ? null : line.slice(name.length + 1).trim();
};

const firstNumber = (value: string | null): number | null => {
  const match = value === null ? null : /^-?\d+/.exec(value);
  return match ? Number(match[0]) : null;
};

/** Soft value of one `/proc/self/limits` row, e.g. `0` or `1024`. */
const softLimit = (limits: string, label: string): string | null => {
  const line = limits.split("\n").find((entry) => entry.startsWith(label));
  if (line === undefined) return null;
  const value = line.slice(label.length).trim().split(/\s+/)[0];
  return value === undefined || value === "" ? null : value;
};

const cgroupValue = async (name: string): Promise<string | null> => {
  const value = await readText(path.join("/sys/fs/cgroup", name));
  if (value === null) return null;
  const trimmed = value.trim();
  return /^[0-9a-z ]{1,32}$/.test(trimmed) ? trimmed : null;
};

/** True when creating a file in `directory` succeeds (it is then removed). */
const canWrite = async (directory: string): Promise<boolean> => {
  const target = path.join(
    directory,
    `.probe-${randomBytes(8).toString("hex")}`,
  );
  try {
    await writeFile(target, "", { flag: "wx", mode: 0o600 });
  } catch {
    return false;
  }
  await unlink(target).catch(() => undefined);
  return true;
};

const tcpConnect = (): Promise<string> =>
  new Promise((resolve) => {
    const socket = connect({ host: UNREACHABLE_ADDRESS, port: 80 });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("timeout");
    }, CONNECT_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(
        typeof error.code === "string" && /^[A-Za-z_]{1,32}$/.test(error.code)
          ? error.code
          : "error",
      );
    });
  });

const INTERFACE_NAME = /^[A-Za-z0-9_.@-]{1,32}$/;
/** `IFF_UP` in `/sys/class/net/<name>/flags`. */
const IFF_UP = 0x1;

/**
 * Network interfaces that are up. A namespace without network still lists
 * the kernel's fallback tunnel devices (down, unroutable); only `lo` may be
 * up. Without sysfs every listed interface counts as up (fail closed).
 */
const upInterfaces = async (devices: string): Promise<string[]> => {
  const listed = devices
    .split("\n")
    .slice(2)
    .map((line) => line.split(":")[0]?.trim() ?? "")
    .filter((name) => INTERFACE_NAME.test(name));
  const up: string[] = [];
  for (const name of listed) {
    const flags = await readText(path.join("/sys/class/net", name, "flags"));
    const value =
      flags === null ? Number.NaN : Number.parseInt(flags.trim(), 16);
    if (!Number.isFinite(value) || (value & IFF_UP) !== 0) up.push(name);
  }
  return up.sort();
};

/**
 * Keys of the environment the process was started with (`/proc/self/environ`,
 * unaffected by later in-process changes such as libvips' own `VIPSHOME`).
 */
const initialEnvironmentKeys = async (): Promise<string[]> => {
  const raw = await readFile("/proc/self/environ").catch(() => null);
  const keys =
    raw === null
      ? Object.keys(process.env)
      : raw
          .toString("latin1")
          .split("\0")
          .filter((entry) => entry !== "")
          .map((entry) => entry.split("=")[0] ?? "");
  return [...new Set(keys)]
    .filter((key) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key))
    .sort();
};

/** Collects the isolation facts of the current (sandbox) process. */
export async function probeIsolation(
  paths: IsolationProbePaths,
  loaderAllowlist: boolean,
): Promise<SandboxIsolationFacts> {
  const status = (await readText("/proc/self/status")) ?? "";
  const ids = (name: string) =>
    firstNumber(statusField(status, name)?.split(/\s+/)[1] ?? null) ?? -1;
  const devices = (await readText("/proc/net/dev")) ?? "";
  const routes = (await readText("/proc/net/route")) ?? "";
  const limits = (await readText("/proc/self/limits")) ?? "";
  const processes = await readdir("/proc").catch(() => [] as string[]);
  return {
    uid: Math.max(0, ids("Uid")),
    gid: Math.max(0, ids("Gid")),
    noNewPrivileges: statusField(status, "NoNewPrivs") === "1",
    effectiveCapabilities: (statusField(status, "CapEff") ?? "ffffffffffffffff")
      .toLowerCase()
      .replace(/^0+(?=.)/, ""),
    seccomp: Math.min(
      2,
      Math.max(0, firstNumber(statusField(status, "Seccomp")) ?? 0),
    ),
    networkInterfaces: await upInterfaces(devices),
    routes: routes
      .split("\n")
      .slice(1)
      .filter((line) => line.trim() !== "").length,
    tcpConnect: await tcpConnect(),
    readOnly: {
      root: !(await canWrite(paths.root)),
      app: !(await canWrite(paths.app)),
      input: !(await canWrite(paths.input)),
    },
    writable: {
      tmp: await canWrite(paths.tmp),
      work: await canWrite(paths.work),
      output: await canWrite(paths.output),
    },
    environmentKeys: await initialEnvironmentKeys(),
    memoryMax: await cgroupValue("memory.max"),
    swapMax: await cgroupValue("memory.swap.max"),
    pidsMax: await cgroupValue("pids.max"),
    cpuMax: await cgroupValue("cpu.max"),
    oomScoreAdj: firstNumber(await readText("/proc/self/oom_score_adj")),
    coreLimit: softLimit(limits, "Max core file size"),
    openFilesLimit: softLimit(limits, "Max open files"),
    visibleProcesses: processes.filter((name) => /^\d+$/.test(name)).length,
    loaderAllowlist,
  };
}

const megabytes = (value: string) =>
  Number(value.replace(/m$/, "")) * 1024 * 1024;

/** The facts every sandbox container must report (W8, W11). */
export const EXPECTED_ISOLATION = {
  uid: 10001,
  gid: 10001,
  memoryMax: String(megabytes(SANDBOX_LIMITS.memory)),
  swapMax: "0",
  pidsMax: SANDBOX_LIMITS.pidsLimit,
  cpuMax: `${Number(SANDBOX_LIMITS.cpus) * 100_000} 100000`,
  oomScoreAdj: Number(SANDBOX_LIMITS.oomScoreAdj),
  coreLimit: "0",
  openFilesLimit: "1024",
} as const;

/**
 * Names of the facts that differ from the expected isolation (empty when the
 * sandbox is isolated as configured). Content-free.
 */
export function isolationMismatches(facts: SandboxIsolationFacts): string[] {
  const mismatches: string[] = [];
  const expect = (name: string, ok: boolean) => {
    if (!ok) mismatches.push(name);
  };
  expect("uid", facts.uid === EXPECTED_ISOLATION.uid);
  expect("gid", facts.gid === EXPECTED_ISOLATION.gid);
  expect("noNewPrivileges", facts.noNewPrivileges);
  expect("effectiveCapabilities", /^0+$/.test(facts.effectiveCapabilities));
  expect("seccomp", facts.seccomp === 2);
  expect(
    "networkInterfaces",
    facts.networkInterfaces.length === 1 && facts.networkInterfaces[0] === "lo",
  );
  expect("routes", facts.routes === 0);
  expect(
    "tcpConnect",
    facts.tcpConnect !== "connected" && facts.tcpConnect !== "timeout",
  );
  expect("readOnly.root", facts.readOnly.root);
  expect("readOnly.app", facts.readOnly.app);
  expect("readOnly.input", facts.readOnly.input);
  expect("writable.tmp", facts.writable.tmp);
  expect("writable.work", facts.writable.work);
  expect("writable.output", facts.writable.output);
  expect(
    "environmentKeys",
    facts.environmentKeys.every((key) =>
      SANDBOX_ALLOWED_ENVIRONMENT_KEYS.includes(key),
    ),
  );
  expect("memoryMax", facts.memoryMax === EXPECTED_ISOLATION.memoryMax);
  expect("swapMax", facts.swapMax === EXPECTED_ISOLATION.swapMax);
  expect("pidsMax", facts.pidsMax === EXPECTED_ISOLATION.pidsMax);
  expect("cpuMax", facts.cpuMax === EXPECTED_ISOLATION.cpuMax);
  expect("oomScoreAdj", facts.oomScoreAdj === EXPECTED_ISOLATION.oomScoreAdj);
  expect("coreLimit", facts.coreLimit === EXPECTED_ISOLATION.coreLimit);
  expect(
    "openFilesLimit",
    facts.openFilesLimit === EXPECTED_ISOLATION.openFilesLimit,
  );
  expect(
    "visibleProcesses",
    facts.visibleProcesses >= 1 &&
      facts.visibleProcesses <= MAX_VISIBLE_PROCESSES,
  );
  expect("loaderAllowlist", facts.loaderAllowlist);
  return mismatches;
}
