import type { AiDbExecutor } from "./db-access";

export type QueryGuardInput = {
  sql: string;
  parameters?: readonly unknown[];
};

export type QueryGuardRejection = {
  allowed: false;
  code: "invalid-statement" | "multi-statement" | "invalid-sql" | "write-detected" | "table-denied";
  message: string;
};

export type QueryGuardVerdict = { allowed: true } | QueryGuardRejection;

export class QueryGuardError extends Error {
  readonly rejection: QueryGuardRejection;

  constructor(rejection: QueryGuardRejection) {
    super(rejection.message);
    this.name = "QueryGuardError";
    this.rejection = rejection;
  }
}

export type QueryGuard = {
  /**
   * Statically verifies the query is a read-only single statement, and — when the guard was
   * created with `readableTables` — that it only reads those tables. Without `readableTables`
   * reads are unrestricted: the whole database file is in scope for the agent, so don't
   * colocate data the agent must not see.
   */
  check(input: QueryGuardInput): QueryGuardVerdict;
  /**
   * `check` + execute inside a forced-rollback transaction (the unconditional backstop for
   * anything the analysis might miss). Throws {@link QueryGuardError} when the check rejects.
   */
  execute<TResult = unknown>(input: QueryGuardInput): { rows: TResult[] };
};

/**
 * Opcodes that prove a statement is not read-only. `OpenWrite` covers row-level writes (every
 * real-table mutation opens its cursor through it), `Clear`/`Destroy` cover whole-table
 * deletes that skip cursors (truncate optimization), the rest cover DDL, pragma-class
 * statements (which a transaction rollback would NOT undo), virtual-table writes, and trigger
 * subprograms. `Insert`/`Delete`/`IdxInsert` are deliberately absent — they also run against
 * ephemeral/sorter cursors in ordinary SELECTs (DISTINCT, ORDER BY) and are only dangerous on
 * a cursor an `OpenWrite` would have created.
 */
const WRITE_OPCODES = new Set([
  "OpenWrite",
  "Clear",
  "Destroy",
  "CreateBtree",
  "SqlExec",
  "ParseSchema",
  "DropTable",
  "DropIndex",
  "DropTrigger",
  "SetCookie",
  "JournalMode",
  "Vacuum",
  "IncrVacuum",
  "Checkpoint",
  "MaxPgcnt",
  "Expire",
  "AutoCommit",
  "VUpdate",
  "VCreate",
  "VDestroy",
  "Program",
]);

/**
 * Opcodes that open a b-tree cursor for reading. `p2` is the root page of the table or index
 * and `p3` the database it lives in (0 = main), which is how a statement's real table set is
 * recovered — views are already flattened into their base tables by the time bytecode exists,
 * so aliases, CTEs, subqueries and quoting tricks all resolve here.
 */
const READ_CURSOR_OPCODES = new Set(["OpenRead", "ReopenIdx"]);

type ExplainRow = {
  opcode: string;
  p2: number | string;
  p3: number | string;
};

/**
 * Table-valued pragma functions (`pragma_table_list()`, ...) read the schema through a virtual
 * table, so no root page identifies them. They expose names and columns rather than rows, but a
 * hidden table should not be enumerable either, so they are rejected outright when restricted.
 */
