---
name: lux-schema-realtime
description: Use when adding/changing Lux tables, columns, grants, TTLs, migrations, regenerating types, or wiring `.live()`, presence, or anything that should expire.
---

# Schema, grants, TTL, and realtime: exact syntax

Migrations are `.lux` files of Lux commands in `lux/migrations/`, one statement per line. Not SQL.

```sh
lux migrate new add_comments   # lux/migrations/<timestamp>_add_comments.lux
lux migrate status             # applied vs pending
lux migrate plan                # preview
lux migrate run                 # apply pending
```

`lux start` also applies pending migrations on boot. Never edit an applied migration or `__migrations`; write a new one. If two `migrate new` land in the same second, rename one so timestamps stay ordered.

## Tables

```
TCREATE documents id UUID PRIMARY KEY DEFAULT uuid(), created_at TIMESTAMP DEFAULT now(), workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE, owner_id STR REFERENCES auth.users(id) ON DELETE CASCADE, title STR NOT NULL
```

- Types: `STR`/`TEXT`, `INT`, `FLOAT`, `BOOL`, `TIMESTAMP` (stored as epoch **milliseconds**), `UUID`, `JSON`, `ARRAY`, `VECTOR(n)`.
- Constraints: `PRIMARY KEY`, `UNIQUE`, `NOT NULL`, `DEFAULT <literal>|uuid()|now()`, `REFERENCES table(col) [ON DELETE CASCADE]`, `ENCRYPTED [SEARCHABLE]`.
- A UUID primary key with no value generates a UUIDv7; an INT primary key auto-increments. User ids are `STR`, from `auth.users(id)`.
- Changing a table that holds data must be additive: `TALTER profiles ADD timezone STR DEFAULT 'UTC'`. Never `TDROP`+recreate to change a table.

## Row TTL

```
TCREATE cursors user_id STR PRIMARY KEY, x INT, y INT WITH TTL 30
```

Or per-write: `{ ttl: seconds }` on insert/upsert. Expiry deletes the row and pushes a `.live()` delete: a row refreshed on every heartbeat is presence; stop writing and it vanishes for everyone. A write that omits `ttl` leaves an existing deadline untouched; `ttl: 0` clears it. This replaces `last_seen` columns, stale filters, and sweeper jobs.

## Grants (row-level security)

```
GRANT read ON documents WHERE workspace_id IN ( SELECT workspace_id FROM members WHERE user_id = auth.uid() )
GRANT read, write ON profiles WHERE id = auth.uid()
REVOKE read ON documents
```

- Auto-filter: the `WHERE` narrows every `.select()`/`.update()`/`.delete()`/`.live()` automatically; callers never restate it. INSERT/UPSERT are checked the same way (can't insert a row that wouldn't match). No grant on a table means 403 for token users.
- Scopes: `read` (SELECT + `.live()`), `write` (INSERT/UPDATE/DELETE). A direct column comparison like `author_id = auth.uid()` **does** correctly restrict writes to that row's author, verified, this is not a limitation. Read and write can be scoped differently (e.g. read = team membership, write = authorship) with two separate GRANT statements.
- Operands: `auth.uid()`, `auth.<claim>`, or a literal. Operators `= != < > <= >=`, `AND`, and `col IN ( SELECT ... )` membership subqueries. No arbitrary cross-row aggregates (counts, rate limits); those need the API.
- Ship the grant in the same migration as the table.

## Types

`lux types` writes `lux/types/database.ts` from the live schema. Re-run after every schema change if the project imports generated types; don't introduce type generation where it doesn't already exist.

## Realtime: `.live()`

```ts
const { live, error } = await lux.table('documents').select().live();
live.on('change', () => invalidate('app:documents'));  // or: snapshot / insert / update / delete
await live.unsubscribe();
```

Needs a signed-in session (publishable key alone is rejected) and a `read` grant. Treat each snapshot as authoritative, keyed by primary key. JSON columns arrive as strings over the live socket: parse at the boundary. Subscribe client-side; clean up on unmount; never poll.
