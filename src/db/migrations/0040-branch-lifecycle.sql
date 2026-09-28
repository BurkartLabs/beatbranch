ALTER TABLE branches ADD COLUMN deleted_at BIGINT;
ALTER TABLE branches ADD COLUMN created_from TEXT REFERENCES commits (id);
ALTER TABLE branches DROP CONSTRAINT branches_project_id_name_key;
CREATE UNIQUE INDEX branches_live_name ON branches (project_id, name) WHERE deleted_at IS NULL;
