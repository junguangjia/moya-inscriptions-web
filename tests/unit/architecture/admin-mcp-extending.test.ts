import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { repositoryRoot } from "./workspace-scanner.js";

// docs/development/admin-mcp-extending.md lists where a new feature touches the AI
// layer. It is only worth reading while it is true: every file it names exists, every
// table it names is still declared in the file beside it, not merely a word there, and
// every touch point says what catches it.

const GUIDE = "docs/development/admin-mcp-extending.md";
const guide = readFileSync(path.join(repositoryRoot, GUIDE), "utf8");

const HEADER = ["Touch point", "File", "Table", "Caught by"];

const ticked = (text: string): string[] =>
  [...text.matchAll(/`([^`]+)`/gu)].map(([, value]) => value!);
const isPath = (value: string) => /^[\w.-]+(?:\/[\w.-]+)+$/u.test(value);
const isIdentifier = (value: string) => /^[A-Za-z_]\w*$/u.test(value);
const exists = (relative: string) =>
  existsSync(path.join(repositoryRoot, relative));
const source = (relative: string) =>
  readFileSync(path.join(repositoryRoot, relative), "utf8");
/**
 * Declared in the text, and not only a word in it: a binding, a function, a type or a
 * class of that name, or a member at the start of its line, as a field is.
 */
const declares = (text: string, name: string) =>
  new RegExp(
    `\\b(?:const|let|function|type|interface|class)\\s+${name}\\b|^\\s*(?:readonly\\s+)?${name}\\??:`,
    "mu",
  ).test(text);

/** The rows of every table with the touch-point header, as cells. */
const touchPoints = (text: string): string[][] => {
  const rows: string[][] = [];
  let inTable = false;
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) {
      inTable = false;
      continue;
    }
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.join("|") === HEADER.join("|")) inTable = true;
    else if (inTable && !/^-+$/u.test(cells[0]!)) rows.push(cells);
  }
  return rows;
};

const rows = touchPoints(guide);
const named = [...new Set(ticked(guide).filter(isPath))];

describe("the guide to extending Admin MCP", () => {
  it("is read as tables, one per recipe", () => {
    for (const heading of [
      "## A community content type",
      "## A field and a filter",
      "## An Owner page",
      "## An irreversible op",
    ])
      expect(guide).toContain(heading);
    expect(rows.length).toBeGreaterThan(30);
    for (const row of rows) expect(row, row[0]).toHaveLength(HEADER.length);
  });

  it("names only files that exist", () => {
    expect(named.length).toBeGreaterThan(10);
    for (const file of named) expect(exists(file), file).toBe(true);
  });

  it("finds each table declared in the file beside it", () => {
    for (const [point, fileCell, tableCell] of rows) {
      const files = ticked(fileCell!).filter(isPath);
      expect(files, point).toHaveLength(1);
      const text = source(files[0]!);
      for (const table of ticked(tableCell!)) {
        expect(isIdentifier(table), `${point}: ${table}`).toBe(true);
        expect(declares(text, table), `${point}: ${table} in ${files[0]}`).toBe(
          true,
        );
      }
    }
  });

  it("names constants still declared in the files it names", () => {
    const texts = named.filter((file) => /\.tsx?$/u.test(file)).map(source);
    for (const constant of ticked(guide).filter((value) =>
      /^[A-Z][A-Z0-9_]+$/u.test(value),
    ))
      expect(
        texts.some((text) => declares(text, constant)),
        constant,
      ).toBe(true);
  });

  it("says what catches each touch point, and names the test that guards one", () => {
    for (const [point, , , caught] of rows) {
      expect(caught, point).toMatch(/^(?:forced|guarded|review)\b/u);
      if (caught!.startsWith("guarded:"))
        expect(ticked(caught!).filter(isPath).length, point).toBeGreaterThan(0);
    }
  });
});
