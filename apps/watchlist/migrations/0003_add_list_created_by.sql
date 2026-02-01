-- Migration number: 0003 	 2026-02-01T00:00:00.000Z
create table "list_new" (
  "id" text not null primary key,
  "name" text not null,
  "createdAt" text not null,
  "createdBy" text not null references "user" ("id") on delete cascade
);

insert into "list_new" ("id", "name", "createdAt", "createdBy")
select
  l."id",
  l."name",
  l."createdAt",
  (select "userId" from "user_to_list" where "listId" = l."id" limit 1)
from "list" l;

drop table "list";

alter table "list_new" rename to "list";
