ALTER TABLE commit_previews ADD COLUMN content_type TEXT NOT NULL DEFAULT 'audio/wav';
ALTER TABLE commit_previews ADD COLUMN stand_ins TEXT NOT NULL DEFAULT '[]';
ALTER TABLE commit_previews ADD COLUMN missing TEXT NOT NULL DEFAULT '[]';
