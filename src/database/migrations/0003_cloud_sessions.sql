CREATE TABLE cloud_sessions (
    session_id TEXT PRIMARY KEY,
    latest_run_id TEXT NOT NULL UNIQUE,
    organization TEXT NOT NULL,
    project_id INTEGER NOT NULL REFERENCES projects (id),
    workbench TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;
CREATE INDEX cloud_sessions_project_id ON cloud_sessions (project_id);
