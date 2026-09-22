---
name: expand-contract
description: "Use when a migration changes an existing column's type or name (not just adding a new column) on a table the live app already reads and writes."
---

# Expand/contract for type changes and renames

A bare `ALTER COLUMN ... TYPE` or `RENAME COLUMN` either rewrites the table under
`ACCESS EXCLUSIVE` or breaks whichever app version does not know the new name yet.
Do it in three small steps instead, each fast and reversible.

## 1. Expand

Add the new column, nullable, no default (metadata only, instant):

```sql
ALTER TABLE shipments ADD COLUMN carrier_ref_new bigint;
```

Keep both columns in sync going forward with a trigger:

```sql
CREATE OR REPLACE FUNCTION shipments_sync_carrier_ref() RETURNS trigger AS $$
BEGIN
    NEW.carrier_ref_new := NEW.carrier_ref;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER shipments_sync_carrier_ref_trigger
    BEFORE INSERT OR UPDATE ON shipments
    FOR EACH ROW EXECUTE FUNCTION shipments_sync_carrier_ref();
```

For a rename where both the old and new app versions must work mid-rollout
(not just a type change), make the trigger bidirectional: on INSERT, coalesce
each column from the other; on UPDATE, copy whichever column actually
changed into the other. Do not drop the old column in this migration: the
old app version still needs it.

## 2. Backfill

In small batches, each its own short transaction, not one giant UPDATE:

```sql
UPDATE shipments SET carrier_ref_new = carrier_ref
WHERE id BETWEEN :batch_start AND :batch_end AND carrier_ref_new IS NULL;
```

Build any index the new column needs with `CREATE INDEX CONCURRENTLY` after
the backfill, not before (a full index build during backfill just adds
churn).

## 3. Contract

Once nothing reads the old column, cut over in one short transaction with a
lock timeout, dropping the sync trigger in the same transaction so no window
exists where the trigger fires against a column that no longer has a match:

```sql
SET lock_timeout = '2s';
BEGIN;
DROP TRIGGER shipments_sync_carrier_ref_trigger ON shipments;
ALTER TABLE shipments DROP COLUMN carrier_ref;
ALTER TABLE shipments RENAME COLUMN carrier_ref_new TO carrier_ref;
COMMIT;
```

For a rename kept for compatibility, skip this step entirely until the old
app version is retired; leave both columns live and synced.
