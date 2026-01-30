# Watchlist App

> See also: [root CLAUDE.md](../../CLAUDE.md) for monorepo-wide conventions, build commands, and sync architecture.

Production watchlist application built with TanStack Router, oRPC, and Cloudflare D1. Uses `@sqlite-sync/*` packages for offline-first per-list sync via CRDT events and Durable Objects.

## Commands

```bash
pnpm --filter watchlist dev               # Dev server on port 3000
pnpm --filter watchlist build             # Build for production
pnpm --filter watchlist deploy            # Build + wrangler deploy
pnpm --filter watchlist test              # Run tests (vitest)
pnpm --filter watchlist typecheck         # Type-check
```

### Database

```bash
pnpm --filter watchlist db:local:init          # Initialize local D1
pnpm --filter watchlist db:local:migrate       # Apply D1 migrations locally
pnpm --filter watchlist db:new-migration       # Create new D1 migration
pnpm --filter watchlist generate:types:db      # Generate Kysely types from D1
pnpm --filter watchlist generate:types:env     # Generate Wrangler env types
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Routing | TanStack Router (file-based) |
| Data Fetching | TanStack React Query + oRPC |
| UI | Shadcn/UI (Radix primitives + Tailwind CSS 4) |
| State | Jotai (atomic), React Query (server), sync DB (local) |
| Auth | Magic link + OAuth (Google, Twitch) via `arctic` |
| AI | Vercel AI SDK + OpenRouter / Workers AI |
| Server | Cloudflare Workers + D1 + Durable Objects |
| Testing | Vitest + Testing Library |

## Source Structure

```
src/
├── server.ts                  # Cloudflare Worker entry point
├── main.tsx                   # React entry point
├── routeTree.gen.ts           # Auto-generated route tree (do not edit)
├── routes/                    # TanStack file-based routing
│   ├── __root.tsx             #   Root layout with providers
│   ├── _auth/                 #   Public auth routes
│   │   ├── sign-in.tsx        #     Sign-in page
│   │   └── magic-link-verify.tsx
│   └── _app/                  #   Authenticated routes (auth guard in route.tsx)
│       ├── route.tsx          #     Auth loader
│       ├── index.tsx          #     Home / list selection
│       └── list.$id/          #     Dynamic list detail route
├── components/                # React components
│   └── ui/                    #   Shadcn/UI primitives (configured via components.json)
├── orpc/                      # Backend API (oRPC)
│   ├── orpc-client.ts         #   Typed client setup
│   ├── orpc-router.ts         #   Main router definition
│   └── routers/
│       ├── auth.router.ts     #   Auth: signUp, verify, getAuth, signOut
│       ├── list.router.ts     #   Lists: getLists, getList, getListWithMembers
│       └── search.router.ts   #   TMDB search
├── list-db/                   # Per-list sync DB (Durable Objects)
│   ├── list-db-server.ts      #   Durable Object class
│   ├── list-db.ts             #   Client initialization
│   ├── migrations.ts          #   List item CRDT schema
│   ├── list-db-router.ts      #   oRPC router for list-db
│   ├── list-orpc-client.ts    #   Client setup
│   ├── list-worker.ts         #   Web Worker entry
│   └── routers/
│       ├── ai-suggestions.ts  #   AI tag suggestions
│       ├── list-settings.ts   #   Per-list settings
│       └── orpc-base.ts       #   Base oRPC context
├── api/                       # REST endpoints
│   ├── api-handler.ts         #   Route dispatcher
│   └── handlers/
│       └── callback.google.ts #   OAuth callback
├── ai/                        # AI features
│   ├── suggest-tags.ts        #   Tag generation logic
│   └── prompts/
│       └── classifier.prompt.ts
├── lib/                       # Utilities
│   ├── db.ts                  #   Kysely D1 instance
│   ├── context.ts             #   Environment variable types
│   ├── db-types.ts            #   Generated DB types (kysely-codegen)
│   ├── auth-client.ts         #   Auth hooks
│   ├── tmdb.ts                #   TMDB API client
│   └── utils.ts               #   General utilities
├── migrations/                # Server D1 migrations (Wrangler-managed)
│   ├── 0001_init_auth.sql     #   User, session, verification tables
│   └── 0002_add_lists.sql     #   List, user_to_list tables
└── public/                    # Static assets
```

## Request Routing

- `/rpc/*` → oRPC API handlers
- `/api/*` → REST endpoints (OAuth callbacks)
- `/list-db/*` → Durable Object routing (per-list sync)
- `/*` → Frontend SPA (Vite)

## Conventions

- **Routing**: File-based via TanStack Router. `routeTree.gen.ts` is auto-generated — never edit it manually.
- **API**: oRPC routers in `src/orpc/routers/`. Typed client in `src/orpc/orpc-client.ts`.
- **Components**: Shadcn/UI in `src/components/ui/`, configured via `components.json`.
- **Database types**: Generated with `kysely-codegen` to `src/lib/db-types.ts`. Re-generate after migration changes.
- **Server migrations**: SQL files in `src/migrations/`, managed by Wrangler D1.
- **Per-list sync DB**: CRDT table schemas in `src/list-db/migrations.ts`, using `makeCrdtTable()` from core.
- **Generated files**: `*.gen.ts` files are auto-generated and excluded from Biome.

## Environment Variables

Required bindings (configured in `wrangler.jsonc`):

| Variable | Purpose |
|----------|---------|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth |
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | Twitch OAuth |
| `AUTH_SECRET` | Session signing |
| `RESEND_API_KEY` | Email delivery (optional) |
| `VITE_APP_URL` | Public app URL |
| `MODE` | `"development"` or `"production"` |

Cloudflare bindings:
- **D1**: `watchlist-admin`
- **Durable Object**: `ListDbServer`
- **AI**: Remote inference binding
