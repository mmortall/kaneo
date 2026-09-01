ALTER TABLE "task" ADD COLUMN "task_category" text DEFAULT 'live_implementation' NOT NULL;--> statement-breakpoint
CREATE INDEX "task_taskCategory_idx" ON "task" USING btree ("task_category");
