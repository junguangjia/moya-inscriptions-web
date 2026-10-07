import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { isAbsolute } from "node:path";

import type { BackendApplicationOptions } from "@moya/backend-runtime";

type Environment = Readonly<Record<string, string | undefined>>;
export type ProductAccessPolicy = NonNullable<
  BackendApplicationOptions["productAccess"]
>;

const modeVariable = "PRODUCT_ACCESS_MODE";
const fileVariable = "PRODUCT_ACCESS_ALLOWLIST_FILE";
const maximumBytes = 65_536;
const maximumAccounts = 500;
const accountIdPattern = /^user-[0-9a-f]{32}$/u;
const defaultRecheckMs = 1_000;

const publicAccess: ProductAccessPolicy = Object.freeze({
  mode: "public",
  admits: () => true,
});

/**
 * The protected allowlist: `{"version":1,"accounts":[{"id":"user-…"}]}`. An
 * entry may carry an operator `label`; only the immutable account id decides.
 */
const parseAllowlist = (text: string): ReadonlySet<string> => {
  const document: unknown = JSON.parse(text);
  if (
    typeof document !== "object" ||
    document === null ||
    Array.isArray(document)
  )
    throw new Error();
  const { version, accounts, ...unknown } = document as Record<string, unknown>;
  if (
    version !== 1 ||
    !Array.isArray(accounts) ||
    accounts.length > maximumAccounts ||
    Object.keys(unknown).length > 0
  )
    throw new Error();
  const ids = new Set<string>();
  for (const entry of accounts) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new Error();
    const { id, label, ...rest } = entry as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      !accountIdPattern.test(id) ||
      ids.has(id) ||
      Object.keys(rest).length > 0 ||
      (label !== undefined &&
        (typeof label !== "string" || label.length < 1 || label.length > 80))
    )
      throw new Error();
    ids.add(id);
  }
  return ids;
};

/** Open the file once, without following a symlink or trusting a prior stat. */
const readAllowlist = (path: string): ReadonlySet<string> => {
  let file: number | undefined;
  try {
    file = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = fstatSync(file);
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      info.size < 1 ||
      info.size > maximumBytes
    )
      throw new Error();
    // Bound bytes even if the file grows after stat.
    const bytes = Buffer.alloc(maximumBytes + 1);
    let used = 0;
    while (used < bytes.length) {
      const read = readSync(file, bytes, used, bytes.length - used, null);
      if (read === 0) break;
      used += read;
    }
    if (used > maximumBytes) throw new Error();
    return parseAllowlist(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)),
    );
  } catch {
    throw new Error(`${fileVariable}: invalid protected allowlist`);
  } finally {
    if (file !== undefined) closeSync(file);
  }
};

/** Changes whenever the file is replaced, rewritten or has its mode changed. */
const fingerprint = (path: string): string => {
  const info = lstatSync(path, { throwIfNoEntry: false });
  return info === undefined
    ? "missing"
    : `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
};

export interface ProductAccessOptions {
  readonly now?: () => number;
  /** How often a request may look for a changed allowlist file. */
  readonly recheckMs?: number;
}

/**
 * Admits exactly the accounts in the allowlist file. The file is read again
 * when it changes, so adding or removing an account needs no restart; while
 * it is missing or invalid every account is denied.
 */
class ClosedBetaAccess implements ProductAccessPolicy {
  readonly mode = "closed_beta";
  private accounts: ReadonlySet<string>;
  private seen: string;
  private checkedAt: number;
  private readonly now: () => number;
  private readonly recheckMs: number;

  constructor(
    private readonly path: string,
    options: ProductAccessOptions,
  ) {
    // Monotonic by default: a wall clock that steps cannot postpone a look.
    this.now = options.now ?? (() => performance.now());
    this.recheckMs = options.recheckMs ?? defaultRecheckMs;
    // Startup refuses an allowlist it cannot read; nothing is admitted by default.
    this.seen = fingerprint(path);
    this.accounts = readAllowlist(path);
    this.checkedAt = this.now();
  }

  get size(): number {
    this.refresh();
    return this.accounts.size;
  }

  admits(userId: string): boolean {
    this.refresh();
    return this.accounts.has(userId);
  }

  private refresh(): void {
    const now = this.now();
    // A clock that went backwards is due at once, never "not yet".
    if (now >= this.checkedAt && now - this.checkedAt < this.recheckMs) return;
    this.checkedAt = now;
    let current: string;
    try {
      current = fingerprint(this.path);
    } catch {
      current = "unreadable";
    }
    if (current === this.seen) return;
    this.seen = current;
    try {
      this.accounts = readAllowlist(this.path);
      console.info(
        `[backend-production] product access allowlist reloaded (${this.accounts.size} accounts)`,
      );
    } catch {
      this.accounts = new Set();
      console.error(
        "[backend-production] product access allowlist is missing or invalid; every account is denied until it is corrected",
      );
    }
  }
}

/**
 * Validation only. Production must name its mode: a missing or unknown value
 * refuses startup instead of opening the product. Development defaults to
 * `public`, so stacks that do not opt in are unchanged.
 */
export const loadProductAccess = (
  environment: Environment,
  nodeEnv: "development" | "production",
  options: ProductAccessOptions = {},
): ProductAccessPolicy => {
  const mode = environment[modeVariable];
  if (mode === undefined || mode === "") {
    if (nodeEnv === "production")
      throw new Error(`${modeVariable}: must be closed-beta or public`);
    return publicAccess;
  }
  if (mode === "public") return publicAccess;
  if (mode !== "closed-beta")
    throw new Error(`${modeVariable}: must be closed-beta or public`);
  const path = environment[fileVariable];
  if (path === undefined || !isAbsolute(path) || path.includes("\0"))
    throw new Error(
      `${fileVariable}: an absolute path is required in closed-beta mode`,
    );
  return new ClosedBetaAccess(path, options);
};

/** Counts only: an account id never reaches a log or a report. */
export const describeProductAccess = (
  policy: ProductAccessPolicy,
): {
  readonly mode: ProductAccessPolicy["mode"];
  readonly accounts?: number;
} =>
  policy instanceof ClosedBetaAccess
    ? { mode: policy.mode, accounts: policy.size }
    : { mode: policy.mode };
