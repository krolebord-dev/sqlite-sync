-- Migration number: 0001 	 2026-01-06T13:32:23.341Z
create table "user" (
  "id" text not null primary key,
  "name" text not null,
  "email" text not null unique,
  "createdAt" date not null,
  "updatedAt" date not null
);

create table "session" (
  "id" text not null primary key,
  "expiresAt" date not null,
  "createdAt" date not null,
  "updatedAt" date not null,
  "userId" text not null references "user" ("id") on delete cascade
);

create table "verification" (
  "target" text not null,
  "value" text not null,
  "expiresAt" date not null,
  "createdAt" date not null,
  primary key ("target", "value")
);
