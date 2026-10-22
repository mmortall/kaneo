import { readdirSync, readFileSync } from "node:fs";
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
      "ADD COLUMN \"work_item_type\" text DEFAULT 'task' NOT NULL",
    );
    expect(migration).toContain('WHEN "description" LIKE \'%"level":"epic"%\'');
    expect(migration).toContain(
      'WHEN "description" LIKE \'%"level":"sub-epic"%\'',
    );
    expect(migration).toContain("IN ('task', 'epic', 'sub_epic')");
    expect(migration).toContain("WHERE \"relation_type\" = 'subtask'");
  });

  it("has a journal entry for every migration file and no dangling entries", () => {
    const journal = JSON.parse(
      readFileSync(
        new URL(
          "../../../apps/api/drizzle/meta/_journal.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { entries: Array<{ tag: string }> };
    const migrationFiles = new Set(
      readdirSync(new URL("../../../apps/api/drizzle/", import.meta.url))
        .filter((file) => file.endsWith(".sql"))
        .map((file) => file.slice(0, -4)),
    );

    expect(journal.entries.map((entry) => entry.tag)).toEqual(
      expect.arrayContaining([...migrationFiles]),
    );
    expect(
      journal.entries.every((entry) => migrationFiles.has(entry.tag)),
    ).toBe(true);
  });
});
