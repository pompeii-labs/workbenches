-- Half a fix, kept as a calibration reference for the memory gate: indexes
-- make the query itself quick, but the handler is untouched and still pulls
-- every matching row into the server and sorts it there.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_name_trgm ON products USING gin (name gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_description_trgm ON products USING gin (description gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_items_product_id ON order_items (product_id);
