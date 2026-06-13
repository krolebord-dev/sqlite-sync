export type ColumnKind = "text" | "integer" | "real" | "boolean" | "enum";

export type SqliteStorageType = "text" | "integer" | "real";

export type ColumnMeta = {
  kind: ColumnKind;
  /** Storage type used in generated DDL. Booleans store as integer 0/1. */
  sqlType: SqliteStorageType;
  nullable: boolean;
  hasDefault: boolean;
  /** Declared default in JS form (booleans as booleans). */
  defaultValue?: unknown;
  /** Allowed values for `enum` columns. */
  enumValues?: readonly string[];
  description?: string;
};

export class ColumnBuilder<Value, HasDefault extends boolean = false> {
  declare readonly "~types": { value: Value; hasDefault: HasDefault };

  constructor(readonly meta: ColumnMeta) {}

  /** Allow SQL NULL; widens the value type with `null`. */
  nullable(): ColumnBuilder<Value | null, HasDefault> {
    return new ColumnBuilder({ ...this.meta, nullable: true });
  }

  /** Declare a column default. The value is used both in DDL and when migrating older events. */
  default(value: Value): ColumnBuilder<Value, true> {
    return new ColumnBuilder({ ...this.meta, hasDefault: true, defaultValue: value });
  }

  /** Narrow the TypeScript value type without changing storage, e.g. `t.text().$type<"movie" | "tv">()`. */
  $type<Narrowed extends Value>(): ColumnBuilder<Narrowed, HasDefault> {
    return this as unknown as ColumnBuilder<Narrowed, HasDefault>;
  }

  /** Human/AI-readable description, surfaced in generated schema docs. */
  describe(description: string): ColumnBuilder<Value, HasDefault> {
    return new ColumnBuilder({ ...this.meta, description });
  }
}

export type AnyColumnBuilder = ColumnBuilder<any, boolean>;

export type TableColumns = Record<string, AnyColumnBuilder>;

export type AnyTableBuilder = TableBuilder<any, any>;

export type SyncSchemaTables = Record<string, AnyTableBuilder>;

export type TableOptions<BaseName extends string | undefined = string | undefined> = {
  /** Override the materialized base table name (defaults to the crdt table name prefixed with "_"). */
  baseName?: BaseName;
  description?: string;
};

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type ColumnValue<Column> = Column extends ColumnBuilder<infer Value, boolean> ? Value : never;

export type InferRow<Cols extends TableColumns> = Simplify<
  { id: string } & { [K in keyof Cols]: ColumnValue<Cols[K]> } & { tombstone?: boolean }
>;

export type PayloadValidationResult = { success: true } | { success: false; errors: string[] };

const RESERVED_COLUMNS = ["id", "tombstone"] as const;

const idColumnMeta: ColumnMeta = {
  kind: "text",
  sqlType: "text",
  nullable: false,
  hasDefault: false,
  description: "Unique immutable item id",
};

const tombstoneColumnMeta: ColumnMeta = {
  kind: "boolean",
  sqlType: "integer",
  nullable: false,
  hasDefault: true,
  defaultValue: false,
  description: "Soft-delete marker",
};

export class TableBuilder<Cols extends TableColumns, BaseName extends string | undefined = undefined> {
  declare readonly "~baseName": BaseName;

  /** All columns in DDL order, including the auto-injected `id` and `tombstone`. */
  readonly columns: Record<string, ColumnMeta>;
  readonly baseName: BaseName;
  readonly description: string | undefined;

  constructor(
    readonly userColumns: Cols,
    options?: TableOptions<BaseName>,
  ) {
    for (const reserved of RESERVED_COLUMNS) {
      if (reserved in userColumns) {
        throw new Error(`Column "${reserved}" is added automatically to every synced table and cannot be declared`);
      }
    }

    this.columns = {
      id: idColumnMeta,
      ...Object.fromEntries(Object.entries(userColumns).map(([name, column]) => [name, column.meta])),
      tombstone: tombstoneColumnMeta,
    };
    this.baseName = options?.baseName as BaseName;
    this.description = options?.description;
  }

  describe(description: string): TableBuilder<Cols, BaseName> {
    return new TableBuilder(this.userColumns, { baseName: this.baseName, description });
  }

