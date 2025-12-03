pragma journal_mode = MEMORY;
pragma foreign_keys = ON;
pragma synchronous;

select "name",
  "sql",
  "type"
from "sqlite_master"
where "type" in (?, ?)
  and "name" not like ?
  and "name" != ?
  and "name" != ?
order by "name";

with "table_list" as (
  select "name",
    "sql",
    "type"
  from "sqlite_master"
  where "type" in (?, ?)
    and "name" not like ?
    and "name" != ?
    and "name" != ?
  order by "name"
)
select "tl"."name" as "table",
  "p"."cid",
  "p"."name",
  "p"."type",
  "p"."notnull",
  "p"."dflt_value",
  "p"."pk"
from "table_list" as "tl",
  pragma_table_info(tl.name) as "p"
order by "tl"."name",
  "p"."cid"
