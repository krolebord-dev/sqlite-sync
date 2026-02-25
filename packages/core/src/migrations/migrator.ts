import type {
  ColumnDataType,
  ColumnDefinitionBuilderCallback,
  Compilable,
  CreateIndexBuilder,
  CreateTableBuilder,
  Expression,
  Kysely,
} from "kysely";
import { dummyKysely } from "../dummy-kysely";
import type { CrdtEventType } from "../sqlite-crdt/crdt-table-schema";
import type { StoredValue } from "../sqlite-crdt/stored-value";

type CrdtEvent = {
  type: CrdtEventType;
  dataset: string;
  item_id: string;
  payload: Record<string, unknown>;
};

export type MigratableEvent = {
  schema_version: number;
  type: CrdtEventType;
  dataset: string;
  item_id: string;
  payload: string;
};

type CrdtEventTransformer = (event: CrdtEvent) => CrdtEvent | null;

type MigrationStepSql =
  | {
      sql: string;
      parameters?: readonly unknown[];
    }
  | Compilable
  | ((db: Kysely<unknown>) => Compilable);

type MigrationStep = {
  sql: MigrationStepSql | MigrationStepSql[];
  eventTransformer?: MigrationEventTransformers;
};

type RawMigrationStep = {
  sql: MigrationSql[];
  eventTransformer?: MigrationEventTransformers;
};

type MigrationSql = { sql: string; parameters: readonly unknown[] };

type DataTypeExpression = ColumnDataType | Expression<any>;

const migrationSteps = {
  createTable: (table: string, build: (table: CreateTableBuilder<string, never>) => Compilable): MigrationStep => ({
    sql: (db) => build(db.schema.createTable(table)),
  }),

  dropTable: (table: string): MigrationStep => ({
    sql: (db) => db.schema.dropTable(table),
    eventTransformer: {
      [table]: () => null,
    },
  }),

  createIndex: (indexName: string, build: (index: CreateIndexBuilder) => Compilable): MigrationStep => ({
    sql: (db) => build(db.schema.createIndex(indexName)),
  }),

  dropIndex: (indexName: string): MigrationStep => ({
    sql: (db) => db.schema.dropIndex(indexName),
  }),

  renameTable: ({ oldTable, newTable }: { oldTable: string; newTable: string }): MigrationStep => ({
    sql: (db) => db.schema.alterTable(oldTable).renameTo(newTable),
    eventTransformer: {
      [oldTable]: (event) => {
        event.dataset = newTable;
        return event;
      },
    },
  }),

  renameColumn: ({
    table,
    oldColumn,
    newColumn,
  }: {
    table: string;
    oldColumn: string;
    newColumn: string;
  }): MigrationStep => ({
    sql: (db) => db.schema.alterTable(table).renameColumn(oldColumn, newColumn),
    eventTransformer: {
      [table]: (event) => {
        if ((event.type !== "item-updated" && event.type !== "item-created") || !(oldColumn in event.payload)) {
          return event;
        }

        const oldVal = event.payload[oldColumn];
        delete event.payload[oldColumn];
        event.payload[newColumn] = oldVal;

        return event;
      },
    },
  }),

  addColumn: ({
    table,
    column,
    type,
    defaultValue,
    build = (e) => e,
  }: {
    table: string;
    column: string;
    type: DataTypeExpression;
    defaultValue: unknown;
    build?: ColumnDefinitionBuilderCallback;
  }): MigrationStep => ({
    sql: (db) => db.schema.alterTable(table).addColumn(column, type, (x) => build(x).defaultTo(defaultValue)),
    eventTransformer: {
      [table]: (event) => {
        if (event.type !== "item-created") {
          return event;
        }

        event.payload[column] = defaultValue;

        return event;
      },
    },
  }),

  dropColumn: ({ table, column }: { table: string; column: string }): MigrationStep => ({
    sql: (db) => db.schema.alterTable(table).dropColumn(column),
    eventTransformer: {
      [table]: (event) => {
        if (event.type !== "item-updated" && event.type !== "item-created") {
          return event;
        }

        if (!(column in event.payload)) {
          return event;
        }

        delete event.payload[column];

        if (Object.keys(event.payload).length === 0) {
          return null;
        }

        return event;
      },
    },
  }),
};

type MigrationEventTransformers = Record<string, CrdtEventTransformer>;

function buildMigrationSql(steps: MigrationStep[]): MigrationSql[] {
  return steps
    .flatMap((step) => (Array.isArray(step.sql) ? step.sql : [step.sql]))
    .map((sql): MigrationSql => {
      if (typeof sql === "string") {
        return { sql, parameters: [] };
      }

      if (typeof sql === "function") {
        const query = sql(dummyKysely).compile();
        return { sql: query.sql, parameters: query.parameters };
      }

      if ("compile" in sql) {
        const query = sql.compile();
        return { sql: query.sql, parameters: query.parameters };
      }

      return {
        sql: sql.sql,
        parameters: sql.parameters ?? [],
      };
    });
}

