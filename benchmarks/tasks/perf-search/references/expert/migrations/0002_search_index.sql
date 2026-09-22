-- Search filtered products with a leading-wildcard ILIKE on name/description,
-- which cannot use a plain btree index. pg_trgm gives us trigram indexes that
-- ILIKE '%term%' can actually use, turning a full table scan into an index
-- scan. CONCURRENTLY avoids locking a live table regardless.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_name_trgm ON products USING gin (name gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_description_trgm ON products USING gin (description gin_trgm_ops);
