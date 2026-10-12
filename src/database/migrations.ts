/**
 * Append-only schema history. A migration, once shipped, is never edited: add
 * the next number instead. Migrations are embedded so the compiled binary
 * carries them. `PRAGMA user_version` records the last one applied.
 */
export interface Migration {
    version: number;
    name: string;
    sql: string;
}

export const migrations: readonly Migration[] = [
    {
        version: 1,
        name: 'initial',
        sql: `
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    name TEXT,
    workbench TEXT NOT NULL,
    workbench_version TEXT NOT NULL,
    runner TEXT NOT NULL,
    model TEXT NOT NULL,
    runtime TEXT NOT NULL,
    reference TEXT NOT NULL,
    workbench_path TEXT NOT NULL,
    source_workbench_path TEXT,
    workbench_digest TEXT,
    workspace TEXT NOT NULL,
    repository TEXT,
    workspaces TEXT NOT NULL,
    registry TEXT,
    allow_unchecked_gpu INTEGER,
    native_path TEXT NOT NULL,
    native_session_id TEXT,
    latest_run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX sessions_updated_at ON sessions (updated_at);

CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    workbench TEXT NOT NULL,
    workbench_version TEXT NOT NULL,
    runner TEXT NOT NULL,
    model TEXT NOT NULL,
    runtime TEXT,
    workspace TEXT NOT NULL,
    repository TEXT,
    mode TEXT,
    execution TEXT,
    workspaces TEXT,
    allow_host_docker INTEGER,
    registry TEXT,
    registry_event_id TEXT,
    dispatched_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    pid INTEGER,
    runner_session_id TEXT,
    session_id TEXT,
    resumed_from TEXT,
    exit_code INTEGER,
    outcome_id TEXT
) STRICT;
CREATE INDEX runs_dispatched_at ON runs (dispatched_at);
CREATE INDEX runs_session_id ON runs (session_id);

CREATE TABLE run_requests (
    run_id TEXT PRIMARY KEY REFERENCES runs (id) ON DELETE CASCADE,
    request TEXT NOT NULL
) STRICT;

CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    payload TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX events_run_sequence ON events (run_id, sequence);
CREATE INDEX events_run_cursor ON events (run_id, id);

CREATE TABLE control_requests (
    ordinal INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'active')),
    payload TEXT NOT NULL
) STRICT;
CREATE INDEX control_requests_queue ON control_requests (run_id, state, ordinal);

CREATE TABLE control_receipts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    payload TEXT NOT NULL
) STRICT;

CREATE TABLE leases (
    name TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    pid INTEGER NOT NULL,
    acquired_at INTEGER NOT NULL
) STRICT;

CREATE TABLE run_status (
    run_id TEXT PRIMARY KEY REFERENCES runs (id) ON DELETE CASCADE,
    last_event INTEGER NOT NULL,
    fold TEXT NOT NULL
) STRICT;

CREATE TABLE repository_receipts (
    scope TEXT NOT NULL CHECK (scope IN ('run', 'session')),
    id TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (scope, id)
) STRICT;

CREATE TABLE repository_checkouts (
    session_id TEXT PRIMARY KEY,
    binding TEXT NOT NULL
) STRICT;

CREATE TABLE notices (
    name TEXT PRIMARY KEY,
    shown_at TEXT NOT NULL
) STRICT;
`,
    },
];