function buildMigrationEventTransformer(steps: MigrationStep[]): MigrationEventTransformers {
  const transformers = new Map<string, CrdtEventTransformer[]>();

  for (const step of steps) {
    if (step.eventTransformer) {
      for (const [table, transformer] of Object.entries(step.eventTransformer)) {
        const existingTransformers = transformers.get(table);
        if (existingTransformers) {
          existingTransformers.push(transformer);
        } else {
          transformers.set(table, [transformer]);
        }
      }
    }
  }

  const entries = Array.from(transformers.entries()).map(([table, transformers]) => {
    return [
      table,
      (event: CrdtEvent | null) => {
        for (const transformer of transformers) {
          if (event === null) {
            return null;
          }
          event = transformer(event);
          if (event === null) {
            return null;
          }
        }
        return event;
      },
    ];
  });
  return Object.fromEntries(entries);
}

export function createMigrations(buildMigrations: (builder: typeof migrationSteps) => Record<number, MigrationStep[]>) {
  const migrations: Record<number, RawMigrationStep> = Object.fromEntries(
    Object.entries(buildMigrations(migrationSteps)).map(([version, steps]) => {
      const versionNumber = Number(version);

      if (Number.isNaN(versionNumber)) {
        throw new Error(`Invalid migration version: ${version}`);
      }

      if (versionNumber < 0) {
        throw new Error(`Migration version cannot be negative: ${version}`);
      }

      return [
        version,
        {
          sql: buildMigrationSql(steps),
          eventTransformer: buildMigrationEventTransformer(steps),
        },
      ];
    }),
  );

  return migrations;
}

export type Migrations = ReturnType<typeof createMigrations>;

export type MigrationsDb = {
  startTransaction: (callback: (tx: MigrationsTransaction) => void) => void;
};

type MigrationsTransaction = {
  execute: (sql: string, parameters: readonly unknown[]) => void;
};

export function createMigrator({
  migrations,
  schemaVersion,
}: {
  migrations: Migrations;
  schemaVersion: StoredValue<number>;
}) {
  const latestSchemaVersion = Math.max(...Object.keys(migrations).map(Number));

  // Pre-sort migrations once for efficient range lookups
  const sortedMigrations = Object.entries(migrations)
    .map(([v, m]) => [Number(v), m] as const)
    .sort((a, b) => a[0] - b[0]);

  const applyMigration = (db: MigrationsDb, version: number, sqlStatements: MigrationSql[]) => {
    if (version <= schemaVersion.current) {
      throw new Error(`Cannot apply migration ${version} to schema version ${schemaVersion.current}`);
    }

    db.startTransaction((tx) => {
      for (const statement of sqlStatements) {
        tx.execute(statement.sql, statement.parameters);
      }
      schemaVersion.current = version;
    });
  };

  const migrateEvent = <Event extends MigratableEvent>(event: Event, targetVersion?: number): Event | null => {
    targetVersion ??= latestSchemaVersion;
    if (targetVersion > schemaVersion.current) {
      throw new Error(
        `Target schema version ${targetVersion} is greater than current schema version ${schemaVersion.current}`,
      );
    }

    if (event.schema_version >= targetVersion) {
      return event;
    }

    const fromVersion = event.schema_version;

    let crdtEvent: CrdtEvent | null = {
      dataset: event.dataset,
      item_id: event.item_id,
      type: event.type,
      payload: JSON.parse(event.payload),
    };

    for (let i = 0; i < sortedMigrations.length; i++) {
      const [version, migration] = sortedMigrations[i];
      if (version <= fromVersion) continue;
      if (version > targetVersion) break;

      const transformer: CrdtEventTransformer | undefined = migration.eventTransformer?.[crdtEvent.dataset];
      if (transformer) {
        crdtEvent = transformer(crdtEvent);
        if (crdtEvent === null) return null;
      }
    }

    if (crdtEvent === null) {
      return null;
    }

    event.dataset = crdtEvent.dataset;
    event.item_id = crdtEvent.item_id;
    event.type = crdtEvent.type;
    event.payload = JSON.stringify(crdtEvent.payload);

    return event;
  };

  const migrateEvents = <Event extends MigratableEvent>(events: Event[], targetVersion?: number): Event[] => {
    return events
      .map((event) => migrateEvent(event, targetVersion ?? latestSchemaVersion))
      .filter((event): event is NonNullable<typeof event> => event !== null);
  };

  return {
    latestSchemaVersion,
    get currentSchemaVersion() {
      return schemaVersion.current;
    },
    migrateDbToLatest: (db: MigrationsDb) => {
      const currentSchemaVersion = schemaVersion.current;

      if (currentSchemaVersion >= latestSchemaVersion) {
        return;
      }

      for (let i = 0; i < sortedMigrations.length; i++) {
        const [version, { sql }] = sortedMigrations[i];
        if (version <= currentSchemaVersion) continue;
        applyMigration(db, version, sql);
      }
    },
    migrateEvent,
    migrateEvents,
  };
}

export type SyncDbMigrator = ReturnType<typeof createMigrator>;
