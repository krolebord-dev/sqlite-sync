# CLAUDE.md

## Project Overview

**sqlite-sync** is an offline-first SQLite synchronization library with CRDT (Conflict-free Replicated Data Type) support. It enables local-first applications where all writes happen locally and sync automatically to remote servers via event-based replication.

The project is a **pnpm monorepo** containing 3 published packages and 3 applications.

## App-Specific Docs

- [Watchlist App](./apps/watchlist/CLAUDE.md) — production app with TanStack Router, oRPC, Cloudflare D1, and per-list CRDT sync

## Repository Structure

```
sqlite-sync/
├── packages/
│   ├── core/              # @sqlite-sync/core - Core sync engine, CRDT, HLC, migrations
│   ├── react/             # @sqlite-sync/react - React hooks and context bindings
│   └── cloudflare/        # @sqlite-sync/cloudflare - Durable Objects adapter, D1 executor
├── apps/
│   ├── example/           # Demo todo app (Vite + React + Cloudflare Workers)
│   ├── watchlist/         # Production app (TanStack Router + oRPC + Cloudflare D1)
│   └── benchmarks/        # Performance benchmarks (tinybench)
├── docs/                  # Architecture diagrams (Mermaid)
├── biome.json             # Formatter + linter config
├── pnpm-workspace.yaml    # Workspace config
├── tsconfig.json          # Root TypeScript config with project references
├── features-requirements.md
└── todo.md                # Feature progress checklist
```

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript 5.9, ES2022 target |
| Runtime | Cloudflare Workers (edge), Browser (OPFS + Web Workers) |
| Database | SQLite (OPFS in browser via `@sqlite.org/sqlite-wasm`, D1 on server) |
| Query Builder | Kysely |
| Frontend | React 19 |
| Build | Vite 7 (apps), tsup (packages), Wrangler (Cloudflare deploy) |
| Formatting/Linting | Biome |
| Testing | Vitest |
| Package Manager | pnpm (workspaces) |

## Architecture

### Sync Model (Multi-Layer)

```
Browser Tab (in-memory SQLite) ←→ Web Worker (OPFS-persisted SQLite) ←→ Remote Server (Cloudflare D1)
```

1. **In-memory DB**: Active tab holds a reactive SQLite database
2. **Web Worker DB**: Persists to OPFS, survives page reloads
3. **Remote DB**: Cloudflare Durable Objects with D1 storage

### CRDT Event Flow

- All mutations generate CRDT events via SQL triggers
- Events use Hybrid Logical Clocks (HLC) for ordering
- Events are conflict-free — no merge conflicts by design
- Two persistence modes: event-only or materialized (events applied to data tables)

## Common Commands

### Development

```bash
pnpm install                          # Install all dependencies
pnpm dev                              # Run example app (Vite dev server)
pnpm dev:server                       # Run example Cloudflare Worker locally

# Specific package dev
pnpm --filter @sqlite-sync/core dev   # Watch mode build for core
pnpm --filter @sqlite-sync/react dev  # Watch mode build for react
```

### Building

```bash
pnpm build                            # Build all packages and apps (recursive)
pnpm typecheck                        # Type-check all packages (recursive)
```

### Code Quality

```bash
pnpm format                           # Format + lint fix with Biome
```

### Publishing

```bash
pnpm version:patch                    # Bump patch version across packages
pnpm version:minor                    # Bump minor version
pnpm version:major                    # Bump major version
pnpm publish:dry                      # Dry-run publish
pnpm publish:packages                 # Publish all packages to npm
```

## Code Style & Conventions

### Biome Configuration

- **Formatter**: 2-space indent, 120-char line width
- **Strings**: Double quotes (`"hello"`)
- **Imports**: Auto-organized (Biome assist)
- **Tailwind**: CSS classes sorted via `useSortedClasses` (nursery rule, warn)

### TypeScript

- Strict mode enabled
- Module resolution: `bundler`
- `noEmit: true` in root (packages emit via tsup)
- Project references for cross-package type checking
- `@sqlite-sync/source` custom import condition maps to source `.ts` files during development

### File Patterns

- **Package exports**: Use conditional exports with `@sqlite-sync/source`, `workerd`, `types`, `import` conditions
- **Package builds**: tsup bundles to `dist/`
- **App builds**: Vite builds to `dist/client/` (with Cloudflare assets plugin)
- **Generated files**: `*.gen.ts` files are auto-generated and excluded from Biome

### Core Package Patterns

- **CRDT tables**: Defined via `makeCrdtTable()` factory with typed schemas
- **Migrations**: System schema auto-applied; user migrations planned but not yet implemented
- **Web Worker communication**: Message-passing protocol in `worker-db/`
- **WebSocket sync**: Remote source implementation in `web-socket/`
- **Reactive queries**: SQLite update hooks trigger re-evaluation of subscribed queries

## Key Files — Core Package (`packages/core/src/`)

| File | Purpose |
|------|---------|
| `sync-db.ts` | Main entry: creates SyncedDb instances |
| `hlc.ts` | Hybrid Logical Clock for event ordering |
| `sqlite-crdt/crdt-schema.ts` | CRDT event schema definition |
| `sqlite-crdt/crdt-storage.ts` | Event storage and retrieval |
| `sqlite-crdt/make-crdt-table.ts` | Factory for creating CRDT-enabled tables |
| `sqlite-crdt/apply-crdt-event.ts` | Applies events to materialized tables |
| `memory-db/sqlite-reactive-db.ts` | Reactive query subscriptions |
| `worker-db/db-worker.ts` | Web Worker entry point |
| `worker-db/db-worker-client.ts` | Tab-side worker communication |
| `server/server-common.ts` | Server-side sync logic |
| `migrations/migrator.ts` | Migration runner |

## Feature Status

Completed:
- Reactive SQLite queries
- React integration
- OPFS persistence via Web Workers + Web Locks
- Automatic CRDT event generation via SQL triggers
- De-sync recovery (tab ↔ worker, worker ↔ remote)
- Simple remote server sync
- Monorepo setup

Planned / In Progress:
- Event log compaction
- Events payload validation
- Offline support via Service Worker
- User-defined migrations
