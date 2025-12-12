# SQLite-sync

## Features and requirements

- Reactive queries
  - sqlite
  - update hook
  - commit/rollback hooks
- applying crdt events
  - data tables
  - update log table
- automatic crdt event generation (client, sql mutation -> triggers -> user-defined functions -> apply events)
  - data tables
  - views, triggers instead of
  - user-defined functions
  - commit/rollback hooks
- automatic crdt event generation (server, sql mutation -> )
- manual crdt events (server)
  - data tables

## Events persistence modes

1. Only applied_crdt_events table
   - Events push/pull only
   - No data tables
2. Materialized
   - Events push/pull
   - Events applied to data tables
