CREATE TABLE studio (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    server_pid INTEGER NOT NULL,
    api_port INTEGER NOT NULL,
    ui_port INTEGER NOT NULL,
    container_id TEXT NOT NULL,
    token TEXT NOT NULL,
    image TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE studio_commands (
    run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, idempotency_key)
) STRICT;

ALTER TABLE runs ADD COLUMN task TEXT;
