# orders-service

Small internal HTTP API over users, orders, and events, backed by Postgres.

## Run it

```
docker compose up -d
bun install
bun run migrate
bun run dev
```

The server listens on :3000.

- `POST /users` - create a user (`fullname`, `email`)
- `POST /orders` - create an order (`userId`, `amountCents`)
- `GET /orders` - list recent orders, optionally `?status=`
- `POST /events` - record an event (`userId`, `kind`)

## Migrations

Plain SQL files in `migrations/`, applied in filename order by `bun run migrate`.
Applied migrations are tracked in a `schema_migrations` table. Add a new file
with the next number prefix; do not edit an already-applied migration.

## Checks

`bun run check` runs the TypeScript type checker.
