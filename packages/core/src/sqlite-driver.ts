export type SqliteDriverValue = string | number | bigint | Uint8Array | null;

export type SqliteDriverRows = {
  columns: string[];
  rows: SqliteDriverValue[][];
};

export type SqliteDriverStatement = {
  /** Binds, steps to completion and resets the statement. Must run synchronously. */
  run: (parameters: readonly unknown[]) => SqliteDriverRows;
  finalize: () => void;
  /**
   * `sqlite3_stmt_readonly`. Drivers that cannot report it leave it undefined
   * and the wrapper classifies the statement through `tables_used`.
   */
  readonly?: boolean;
};

export type SqliteDriverHooks = {
  onUpdate: (table: string) => void;
  onCommit: () => void;
  onRollback: () => void;
};

export type SqliteDriver = {
  prepare: (sql: string) => SqliteDriverStatement;
  totalChanges: () => number;
  /**
   * Installs update/commit/rollback hooks. Pass `null` to remove them.
   *
   * Hooks may be delivered after the statement that caused them returns, but
   * they must be delivered in the order SQLite raised them.
   */
  setHooks: (hooks: SqliteDriverHooks | null) => void;
  /** Whether hooks run inside the statement that raised them, before it returns. */
  readonly synchronousHooks: boolean;
  close: () => void;
  serialize?: () => Uint8Array<ArrayBufferLike>;
  deserialize?: (snapshot: Uint8Array<ArrayBufferLike>) => void;
  createScalarFunction?: (options: {
    name: string;
    callback: (...args: SqliteDriverValue[]) => SqliteDriverValue | undefined;
    arity: number;
    deterministic?: boolean;
    directOnly?: boolean;
    innocuous?: boolean;
  }) => void;
};
