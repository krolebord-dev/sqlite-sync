# SQLITE-SYNC Monorepo

## Project Overview

**sqlite-sync** is an offline-first SQLite synchronization library with CRDT (Conflict-free Replicated Data Type) support. It enables local-first applications where all writes happen locally and sync automatically to remote servers via event-based replication.

The project is a **pnpm monorepo** containing published packages and applications.

## App-Specific Docs

- [Library docs](docs.md) - full docs for using @sqlite-sync in apps
- [Watchlist App](apps/watchlist/CLAUDE.md) — production app with TanStack Router, oRPC, Cloudflare D1, and per-list CRDT sync

## Repository Structure

```
sqlite-sync/packages/core/ # @sqlite-sync/core - Core sync engine, CRDT, HLC, migrations
sqlite-sync/packages/react/ # @sqlite-sync/react - React hooks and context bindings
sqlite-sync/packages/cloudflare/ # @sqlite-sync/cloudflare - Durable Objects adapter, D1 executor
sqlite-sync/apps/example/ # Demo todo app (Vite + React + Cloudflare Workers)
sqlite-sync/apps/watchlist/ # App for managing "watch later" lists (TanStack Router + oRPC + Cloudflare D1)
sqlite-sync/apps/productivity/ # Production app (TanStack Router + oRPC + Cloudflare D1)
sqlite-sync/apps/benchmarks/ # Performance benchmarks (tinybench)
sqlite-sync/docs/ # Architecture docs and diagrams
sqlite-sync/biome.json # Formatter + linter config
sqlite-sync/tsconfig.json # Root TypeScript config with project references
```

## Technology Stack

Package manager - pnpm
Formatter/linter - biome
Testing - vitest

### Code Quality

```bash
pnpm format # Format + lint fix with Biome
pnpm typecheck # Type-check all packages (recursive)
pnpm build # Build all packages and apps (recursive)
```

### Publishing

```bash
pnpm version:* # Bump patch/minor/major version across packages
pnpm publish:dry # Dry-run publish
pnpm publish:packages # Publish all packages to npm
```
