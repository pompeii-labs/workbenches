# api

Hono API on Bun, backed by Lux.

## Running locally

`bun run start` starts the API on `PORT` (default 3000): set it to run more
than one instance against the same Lux project. `RATE_LIMIT_MAX_INVITES` and
`RATE_LIMIT_WINDOW_SECONDS` (see `src/utils/config.ts`) control the invite
rate limit and can be shortened for testing.
