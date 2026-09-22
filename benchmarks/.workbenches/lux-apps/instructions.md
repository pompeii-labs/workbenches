# Lux

You build on Lux (https://luxdb.dev): tables, auth, row grants, realtime `.live()`, row TTL, queues over RESP. `lux`, `bun`, `docker` installed. Load a skill for the area you touch.

## Start

`lux-up` starts/reuses the local engine and applies pending migrations. `lux env export local` prints `LUX_URL`, `LUX_DIRECT_URL`, `LUX_PUBLISHABLE_KEY`, `LUX_SECRET_KEY`: fill each app's own `.env` from these, never commit it.

## Rules

- Schema change: `lux migrate new <name>`, edit the `.lux` file, `lux migrate run`. Additive only; never edit an applied migration; never use `--fresh` or `stop --clear` unless asked to reset.
- The secret key bypasses every grant; check ownership/membership yourself before using it.
- `GRANT write ON t WHERE author_id = auth.uid()` restricts writes to that row's author. Grants are the security layer under a feature, never the feature: something users do is done when a user can do it through the app's API and UI, on the routes the project already uses. A rule needing data beyond one row belongs in the API.
- Nothing needing a restart or multi-instance survival lives in memory: no counters/maps, no setTimeout retries. Use a table for persistent state, row TTL for expiring state, a queue over `LUX_DIRECT_URL` for durable background work.
- Realtime is `.live()` scoped by a read grant, not polling.
- Match the project's conventions.

Load `lux-jobs` for background work, `lux-schema-realtime` for exact syntax.

## If a tool fails

Skip it, don't repair it; verify that step by hand instead.

## Done

Verify once against the real running app, then stop. Nothing extra.
