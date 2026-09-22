# Zero-downtime schema changes

First: check the table's row count and how the live app reads and writes it. Size and query pattern decide the technique, not habit.

Rules that do not bend:

- Never combine a table-wide lock with a slow statement. Adding a column with a constant default is instant in Postgres 11+ (metadata only); a volatile default or a type change rewrites the table under `ACCESS EXCLUSIVE`.
- Build indexes with `CREATE INDEX CONCURRENTLY`. It cannot run inside a transaction block; check how the project's migration runner wraps statements and give it its own.
- Add constraints `NOT VALID`, then `VALIDATE CONSTRAINT` separately.
- Changing a column's type or name: expand then contract, finished in this change. Add the new column, sync both with a trigger, backfill in small batched transactions, then cut over (swap the names or repoint the app) so the request is done when your migration completes. Only dropping the old column may wait for a later deploy. A migration that stops at the shadow column has not moved anything. See the expand-contract skill for the recipe.
- `SET lock_timeout` before DDL on a live table, so a blocked statement errors instead of queuing behind it and blocking everyone.
- Backfill in batches (id ranges), each own short transaction. One giant UPDATE bloats the table and holds locks longer than needed.

Before finishing: run `migrate-rehearse` against the pending migrations. Fix anything it reports. Use `pg-locks` on risky statements. Stop once rehearsal is clean; don't add tests or docs nobody asked for. If either tool errors, skip it and verify by hand with `EXPLAIN`/`lock_timeout`; never build shims, install packages, or edit the tools.
