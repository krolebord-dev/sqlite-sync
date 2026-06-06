-- Migration number: 0004 	 2026-06-06T00:00:00.000Z
alter table "user" add column "role" text not null default 'user';
