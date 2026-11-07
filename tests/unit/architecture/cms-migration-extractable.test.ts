import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ADMIN_RUN_REASON_MAX,
  ADMIN_RUN_STATES,
  ADMIN_RUN_TARGET_STATES,
} from "@moya/contracts/internal/admin-mcp";

import { repositoryRoot } from "./workspace-scanner.js";

// The release tool runs a CMS migration by taking its SQL out of the file, and records
// the Payload ledger row in the same transaction (admin-mcp-completion-v1 S8, R1-B). So
// from the run ledger on, a migration is plain SQL text that is exactly what runs:
// nothing interpolated, nothing raw, no escape that reads one way and runs another. And
// it only adds, until the release CI's own check of that is in place.

const MIGRATIONS = "apps/admin/src/migrations";
/** The first migration the release tool takes out itself; earlier ones went by hand. */
const FIRST_EXTRACTED = "20261106_103000_mcp_runs";

const source = (name: string) =>
  readFileSync(path.join(repositoryRoot, MIGRATIONS, `${name}.ts`), "utf8");
const extracted = readdirSync(path.join(repositoryRoot, MIGRATIONS))
  .filter((file) => /^\d{8}_\d{6}_\w+\.ts$/u.test(file))
  .map((file) => file.slice(0, -3))
  .filter((name) => name >= FIRST_EXTRACTED)
  .sort();

/** One exported function's body, as written. */
const bodyOf = (text: string, name: "up" | "down") =>
  new RegExp(
    `export async function ${name}\\([^)]*\\)[^{]*\\{\\n([\\s\\S]*?)\\n\\}`,
    "u",
  ).exec(text)?.[1];
/** The text of every sql`` template in a body. */
const templatesOf = (body: string) =>
  [...body.matchAll(/sql`([^`]*)`/gu)].map(([, text]) => text!);
/** A body of nothing but statements that each run one template. */
const onlyStatements = (body: string) =>
  /^(?:\s*await db\.execute\(sql``\);)+\s*$/u.test(
    body.replaceAll(/sql`[^`]*`/gu, "sql``"),
  );

describe("CMS migrations the release tool extracts", () => {
  it("start at the run ledger and are each listed, in order", () => {
    expect(extracted[0]).toBe(FIRST_EXTRACTED);
    const index = readFileSync(
      path.join(repositoryRoot, MIGRATIONS, "index.ts"),
      "utf8",
    );
    const positions = extracted.map((name) => index.indexOf(`name: "${name}"`));
    expect(positions.every((at) => at > 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it.each(extracted)(
    "%s is plain SQL in each function, exactly as it runs",
    async (name) => {
      const text = source(name);
      expect(text).not.toContain("sql.raw");
      expect(text).not.toContain("${");
      // No Payload snapshot: the tables are no collection's, as the precedent's.
      expect(
        existsSync(path.join(repositoryRoot, MIGRATIONS, `${name}.json`)),
      ).toBe(false);
      const module = (await import(
        pathToFileURL(path.join(repositoryRoot, MIGRATIONS, `${name}.ts`)).href
      )) as Record<"up" | "down", (args: unknown) => Promise<void>>;
      for (const fn of ["up", "down"] as const) {
        const body = bodyOf(text, fn);
        expect(body, fn).toBeDefined();
        expect(onlyStatements(body!), fn).toBe(true);
        const templates = templatesOf(body!);
        // A backslash is read one way in the file and cooked another in the template.
        for (const template of templates) expect(template).not.toContain("\\");
        // What the function hands the database is the text in the file, and only text.
        const sent: { queryChunks: unknown[] }[] = [];
        await module[fn]({
          db: {
            execute: (query: { queryChunks: unknown[] }) => {
              sent.push(query);
              return Promise.resolve();
            },
          },
        });
        expect(
          sent.map(({ queryChunks }) =>
            queryChunks
              .map((chunk) => {
                const { value } = chunk as { value?: unknown };
                if (!Array.isArray(value))
                  throw new Error(`${fn}: a parameter`);
                return value.join("");
              })
              .join(""),
          ),
          fn,
        ).toEqual(templates);
      }
    },
  );

  it.each(extracted)("%s only adds", (name) => {
    const up = templatesOf(bodyOf(source(name), "up")!).join("\n");
    for (const pattern of [
      /\bDROP\b/iu,
      /\bRENAME\b/iu,
      /\bALTER\s+TABLE\b[^;]*\bTYPE\b/iu,
      /\bSET\s+NOT\s+NULL\b/iu,
    ])
      expect(up, String(pattern)).not.toMatch(pattern);
  });
});

describe("the run ledger's checks", () => {
  const up = templatesOf(bodyOf(source(FIRST_EXTRACTED), "up")!).join("\n");
  /** The values a CHECK on a column lists, in order. */
  const listed = (table: string, column: string) => {
    const definition = new RegExp(
      `CREATE TABLE "${table}" \\(([\\s\\S]*?)\\n  \\);`,
      "u",
    ).exec(up)?.[1];
    const values = new RegExp(
      `"${column}" varchar NOT NULL[^\\n]*CHECK \\("${column}" IN \\(([^)]*)\\)`,
      "u",
    ).exec(definition ?? "")?.[1];
    return [...(values ?? "").matchAll(/'([a-z_]+)'/gu)].map(
      ([, value]) => value,
    );
  };

  it("hold the states and the classes the contract names", () => {
    expect(listed("mcp_runs", "state")).toEqual([...ADMIN_RUN_STATES]);
    expect(listed("mcp_run_targets", "state")).toEqual([
      ...ADMIN_RUN_TARGET_STATES,
    ]);
    expect(listed("mcp_runs", "class")).toEqual([
      "read",
      "reversible",
      "irreversible",
    ]);
    expect(up).toContain(
      `CHECK (char_length("reason") <= ${ADMIN_RUN_REASON_MAX})`,
    );
  });
});
