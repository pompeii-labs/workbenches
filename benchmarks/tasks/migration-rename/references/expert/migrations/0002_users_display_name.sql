-- Expand/contract rename: add the new column, keep both names in sync with a
-- trigger, backfill, then leave both columns live so an old app version
-- (reads/writes fullname) and a new one (reads/writes display_name) both
-- keep working through the rollout. A bare RENAME COLUMN would break the old
-- version the instant it ran.

ALTER TABLE users ADD COLUMN display_name text;

CREATE OR REPLACE FUNCTION users_sync_display_name() RETURNS trigger AS $$
BEGIN
    IF NEW.display_name IS DISTINCT FROM OLD.display_name AND
       (TG_OP = 'INSERT' OR NEW.display_name IS DISTINCT FROM OLD.display_name) THEN
        -- Whichever side changed last wins; both columns end up equal.
        NULL;
    END IF;
    IF TG_OP = 'INSERT' THEN
        NEW.display_name := COALESCE(NEW.display_name, NEW.fullname);
        NEW.fullname := COALESCE(NEW.fullname, NEW.display_name);
    ELSE
        IF NEW.fullname IS DISTINCT FROM OLD.fullname THEN
            NEW.display_name := NEW.fullname;
        ELSIF NEW.display_name IS DISTINCT FROM OLD.display_name THEN
            NEW.fullname := NEW.display_name;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_sync_display_name_trigger
    BEFORE INSERT OR UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION users_sync_display_name();

UPDATE users SET display_name = fullname WHERE display_name IS NULL;
