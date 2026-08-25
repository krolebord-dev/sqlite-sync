# SQLITE-SYNC Monorepo

## Project Overview

**sqlite-sync** is an offline-first SQLite synchronization library with CRDT (Conflict-free Replicated Data Type) support. It enables local-first applications where all writes happen locally and sync automatically to remote servers via event-based replication.

The project is a **pnpm monorepo** containing published packages and applications.

## App-Specific Docs

- [Library docs](docs.md) - full docs for using @sqlite-sync in apps
- [Watchlist App](apps/watchlist/AGENTS.md) — production app with TanStack Router, oRPC, Cloudflare D1, and per-list CRDT sync

## Repository Structure

```
sqlite-sync/packages/core/ # @sqlite-sync/core - Core sync engine, CRDT, HLC, migrations
sqlite-sync/packages/react/ # @sqlite-sync/react - React hooks and context bindings
sqlite-sync/packages/cloudflare/ # @sqlite-sync/cloudflare - Durable Objects adapter, D1 executor
sqlite-sync/packages/ai/ # @sqlite-sync/ai - AI agent tools (schema doc + AI SDK ToolSet) for synced DBs
sqlite-sync/apps/example/ # Demo todo app (Vite + React + Cloudflare Workers)
sqlite-sync/apps/watchlist/ # App for managing "watch later" lists (TanStack Router + oRPC + Cloudflare D1)
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

## Cursor Cloud specific instructions

Dependencies are installed automatically on startup via `pnpm install`. Node 22 + pnpm 10.28.1.

### Tests require a build first

`pnpm test` runs Vitest only over `packages/**`. The `@sqlite-sync/ai` tests import `@sqlite-sync/core` by its package entry, so they fail with "Failed to resolve entry for package" unless the packages are built. Run `pnpm build` (or at least build `core`) before `pnpm test`. `pnpm format:check` and `pnpm typecheck` work without building.

### Running the apps (dev mode)

- **example** (offline-first todo demo): `pnpm dev` (Vite frontend on :5173) and, for sync, `pnpm dev:server` (Wrangler/Durable Object sync server on :8787, local miniflare — no Cloudflare account needed). The frontend hardcodes the sync host `localhost:8787` (`apps/example/src/db-worker.ts`); the app still works offline without the server.
- **watchlist** (`pnpm --filter watchlist dev`, :3000): single Vite + Cloudflare Worker process via `@cloudflare/vite-plugin` (local D1 + Durable Objects in miniflare). Requires local setup below before first run.

### Watchlist local setup (required, not obvious)

1. Migrate the local D1 DB once: `pnpm --filter watchlist db:local:init` then `pnpm --filter watchlist db:local:migrate`.
2. Create `apps/watchlist/.dev.vars` (read by the Worker; `src/lib/context.ts` does `envSchema.parse(env)` at boot, so these must be present — placeholders are fine for local dev):
   ```
   MODE=development
   VITE_APP_URL=http://localhost:3000
   AUTH_SECRET=dev-local-auth-secret-placeholder-0123456789
   GOOGLE_CLIENT_ID=dev-google-client-id
   GOOGLE_CLIENT_SECRET=dev-google-client-secret
   TWITCH_CLIENT_ID=dev-twitch-client-id
   TWITCH_CLIENT_SECRET=dev-twitch-client-secret
   ```
3. Create `apps/watchlist/.env.local` (read by the Vite **client** — `src/orpc/orpc-client.ts` uses `import.meta.env.VITE_APP_URL`; without it the app crashes with "Failed to construct 'URL': Invalid URL"). Note `.env.local` is gitignored:
   ```
   VITE_APP_URL=http://localhost:3000
   ```

### Watchlist login without external services

Magic-link login works fully locally with no Resend key: the OTP is written to the local D1 `verification` table (and logged to the Worker console). Read it with:
`pnpm --filter watchlist exec wrangler d1 execute watchlist-admin --local --command "SELECT target, value FROM verification;"`, then enter the code on the `/magic-link-verify` page. TMDB (`TMDB_READ_ACCESS_TOKEN`), OpenRouter (`OPENROUTER_API_KEY`), Workers AI, Resend, and Google/Twitch OAuth only matter for those specific features (item search, AI recommendations, email, OAuth login); the core auth + list + per-list CRDT sync flow works without them.