  /** Type-only: the row shape returned by queries. Do not access at runtime. */
  get $row(): InferRow<Cols> {
    return null as never;
  }

  /**
   * Validate a CRDT event payload against the declared columns.
   * `item-created` payloads must contain every column without a default (nullable columns may be omitted);
   * `item-updated` payloads are partial and must not touch `id` or set `tombstone` to a deleted value.
   */
  validatePayload(
    payload: Record<string, unknown>,
    options?: { event?: "item-created" | "item-updated" },
  ): PayloadValidationResult {
    const event = options?.event ?? "item-created";
    const errors: string[] = [];

    for (const key of Object.keys(payload)) {
      if (!(key in this.columns)) {
        errors.push(`Unknown column "${key}"`);
      }
    }

    if (event === "item-updated") {
      if ("id" in payload) {
        errors.push(`Column "id" is immutable and cannot appear in an update payload`);
      }
      if (payload.tombstone === true || payload.tombstone === 1) {
        errors.push(`Column "tombstone" cannot be set to true/1 in an update payload; use an item-deleted event`);
      }
    }

    if (event === "item-created") {
      for (const [name, meta] of Object.entries(this.columns)) {
        if (name in payload || name === "tombstone" || meta.nullable || meta.hasDefault) {
          continue;
        }
        errors.push(`Missing required column "${name}"`);
      }
    }

    for (const [name, value] of Object.entries(payload)) {
      const meta = this.columns[name];
      if (!meta || (event === "item-updated" && name === "id")) {
        continue;
      }
      const error = validateValue(name, value, meta);
      if (error) {
        errors.push(error);
      }
    }

    return errors.length === 0 ? { success: true } : { success: false, errors };
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateValue(name: string, value: unknown, meta: ColumnMeta): string | null {
  if (value === null) {
    return meta.nullable ? null : `Column "${name}" is not nullable, got null`;
  }

  switch (meta.kind) {
    case "text":
      return typeof value === "string" ? null : `Column "${name}" expects text, got ${describeValue(value)}`;
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
        ? null
        : `Column "${name}" expects an integer, got ${describeValue(value)}`;
    case "real":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : `Column "${name}" expects a number, got ${describeValue(value)}`;
    case "boolean":
      return typeof value === "boolean" || value === 0 || value === 1
        ? null
        : `Column "${name}" expects a boolean (true/false or 0/1), got ${describeValue(value)}`;
    case "enum": {
      if (typeof value !== "string") {
        return `Column "${name}" expects one of ${formatEnumValues(meta)}, got ${describeValue(value)}`;
      }
      return meta.enumValues?.includes(value)
        ? null
        : `Column "${name}" expects one of ${formatEnumValues(meta)}, got "${value}"`;
    }
  }
}

function formatEnumValues(meta: ColumnMeta): string {
  return (meta.enumValues ?? []).map((value) => `"${value}"`).join(" | ");
}

function column<Value>(kind: ColumnKind, sqlType: SqliteStorageType): ColumnBuilder<Value> {
  return new ColumnBuilder<Value>({ kind, sqlType, nullable: false, hasDefault: false });
}

export const t = {
  text: () => column<string>("text", "text"),
  integer: () => column<number>("integer", "integer"),
  real: () => column<number>("real", "real"),
  /** Stored as INTEGER 0/1; always bind booleans as 0/1 when writing raw SQL. */
  boolean: () => column<boolean>("boolean", "integer"),
  /**
   * Union of string literals stored as TEXT, e.g. `t.enum(["movie", "tv"])`. Unlike `$type`, the
   * allowed values are kept as runtime metadata, so payloads are validated against them.
   * For an open-ended set, use `t.text().$type<"idle" | (string & {})>()` instead.
   */
  enum: <const Values extends readonly [string, ...string[]]>(values: Values) =>
    new ColumnBuilder<Values[number]>({
      kind: "enum",
      sqlType: "text",
      nullable: false,
      hasDefault: false,
      enumValues: values,
    }),
  table: <Cols extends TableColumns, const BaseName extends string | undefined = undefined>(
    columns: Cols,
    options?: TableOptions<BaseName>,
  ) => new TableBuilder(columns, options),
};
