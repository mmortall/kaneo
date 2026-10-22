CREATE TABLE task_group_event (
  id text PRIMARY KEY,
  operation_id text NOT NULL REFERENCES project_task_operation(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token text,
  lease_until timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX task_group_event_pending_idx ON task_group_event(next_attempt_at, id) WHERE delivered_at IS NULL;
--> statement-breakpoint
CREATE INDEX task_group_event_operation_idx ON task_group_event(operation_id);
--> statement-breakpoint
ALTER TABLE notification ADD COLUMN operation_key text UNIQUE;
