import fs from 'node:fs';
import fsPath from 'node:path';
import { config } from 'dotenv';
import type { Config } from 'drizzle-kit';

config({ path: pathFromRoot('.dev.vars') });

const localConfig = {
  schema: 'worker/main/db/schema.ts',
  dialect: 'sqlite',
  dbCredentials: {
    url: findLocalDbPath('.wrangler/state/v3/d1/miniflare-D1DatabaseObject') as string,
  },
} satisfies Config;

const prodConfig = {
  schema: 'worker/main/db/schema.ts',
  out: 'worker/main/db/migrations',
  dialect: 'sqlite',
  driver: 'd1-http',
  dbCredentials: {
    accountId: process.env.ACCOUNT_ID as string,
    databaseId: process.env.DATABASE_ID as string,
    token: process.env.ACCOUNT_TOKEN as string,
  },
} satisfies Config;

export default process.env.LOCAL ? localConfig : prodConfig;

function pathFromRoot(path: string) {
  return fsPath.resolve(process.cwd(), path);
}

function findLocalDbPath(dir: string) {
  const files = fs.readdirSync(dir);
  const sqliteFile = files.find((file) => file.endsWith('.sqlite'));
  if (!sqliteFile) {
    throw new Error('No SQLite file found in the specified directory');
  }
  console.log(fsPath.join(dir, sqliteFile));
  return fsPath.join(dir, sqliteFile);
}
