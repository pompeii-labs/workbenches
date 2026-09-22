---
name: sql-n-plus-one
description: "Use when perf-audit shows SQL statement counts scaling with the number of rows (a loop issuing one query per row), or when picking an index for a slow filter/sort/text search."
---

# Collapsing N+1 and picking the right index

## Spot it

`perf-audit` groups statements by normalized query. If one query's `calls`
scales with row count (one per parent row, one per child row), that is the
loop. Find the code issuing it inside a `for`/`.map`/`.forEach` over a prior
result set.

## Collapse it

Turn "one query per parent row, one query per child row" into one query with
a JOIN and aggregation. For a parent-with-children listing:

```sql
SELECT t.id, t.subject,
       coalesce(json_agg(json_build_object(
           'author', u.handle, 'body', r.body
       ) ORDER BY r.id) FILTER (WHERE r.id IS NOT NULL), '[]') AS replies
FROM threads t
LEFT JOIN replies r ON r.thread_id = t.id
LEFT JOIN users u ON u.id = r.author_id
WHERE t.forum_id = $1
GROUP BY t.id
ORDER BY t.id DESC
LIMIT 20;
```

For a running total, a separate aggregate query beats folding it into the
above (avoids double-counting through the join):

```sql
SELECT count(DISTINCT t.id), count(r.id)
FROM threads t JOIN replies r ON r.thread_id = t.id
WHERE t.forum_id = $1;
```

## Read EXPLAIN before adding an index

```
EXPLAIN ANALYZE SELECT ...;
```

`Seq Scan` on a filter column with high row count means add a btree index on
that column. `Sort` with a high cost means add the sort column to the index
(or make it the leading column if it is also the filter). Confirm after: the
plan should show `Index Scan` or `Index Only Scan`, not `Seq Scan`.

## Text search (`ILIKE '%term%'`)

A leading wildcard defeats a plain btree index. Use trigram:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY idx_threads_subject_trgm ON threads USING gin (subject gin_trgm_ops);
```

## Keyset pagination beats OFFSET at scale

```sql
SELECT * FROM threads WHERE id > $1 ORDER BY id LIMIT 20; -- next page
```

`OFFSET 100000` still scans and discards 100000 rows; keyset pagination does
not.

## Live tables: build indexes without locking writes

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_threads_forum_id ON threads (forum_id);
```

`CONCURRENTLY` cannot run inside a transaction block; give it its own
statement, not wrapped in `BEGIN`/`COMMIT`.
