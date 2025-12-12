import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export function createDb(env: Env) {
  return drizzle(env.MAIN_DB, { schema });
}

export const mainSchema = schema;

export type MainDb = ReturnType<typeof createDb>;
