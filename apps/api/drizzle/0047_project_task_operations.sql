CREATE TABLE project_task_operation (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  user_id text NOT NULL,
  body_hash text NOT NULL,
  intent jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  expires_at timestamp NOT NULL,
  applied_at timestamp
);
--> statement-breakpoint
CREATE INDEX project_task_operation_project_id_idx ON project_task_operation(project_id);
