import { createMigrations, createSyncDbSchema } from "@sqlite-sync/core";

export type UserDbProps = {
  userId: string;
};

export type NoteItem = {
  id: string;
  type: string;
  title: string;
  content: string;
  order: number;
  createdAt: number;
  tombstone?: boolean;
};

export type CurrencyRateItem = {
  id: string;
  date: string;
  baseCurrency: string;
  tombstone?: boolean;
  AUD: number | null;
  BRL: number | null;
  CAD: number | null;
  CHF: number | null;
  CNY: number | null;
  CZK: number | null;
  DKK: number | null;
  EUR: number | null;
  GBP: number | null;
  HKD: number | null;
  HUF: number | null;
  IDR: number | null;
  ILS: number | null;
  INR: number | null;
  ISK: number | null;
  JPY: number | null;
  KRW: number | null;
  MXN: number | null;
  MYR: number | null;
  NOK: number | null;
  NZD: number | null;
  PHP: number | null;
  PLN: number | null;
  RON: number | null;
  SEK: number | null;
  SGD: number | null;
  THB: number | null;
  TRY: number | null;
  UAH: number | null;
  USD: number | null;
  ZAR: number | null;
};

const migrations = createMigrations((b) => ({
  0: [
    b.createTable("_item", (t) =>
      t
        .addColumn("id", "text", (col) => col.primaryKey().notNull())
        .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false))
        .addColumn("type", "text", (col) => col.notNull().defaultTo("note"))
        .addColumn("title", "text", (col) => col.notNull())
        .addColumn("createdAt", "integer", (col) => col.notNull()),
    ),
  ],
  1: [
    b.addColumn({ table: "_item", column: "content", type: "text", defaultValue: "" }),
    b.addColumn({ table: "_item", column: "order", type: "real", defaultValue: 0 }),
  ],
  2: [
    b.createTable("_currency_rate", (t) =>
      t
        .addColumn("id", "text", (col) => col.primaryKey().notNull())
        .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false))
        .addColumn("date", "text", (col) => col.notNull())
        .addColumn("baseCurrency", "text", (col) => col.notNull())
        .addColumn("AUD", "real")
        .addColumn("BRL", "real")
        .addColumn("CAD", "real")
        .addColumn("CHF", "real")
        .addColumn("CNY", "real")
        .addColumn("CZK", "real")
        .addColumn("DKK", "real")
        .addColumn("EUR", "real")
        .addColumn("GBP", "real")
        .addColumn("HKD", "real")
        .addColumn("HUF", "real")
        .addColumn("IDR", "real")
        .addColumn("ILS", "real")
        .addColumn("INR", "real")
        .addColumn("ISK", "real")
        .addColumn("JPY", "real")
        .addColumn("KRW", "real")
        .addColumn("MXN", "real")
        .addColumn("MYR", "real")
        .addColumn("NOK", "real")
        .addColumn("NZD", "real")
        .addColumn("PHP", "real")
        .addColumn("PLN", "real")
        .addColumn("RON", "real")
        .addColumn("SEK", "real")
        .addColumn("SGD", "real")
        .addColumn("THB", "real")
        .addColumn("TRY", "real")
        .addColumn("UAH", "real")
        .addColumn("USD", "real")
        .addColumn("ZAR", "real"),
    ),
  ],
}));

export type UserDb = (typeof syncDbSchema)["~clientSchema"];

export type UserSyncDbSchema = typeof syncDbSchema;

export const syncDbSchema = createSyncDbSchema({
  migrations,
})
  .addTable<NoteItem>()
  .withConfig({ baseTableName: "_item", crdtTableName: "item" })
  .addTable<CurrencyRateItem>()
  .withConfig({ baseTableName: "_currency_rate", crdtTableName: "currency_rate" })
  .build();
