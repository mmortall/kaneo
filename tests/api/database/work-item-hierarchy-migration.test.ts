import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../apps/api/drizzle/0038_chilly_iron_patriot.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("work item hierarchy migration", () => {
  it("adds safe default, legacy backfill, type constraint, and single-parent index", () => {
    expect(migration).toContain(
      'ADD COLUMN "work_item_type" text DEFAULT \'task\' NOT NULL',
    );
    expect(migration).toContain('WHEN "description" LIKE \'%"level":"epic"%\'');
    expect(migration).toContain('WHEN "description" LIKE \'%"level":"sub-epic"%\'');
    expect(migration).toContain("IN ('task', 'epic', 'sub_epic')");
    expect(migration).toContain('WHERE "relation_type" = \'subtask\'');
  });
});
