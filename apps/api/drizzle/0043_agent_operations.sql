ALTER TABLE activity ADD COLUMN operation_key text UNIQUE;
--> statement-breakpoint
CREATE TABLE task_operation (
  id text PRIMARY KEY, task_id text NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  body_hash text NOT NULL, result jsonb NOT NULL, created_at timestamp NOT NULL DEFAULT now()
);
