-- Migration number: 0002 	 2026-01-07T14:06:18.451Z
create table "list" (
  "id" text not null primary key,
  "name" text not null,
  "createdAt" text not null
);

create table "user_to_list" (
  "userId" text not null references "user" ("id") on delete cascade,
  "listId" text not null references "list" ("id") on delete cascade,
  primary key ("userId", "listId")
);
