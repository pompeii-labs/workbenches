CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE,
    slug TEXT NOT NULL COLLATE NOCASE,
    organization TEXT,
    created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX projects_local_name
ON projects (name COLLATE NOCASE) WHERE organization IS NULL;
CREATE UNIQUE INDEX projects_local_slug
ON projects (slug COLLATE NOCASE) WHERE organization IS NULL;
CREATE UNIQUE INDEX projects_organization_name
ON projects (organization, name COLLATE NOCASE) WHERE organization IS NOT NULL;
CREATE UNIQUE INDEX projects_organization_slug
ON projects (organization, slug COLLATE NOCASE) WHERE organization IS NOT NULL;

ALTER TABLE sessions ADD COLUMN project_id INTEGER REFERENCES projects (id);
CREATE INDEX sessions_project_id ON sessions (project_id);

CREATE TABLE project_merges (
    organization TEXT PRIMARY KEY,
    merged_at TEXT NOT NULL
) STRICT;
