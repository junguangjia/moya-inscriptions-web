import type { z } from "zod";

/**
 * A Backend answer on the AI path, read tolerantly (extensibility plan 2.4). The Admin
 * and the Backend ship apart, so a field the Backend adds first must change nothing
 * here: a key the strict schema names nowhere is dropped, never passed on, and the same
 * strict schema then reads the rest. A field AI may not read therefore never reaches it.
 * Anything else wrong is a real mismatch, and the caller answers it by name. The
 * Backend's own tests keep producing these answers against the strict schema.
 */

/** The code of a real mismatch: retrying reads the same answer. */
export const BACKEND_CONTRACT_MISMATCH = "BACKEND_CONTRACT_MISMATCH";

interface UnknownKeys {
  readonly path: readonly PropertyKey[];
  readonly keys: readonly string[];
}

const droppedCount = (found: readonly UnknownKeys[]) =>
  found.reduce((sum, { keys }) => sum + keys.length, 0);

const startsWith = (
  path: readonly PropertyKey[],
  prefix: readonly PropertyKey[],
) =>
  prefix.length <= path.length &&
  prefix.every((part, index) => part === path[index]);

/**
 * Whether a branch's issues show it does not name `key` at `at`: it found that key, or
 * one on the way there, unknown, or it holds no object there at all. A branch whose
 * issues show neither is taken to name it.
 */
const leaves = (
  issues: readonly z.core.$ZodIssue[],
  base: readonly PropertyKey[],
  at: readonly PropertyKey[],
  key: string,
): boolean =>
  issues.some((issue) => {
    const path = [...base, ...issue.path];
    if (!startsWith(at, path)) return false;
    if (issue.code === "unrecognized_keys")
      return issue.keys.includes(
        path.length === at.length ? key : String(at[path.length]),
      );
    if (issue.code === "invalid_type") return true;
    return (
      issue.code === "invalid_union" &&
      issue.errors.length > 0 &&
      issue.errors.every((branch) => leaves(branch, path, at, key))
    );
  });

/**
 * Where the unknown keys sit, when they are all that is wrong. In a union no branch
 * passed, and only a key that no branch names may go: one that a branch names, such
 * as a withheld mark, is never dropped to read another branch. Of the branches that
 * pass that way, the one read drops the fewest keys, the first on a tie, so a smaller
 * branch is never read into a larger answer.
 */
const unknownKeysOf = (
  issues: readonly z.core.$ZodIssue[],
  base: readonly PropertyKey[],
): readonly UnknownKeys[] | undefined => {
  const found: UnknownKeys[] = [];
  for (const issue of issues) {
    const path = [...base, ...issue.path];
    if (issue.code === "unrecognized_keys")
      found.push({ path, keys: issue.keys });
    else if (issue.code === "invalid_union") {
      const namedByNone = ({ path: at, keys }: UnknownKeys) =>
        keys.every((key) =>
          issue.errors.every((branch) => leaves(branch, path, at, key)),
        );
      const branches = issue.errors
        .map((branch) => unknownKeysOf(branch, path))
        .filter(
          (branch): branch is readonly UnknownKeys[] =>
            branch !== undefined && branch.every(namedByNone),
        );
      const fewest = branches.reduce<readonly UnknownKeys[] | undefined>(
        (best, branch) =>
          best === undefined || droppedCount(branch) < droppedCount(best)
            ? branch
            : best,
        undefined,
      );
      if (fewest === undefined) return undefined;
      found.push(...fewest);
    } else return undefined;
  }
  return found;
};

const withoutKeys = (
  value: unknown,
  found: readonly UnknownKeys[],
): unknown => {
  const copy: unknown = structuredClone(value);
  for (const { path, keys } of found) {
    const holder = path.reduce<unknown>(
      (at, part) => (at as Record<PropertyKey, unknown>)[part],
      copy,
    ) as Record<string, unknown>;
    for (const key of keys) delete holder[key];
  }
  return copy;
};

/**
 * `kept` is the answer as sent, less the keys dropped; `data` is what the schema reads of
 * it. Undefined is a real mismatch.
 */
export const readBackendAnswer = <Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): { readonly kept: unknown; readonly data: z.output<Schema> } | undefined => {
  const first = schema.safeParse(value);
  if (first.success) return { kept: value, data: first.data };
  const found = unknownKeysOf(first.error.issues, []);
  if (found === undefined) return undefined;
  const kept = withoutKeys(value, found);
  const second = schema.safeParse(kept);
  return second.success ? { kept, data: second.data } : undefined;
};
