ALTER TABLE task ADD COLUMN managed_key text;
--> statement-breakpoint
ALTER TABLE task ADD COLUMN version integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE task ADD CONSTRAINT task_project_managed_key_unique UNIQUE (project_id, managed_key);
--> statement-breakpoint
CREATE FUNCTION kaneo_task_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER task_revision BEFORE UPDATE ON task FOR EACH ROW EXECUTE FUNCTION kaneo_task_revision();
--> statement-breakpoint
CREATE FUNCTION kaneo_marker_key(description text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE marker text;
BEGIN
  marker := substring(description FROM '<!-- kaneo-managed:(\{[^\n]*\}) -->');
  RETURN (marker::jsonb)->>'key';
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
--> statement-breakpoint
WITH candidates AS (
  SELECT id, project_id, kaneo_marker_key(description) AS key FROM task
), unique_keys AS (
  SELECT project_id, key FROM candidates WHERE key IS NOT NULL AND btrim(key) <> ''
  GROUP BY project_id, key HAVING count(*) = 1
)
UPDATE task SET managed_key = candidates.key FROM candidates JOIN unique_keys USING (project_id, key)
WHERE task.id = candidates.id;
--> statement-breakpoint
DROP FUNCTION kaneo_marker_key(text);
