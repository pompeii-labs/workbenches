CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_at TEXT NOT NULL
) STRICT;

ALTER TABLE sessions ADD COLUMN project_id INTEGER REFERENCES projects (id);
CREATE INDEX sessions_project_id ON sessions (project_id);