const PRAGMA_FUNCTION_PATTERN = /\bpragma_[a-z_]+\s*\(/i;

const READ_STATEMENT_PREFIXES = ["select", "with", "values"];

export function createQueryGuard(opts: {
  executor: AiDbExecutor;
  /**
   * Restrict reads to these tables (matched case-insensitively, indexes on them included).
   * Views are resolved through their base tables, so pass base table names. Omit for
   * unrestricted reads.
   */
  readableTables?: readonly string[];
}): QueryGuard {
  const readableTables = opts.readableTables ? new Set(opts.readableTables.map((name) => name.toLowerCase())) : null;
  const readableTablesLabel = opts.readableTables?.join(", ") ?? "";

  /**
   * Root page to table name, for every b-tree in the main database. Re-read per query instead of
   * cached: a migration can drop a table and hand its root page to another one, and a stale map
   * would then resolve that page to the wrong (possibly allowed) name.
   */
  function readRootPages(): Map<number, string> {
    const rows = opts.executor.execute<{ tbl_name: string; rootpage: number }>({
      sql: `SELECT "tbl_name", "rootpage" FROM "sqlite_master" WHERE "rootpage" IS NOT NULL AND "rootpage" > 0`,
      parameters: [],
    }).rows;
    return new Map(rows.map((row) => [Number(row.rootpage), row.tbl_name]));
  }

  function checkReadableTables(sql: string, operations: ExplainRow[]): QueryGuardRejection | null {
    if (!readableTables) {
      return null;
    }

    if (PRAGMA_FUNCTION_PATTERN.test(sql)) {
      return reject(
        "table-denied",
        `Pragma functions are not available. You can only read these tables: ${readableTablesLabel}.`,
      );
    }

    const cursors = operations.filter((operation) => READ_CURSOR_OPCODES.has(operation.opcode));
    if (cursors.length === 0) {
      return null;
    }

    let rootPages: Map<number, string>;
    try {
      rootPages = readRootPages();
    } catch {
      // Fail closed: without the schema mapping we cannot tell which tables the statement reads.
      return reject("table-denied", "The tables this statement reads could not be verified, so it was rejected.");
    }

    for (const cursor of cursors) {
      // Only the main database is mapped; nothing the agent can legitimately read lives elsewhere.
      const name = Number(cursor.p3) === 0 ? rootPages.get(Number(cursor.p2)) : undefined;
      if (!name || !readableTables.has(name.toLowerCase())) {
        const subject = name ? `Table "${name}"` : "A table this statement reads";
        return reject(
          "table-denied",
          `${subject} is not available to you. You can only read these tables: ${readableTablesLabel}.`,
        );
      }
    }

    return null;
  }

  function reject(code: QueryGuardRejection["code"], message: string): QueryGuardRejection {
    return { allowed: false, code, message };
  }

  function check(input: QueryGuardInput): QueryGuardVerdict {
    let body = input.sql.trim();
    while (body.endsWith(";")) {
      body = body.slice(0, -1).trimEnd();
    }

    if (body.includes(";")) {
      return reject(
        "multi-statement",
        "Only a single SQL statement is allowed per query, and semicolons are only allowed at the very end. If the semicolon is inside a string literal, pass the value as a bound parameter instead.",
      );
    }

    const lowered = body.toLowerCase();
    if (!READ_STATEMENT_PREFIXES.some((keyword) => lowered.startsWith(keyword))) {
      return reject(
        "invalid-statement",
        "Only read-only queries are allowed: the statement must start directly with SELECT, WITH, or VALUES (no leading comments).",
      );
    }

    let operations: ExplainRow[];
    try {
      operations = opts.executor.execute<ExplainRow>({
        sql: `EXPLAIN ${input.sql}`,
        parameters: input.parameters ?? [],
      }).rows;
    } catch (error) {
      return reject("invalid-sql", `SQL error: ${error instanceof Error ? error.message : String(error)}`);
    }

    for (const operation of operations) {
      if (WRITE_OPCODES.has(operation.opcode)) {
        return reject(
          "write-detected",
          `The statement was rejected because it would modify the database (${operation.opcode}). This tool is strictly read-only; rewrite the query as a pure SELECT.`,
        );
      }
    }

    const denied = checkReadableTables(body, operations);
    if (denied) {
      return denied;
    }

    return { allowed: true };
  }

  return {
    check,
    execute(input) {
      const verdict = check(input);
      if (!verdict.allowed) {
        throw new QueryGuardError(verdict);
      }
      return runWithForcedRollback(opts.executor, (tx) => {
        return tx.execute({ sql: input.sql, parameters: input.parameters ?? [] });
      });
    },
  };
}

/**
 * Runs `callback` in a transaction that is always rolled back (via a sentinel throw, relying
 * on the {@link AiDbExecutor} contract that a throwing callback rolls back). This is the
 * unconditional write guard backing any gap in the static analysis.
 */
export function runWithForcedRollback<T>(
  executor: Pick<AiDbExecutor, "transaction">,
  callback: (tx: Pick<AiDbExecutor, "execute">) => T,
): T {
  let result: T | undefined;
  let completed = false;
  const rollbackSentinel = new Error("forced read-only rollback");

  try {
    executor.transaction((tx) => {
      result = callback(tx);
      completed = true;
      throw rollbackSentinel;
    });
  } catch (error) {
    if (error !== rollbackSentinel) {
      throw error;
    }
  }

  if (!completed) {
    throw new Error("Transaction completed without running the callback");
  }
  return result as T;
}
