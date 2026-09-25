-- Expand: add the new column, keep it in sync with a trigger, backfill it
-- in id-range batches, prove it NOT NULL without a table scan under lock,
-- then contract by swapping it in under a short, lock-timeout-bounded
-- transaction. Never runs ALTER COLUMN TYPE, which would rewrite the whole
-- table under ACCESS EXCLUSIVE.

SET lock_timeout = '2s';

ALTER TABLE events ADD COLUMN user_id_new bigint;

CREATE OR REPLACE FUNCTION events_sync_user_id_bigint() RETURNS trigger AS $$
BEGIN
    NEW.user_id_new := NEW.user_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_sync_user_id_bigint_trigger
    BEFORE INSERT OR UPDATE ON events
    FOR EACH ROW EXECUTE FUNCTION events_sync_user_id_bigint();

-- Backfill by primary-key range, each batch its own short transaction, so
-- no long-running UPDATE holds locks or bloats the table, and each batch
-- touches a fixed slice instead of re-scanning for rows not yet copied.
CREATE OR REPLACE PROCEDURE events_backfill_user_id_bigint() AS $$
DECLARE
    batch CONSTANT integer := 50000;
    lo integer;
    hi integer;
BEGIN
    SELECT min(id), max(id) INTO lo, hi FROM events;
    IF lo IS NULL THEN RETURN; END IF;
    WHILE lo <= hi LOOP
        UPDATE events SET user_id_new = user_id
        WHERE id >= lo AND id < lo + batch AND user_id_new IS NULL;
        COMMIT;
        lo := lo + batch;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

CALL events_backfill_user_id_bigint();
DROP PROCEDURE events_backfill_user_id_bigint();

CREATE INDEX CONCURRENTLY idx_events_user_id_new ON events (user_id_new);

-- NOT NULL without a scan under ACCESS EXCLUSIVE: a NOT VALID check is
-- instant, VALIDATE scans with only a SHARE UPDATE EXCLUSIVE lock, and
-- Postgres 12+ uses the validated check to set NOT NULL without rescanning.
ALTER TABLE events ADD CONSTRAINT events_user_id_new_not_null
    CHECK (user_id_new IS NOT NULL) NOT VALID;
ALTER TABLE events VALIDATE CONSTRAINT events_user_id_new_not_null;
ALTER TABLE events ALTER COLUMN user_id_new SET NOT NULL;
ALTER TABLE events DROP CONSTRAINT events_user_id_new_not_null;

BEGIN;
DROP TRIGGER events_sync_user_id_bigint_trigger ON events;
ALTER TABLE events DROP COLUMN user_id;
ALTER TABLE events RENAME COLUMN user_id_new TO user_id;
ALTER INDEX idx_events_user_id_new RENAME TO idx_events_user_id;
COMMIT;

DROP FUNCTION events_sync_user_id_bigint();
