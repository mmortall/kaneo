ALTER TABLE "task" ADD COLUMN "work_item_type" text DEFAULT 'task' NOT NULL;--> statement-breakpoint
UPDATE "task"
SET "work_item_type" = CASE
  WHEN "description" LIKE '%"level":"epic"%' THEN 'epic'
  WHEN "description" LIKE '%"level":"sub-epic"%' THEN 'sub_epic'
  ELSE 'task'
END;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_work_item_type_check"
CHECK ("work_item_type" IN ('task', 'epic', 'sub_epic'));--> statement-breakpoint
CREATE INDEX "task_relation_type_source_idx" ON "task_relation" USING btree ("relation_type","source_task_id");--> statement-breakpoint
CREATE INDEX "task_relation_type_target_idx" ON "task_relation" USING btree ("relation_type","target_task_id");--> statement-breakpoint
CREATE INDEX "task_workItemType_idx" ON "task" USING btree ("work_item_type");
--> statement-breakpoint
CREATE UNIQUE INDEX "task_relation_subtask_target_unique"
ON "task_relation" USING btree ("target_task_id")
WHERE "relation_type" = 'subtask';
