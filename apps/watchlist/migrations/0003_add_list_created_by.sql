-- Migration number: 0003 	 2026-02-01T00:00:00.000Z
alter table "list" add column "createdBy" text references "user" ("id") on delete set null;

update "list" set "createdBy" = (
  select "userId" from "user_to_list" where "listId" = "list"."id" limit 1
);
