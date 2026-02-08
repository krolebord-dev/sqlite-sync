import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { getContext } from "./context";
import type { DB } from "./db-types";

export const db = new Kysely<DB>({
  dialect: new D1Dialect({ database: getContext().MAIN_DB }),
});
