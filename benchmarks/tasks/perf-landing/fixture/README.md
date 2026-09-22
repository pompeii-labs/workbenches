# corner-store

A small storefront: customers, products, orders, and order items, served by a
plain Bun HTTP server over Postgres. Server-rendered pages with a little
vanilla JS and CSS.

## Run it

```
docker compose up -d
bun install
bun run migrate
bun run seed
bun run dev
```

The server listens on :3000.

- `GET /` - landing page
- `GET /dashboard/:customerId` - a customer's order history and totals
- `GET /search?q=` - product search

## Migrations

Plain SQL files in `migrations/`, applied in filename order by `bun run migrate`.
Applied migrations are tracked in a `schema_migrations` table. Add a new file
with the next number prefix; do not edit an already-applied migration.

## Checks

`bun run check` runs the TypeScript type checker.
