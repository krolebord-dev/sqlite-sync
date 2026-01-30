# CLAUDE.md

## Project Overview

**sqlite-sync** is an offline-first SQLite synchronization library with CRDT (Conflict-free Replicated Data Type) support. It enables local-first applications where all writes happen locally and sync automatically to remote servers via event-based replication.

The project is a **pnpm monorepo** containing 3 published packages and 3 applications.

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
| Frontend | React 19, TanStack Router (file-based routing), TanStack React Query |
| API | oRPC (typed RPC over HTTP) |
| UI Components | Shadcn/UI (Radix primitives + Tailwind CSS 4) |
| State | Jotai (atomic), React Query (server state), sync DB context (local DB) |
| Auth | Magic link + OAuth (Google, Twitch) via `arctic` |
| AI | Vercel AI SDK + OpenRouter / Workers AI |
| Build | Vite 7 (apps), tsup (packages), Wrangler (Cloudflare deploy) |
| Formatting/Linting | Biome |
| Testing | Vitest + Testing Library |
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

### Watchlist App Request Routing

- `/rpc/*` → oRPC API handlers
- `/api/*` → REST endpoints (OAuth callbacks)
- `/list-db/*` → Durable Object routing (per-list sync)
- `/*` → Frontend SPA (Vite)

## Common Commands

### Development

```bash
pnpm install                          # Install all dependencies
pnpm dev                              # Run example app (Vite dev server)
pnpm dev:server                       # Run example Cloudflare Worker locally

# Watchlist app
pnpm --filter watchlist dev           # Dev server on port 3000
pnpm --filter watchlist build         # Build for production
pnpm --filter watchlist deploy        # Build + wrangler deploy
pnpm --filter watchlist test          # Run tests (vitest)

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

### Database (Watchlist)

```bash
pnpm --filter watchlist db:local:init       # Initialize local D1
pnpm --filter watchlist db:local:migrate    # Apply D1 migrations locally
pnpm --filter watchlist db:new-migration    # Create new D1 migration
pnpm --filter watchlist generate:types:db   # Generate Kysely types from D1
pnpm --filter watchlist generate:types:env  # Generate Wrangler env types
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

### Watchlist App Patterns

- **Routing**: TanStack file-based routing in `src/routes/` — route tree is auto-generated to `routeTree.gen.ts`
- **API**: oRPC routers in `src/orpc/routers/` with typed client in `src/orpc/orpc-client.ts`
- **Components**: Shadcn/UI components in `src/components/ui/`, configured via `components.json`
- **Database types**: Generated with `kysely-codegen` to `src/lib/db-types.ts`
- **Migrations**: SQL files in `src/migrations/`, managed by Wrangler D1
- **Per-list sync DB**: Defined in `src/list-db/migrations.ts` as CRDT table schemas

### Core Package Patterns

- **CRDT tables**: Defined via `makeCrdtTable()` factory with typed schemas
- **Migrations**: System schema auto-applied; user migrations planned but not yet implemented
- **Web Worker communication**: Message-passing protocol in `worker-db/`
- **WebSocket sync**: Remote source implementation in `web-socket/`
- **Reactive queries**: SQLite update hooks trigger re-evaluation of subscribed queries

## Key Files Reference

### Core Package (`packages/core/src/`)

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

### Watchlist App (`apps/watchlist/src/`)

| File | Purpose |
|------|---------|
| `server.ts` | Cloudflare Worker entry point |
| `routes/__root.tsx` | Root layout with providers |
| `routes/_app/route.tsx` | Auth guard for protected routes |
| `orpc/orpc-router.ts` | Main API router |
| `list-db/list-db-server.ts` | Durable Object for per-list sync |
| `list-db/migrations.ts` | List item CRDT schema |
| `lib/db.ts` | Kysely D1 database instance |
| `lib/context.ts` | Environment variables typing |
| `migrations/*.sql` | D1 migration files |

## Environment Variables (Watchlist)

Required environment bindings (configured in `wrangler.jsonc`):

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — OAuth
- `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` — OAuth
- `AUTH_SECRET` — Session signing
- `RESEND_API_KEY` — Email delivery (optional)
- `VITE_APP_URL` — Public app URL
- `MODE` — `"development"` or `"production"`
- D1 binding: `watchlist-admin`
- Durable Object binding: `ListDbServer`
- AI binding: Remote inference

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
