DROP INDEX sessions_project_id;
ALTER TABLE sessions DROP COLUMN project_id;
DROP TABLE projects;
