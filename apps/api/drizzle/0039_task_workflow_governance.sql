ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "goal" text;
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "acceptance_criteria" text;
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "blocked_reason" text;
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "unblock_policy" text;
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "completion_summary" text;
