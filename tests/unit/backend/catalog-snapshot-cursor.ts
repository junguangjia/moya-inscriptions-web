/*
 * catalog-scale-v1 (W3): the complete Catalog snapshot reads each side through
 * a NO SCROLL cursor (DECLARE, FETCH FORWARD n, CLOSE). Unit harnesses that
 * answer SQL text keep answering the declared query; this emulates the cursor
 * statements over it. Synthetic rows only.
 */

/** One FETCH as the harness answered it. */
export interface CursorFetch {
  readonly cursor: string;
  readonly wanted: number;
  readonly returned: number;
}

/**
 * Returns a handler for DECLARE/FETCH/CLOSE statements, or undefined for any
 * other statement. `rowsFor` answers the declared query's SQL (undefined
 * refuses it). `fetches` records every FETCH.
 */
export const snapshotCursors = (
  rowsFor: (sql: string) => readonly unknown[] | undefined,
  fetches: CursorFetch[] = [],
) => {
  const open = new Map<string, { rows: readonly unknown[]; at: number }>();
  return (sql: string): { rows: unknown[] } | undefined => {
    const declared = /^DECLARE (\w+) NO SCROLL CURSOR FOR ([\s\S]+)$/u.exec(
      sql,
    );
    if (declared) {
      const rows = rowsFor(declared[2]!);
      if (rows === undefined) throw new Error("UNEXPECTED_CURSOR_SQL");
      open.set(declared[1]!, { rows, at: 0 });
      return { rows: [] };
    }
    const fetched = /^FETCH FORWARD (\d+) FROM (\w+)$/u.exec(sql);
    if (fetched) {
      const cursor = open.get(fetched[2]!);
      if (cursor === undefined) throw new Error("UNDECLARED_CURSOR");
      const wanted = Number(fetched[1]);
      const rows = cursor.rows.slice(cursor.at, cursor.at + wanted);
      cursor.at += rows.length;
      fetches.push({ cursor: fetched[2]!, wanted, returned: rows.length });
      return { rows };
    }
    const closed = /^CLOSE (\w+)$/u.exec(sql);
    if (closed) {
      if (!open.delete(closed[1]!)) throw new Error("UNDECLARED_CURSOR");
      return { rows: [] };
    }
    return undefined;
  };
};
