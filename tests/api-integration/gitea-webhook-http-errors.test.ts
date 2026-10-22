import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { handleGiteaWebhookRoute } from "../../apps/api/src/gitea-integration";
import { recordExternalLinkFieldSync } from "../../apps/api/src/plugins/github/services/link-manager";
import { formatIssueBody } from "../../apps/api/src/plugins/github/utils/format";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const secret = "isolated-test-webhook-secret";
describe("Signed Gitea webhook HTTP errors", () => {
  beforeEach(resetTestDatabase);
  async function fixture() {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [integration] = await db
      .insert(schema.integrationTable)
      .values({
        projectId: project.id,
        type: "gitea",
        config: JSON.stringify({
          baseUrl: "https://gitea.test",
          accessToken: "unused-test-token",
          repositoryOwner: "owner",
          repositoryName: "repo",
          webhookSecret: secret,
        }),
      })
      .returning();
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Local title",
        description: "Body",
        status: "to-do",
      })
      .returning();
    const [link] = await db
      .insert(schema.externalLinkTable)
      .values({
        taskId: task!.id,
        integrationId: integration!.id,
        resourceType: "issue",
        externalId: "1",
        url: "https://gitea.test/owner/repo/issues/1",
        metadata: "{}",
      })
      .returning();
    const payload = {
      action: "edited",
      issue: {
        number: 1,
        title: "Remote title",
        body: "Body",
        html_url: link!.url,
      },
      changes: { title: { from: "Local title" } },
      repository: {
        owner: { login: "owner" },
        name: "repo",
        html_url: "https://gitea.test/owner/repo",
      },
    };
    const app = new Hono().post(
      "/webhook/:integrationId",
      handleGiteaWebhookRoute,
    );
    const send = (
      body = JSON.stringify(payload),
      options: { signature?: string; event?: string; id?: string } = {},
    ) =>
      app.request(`/webhook/${options.id ?? integration!.id}`, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-gitea-signature":
            options.signature ??
            createHmac("sha256", secret).update(body).digest("hex"),
          "x-gitea-event": options.event ?? "issues",
        },
      });
    const row = () =>
      db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, task!.id),
      });
    const readLink = () =>
      db.query.externalLinkTable.findFirst({
        where: eq(schema.externalLinkTable.id, link!.id),
      });
    return {
      integration: integration!,
      task: task!,
      payload,
      link: link!,
      send,
      row,
      readLink,
    };
  }
  it("signed edit follows actual discovery and updates task/metadata; identical retry preserves revision", async () => {
    const { task, send, row, readLink } = await fixture();
    expect((await send()).status).toBe(200);
    const after = await row();
    expect(after!.title).toBe("Remote title");
    expect(after!.version).toBe(task.version + 1);
    expect(JSON.parse((await readLink())!.metadata!)).toMatchObject({
      lastSync: { title: { source: "gitea", value: "Remote title" } },
    });
    const syncedLink = await readLink();
    expect((await send()).status).toBe(200);
    expect(await row()).toEqual(after);
    expect(await readLink()).toEqual(syncedLink);
  });
  it("signed divergent edit returns structured409 and preserves exact task and link", async () => {
    const { task, link, payload, send, row, readLink } = await fixture();
    const response = await send(
      JSON.stringify({
        ...payload,
        changes: { title: { from: "Different provider title" } },
      }),
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      error: "TASK_CONFLICT",
      field: "title",
      currentVersion: task.version,
    });
    expect(await row()).toEqual(task);
    expect(await readLink()).toEqual(link);
  });
  it("signed outgoing body echo with generated footer preserves task and metadata", async () => {
    const { task, integration, link, payload, send, row, readLink } =
      await fixture();
    await recordExternalLinkFieldSync({
      linkId: link.id,
      taskId: task.id,
      integrationId: integration.id,
      externalId: "1",
      field: "description",
      value: task.description!,
    });
    const beforeLink = await readLink();
    const response = await send(
      JSON.stringify({
        ...payload,
        issue: {
          ...payload.issue,
          body: formatIssueBody(task.description, task.id),
        },
        changes: { body: { from: "Old provider text" } },
      }),
    );
    expect(response.status).toBe(200);
    expect(await row()).toEqual(task);
    expect(await readLink()).toEqual(beforeLink);
  });
  it("signed provider body edit normalizes matching old/new footer and stores user text only", async () => {
    const { task, payload, send, row, readLink } = await fixture();
    const response = await send(
      JSON.stringify({
        ...payload,
        issue: {
          ...payload.issue,
          body: formatIssueBody("Provider body\n\n", task.id),
        },
        changes: { body: { from: formatIssueBody(task.description, task.id) } },
      }),
    );
    expect(response.status).toBe(200);
    const after = await row();
    expect(after).toEqual({
      ...task,
      description: "Provider body\n\n",
      version: task.version + 1,
      updatedAt: after!.updatedAt,
    });
    expect(JSON.parse((await readLink())!.metadata!)).toMatchObject({
      lastSync: {
        description: { source: "gitea", value: "Provider body\n\n" },
      },
    });
  });
  it("invalid signature returns401 before mutation", async () => {
    const { task, send, row } = await fixture();
    expect((await send(undefined, { signature: "invalid" })).status).toBe(401);
    expect(await row()).toEqual(task);
  });
  it.each(["{", "null", "[]", "17"])(
    "signed malformed body %s returns400",
    async (body) => {
      const { task, send, row } = await fixture();
      expect((await send(body)).status).toBe(400);
      expect(await row()).toEqual(task);
    },
  );
  it("missing event returns400 and missing integration returns404", async () => {
    const { task, send, row } = await fixture();
    expect((await send(undefined, { event: "" })).status).toBe(400);
    expect((await send(undefined, { id: "missing" })).status).toBe(404);
    expect(await row()).toEqual(task);
  });
  it.each(["invalid-json", "missing-secret"])(
    "server configuration fault %s returns500",
    async (mode) => {
      const { integration, task, send, row } = await fixture();
      await db
        .update(schema.integrationTable)
        .set({ config: mode === "invalid-json" ? "{" : "{}" })
        .where(eq(schema.integrationTable.id, integration.id));
      expect((await send()).status).toBe(500);
      expect(await row()).toEqual(task);
    },
  );
  it("database handler fault returns sanitized500 and rolls back task", async () => {
    const { task, link, send, row, readLink } = await fixture();
    await db.execute(
      sql.raw(
        "CREATE FUNCTION kaneo_test_fail_task_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Private database detail'; END; $$",
      ),
    );
    try {
      await db.execute(
        sql.raw(
          "CREATE TRIGGER kaneo_test_fail_task_update BEFORE UPDATE ON task FOR EACH ROW EXECUTE FUNCTION kaneo_test_fail_task_update()",
        ),
      );
      const response = await send();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Webhook handler failed",
      });
      expect(await row()).toEqual(task);
      expect(await readLink()).toEqual(link);
    } finally {
      await db.execute(
        sql.raw("DROP TRIGGER IF EXISTS kaneo_test_fail_task_update ON task"),
      );
      await db.execute(sql.raw("DROP FUNCTION kaneo_test_fail_task_update()"));
    }
  });
  it.each(["labeled", "unlabeled", "label_updated", "reopened"])(
    "%s task update fault returns500 without committing labels or link metadata",
    async (action) => {
      const { task, payload, send, row, readLink } = await fixture();
      if (action === "reopened") {
        await db
          .update(schema.taskTable)
          .set({ status: "done" })
          .where(eq(schema.taskTable.id, task.id));
      }
      if (action === "unlabeled" || action === "label_updated") {
        await db.insert(schema.labelTable).values({
          name: "Tag",
          color: "#aaaaaa",
          taskId: task.id,
          workspaceId: (await db.query.projectTable.findFirst({
            where: eq(schema.projectTable.id, task.projectId),
          }))!.workspaceId,
        });
      }
      const before = await row();
      const beforeLink = await readLink();
      const beforeLabels = await db.select().from(schema.labelTable);
      const event = {
        ...payload,
        action,
        label: { name: "Tag", color: "bbbbbb" },
        issue: {
          ...payload.issue,
          state: "open",
          labels:
            action === "label_updated"
              ? [{ name: "Tag", color: "bbbbbb" }]
              : [],
        },
      };
      await db.execute(
        sql.raw(
          "CREATE FUNCTION kaneo_test_fail_task_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Private database detail'; END; $$",
        ),
      );
      try {
        await db.execute(
          sql.raw(
            "CREATE TRIGGER kaneo_test_fail_task_update BEFORE UPDATE ON task FOR EACH ROW EXECUTE FUNCTION kaneo_test_fail_task_update()",
          ),
        );
        const response = await send(JSON.stringify(event));
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          error: "Webhook handler failed",
        });
        expect(await row()).toEqual(before);
        expect(await readLink()).toEqual(beforeLink);
        expect(await db.select().from(schema.labelTable)).toEqual(beforeLabels);
      } finally {
        await db.execute(
          sql.raw("DROP TRIGGER IF EXISTS kaneo_test_fail_task_update ON task"),
        );
        await db.execute(
          sql.raw("DROP FUNCTION kaneo_test_fail_task_update()"),
        );
      }
      const retry = await send(JSON.stringify(event));
      expect(retry.status).toBe(200);
      const after = await row();
      expect(after!.version).toBe(before!.version + 1);
      expect((await send(JSON.stringify(event))).status).toBe(200);
      expect(await row()).toEqual(after);
    },
  );
  it("link metadata update failure rolls back earlier text change, then retry commits once", async () => {
    const { task, link, send, row, readLink } = await fixture();
    await db.execute(
      sql.raw(
        "CREATE FUNCTION kaneo_test_fail_link_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Private link detail'; END; $$",
      ),
    );
    try {
      await db.execute(
        sql.raw(
          "CREATE TRIGGER kaneo_test_fail_link_update BEFORE UPDATE ON external_link FOR EACH ROW EXECUTE FUNCTION kaneo_test_fail_link_update()",
        ),
      );
      const response = await send();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Webhook handler failed",
      });
      expect(await row()).toEqual(task);
      expect(await readLink()).toEqual(link);
    } finally {
      await db.execute(
        sql.raw(
          "DROP TRIGGER IF EXISTS kaneo_test_fail_link_update ON external_link",
        ),
      );
      await db.execute(sql.raw("DROP FUNCTION kaneo_test_fail_link_update()"));
    }
    expect((await send()).status).toBe(200);
    expect((await row())!.version).toBe(task.version + 1);
  });
  it("suppressed link update returns409 and rolls back text rather than acknowledging success", async () => {
    const { task, link, send, row, readLink } = await fixture();
    await db.execute(
      sql.raw(
        "CREATE FUNCTION kaneo_test_skip_link_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$",
      ),
    );
    try {
      await db.execute(
        sql.raw(
          "CREATE TRIGGER kaneo_test_skip_link_update BEFORE UPDATE ON external_link FOR EACH ROW EXECUTE FUNCTION kaneo_test_skip_link_update()",
        ),
      );
      const response = await send();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "TASK_CONFLICT",
        field: "externalLink",
      });
      expect(await row()).toEqual(task);
      expect(await readLink()).toEqual(link);
    } finally {
      await db.execute(
        sql.raw(
          "DROP TRIGGER IF EXISTS kaneo_test_skip_link_update ON external_link",
        ),
      );
      await db.execute(sql.raw("DROP FUNCTION kaneo_test_skip_link_update()"));
    }
  });
  it("concurrent title/body events preserve both sync records, unrelated metadata and link title", async () => {
    const { task, link, payload, send, row, readLink } = await fixture();
    await db
      .update(schema.externalLinkTable)
      .set({
        metadata: JSON.stringify({
          state: "closed",
          custom: { keep: 1 },
          lastSync: { priority: { source: "kaneo", value: "high" } },
        }),
      })
      .where(eq(schema.externalLinkTable.id, link.id));
    const title = JSON.stringify(payload);
    const body = JSON.stringify({
      ...payload,
      issue: {
        ...payload.issue,
        title: "Stale provider title",
        body: "New body",
      },
      changes: { body: { from: "Body" } },
    });
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) => send(i % 2 ? title : body)),
    );
    for (const response of results) expect(response.status).toBe(200);
    const after = await row();
    expect(after).toEqual({
      ...task,
      title: "Remote title",
      description: "New body",
      version: task.version + 2,
      updatedAt: after!.updatedAt,
    });
    const afterLink = await readLink();
    expect(afterLink!.title).toBe("Remote title");
    expect(JSON.parse(afterLink!.metadata!)).toMatchObject({
      state: "closed",
      custom: { keep: 1 },
      lastSync: {
        priority: { source: "kaneo", value: "high" },
        title: { source: "gitea", value: "Remote title" },
        description: { source: "gitea", value: "New body" },
      },
    });
  });
  it("Kaneo echo metadata is checked under lock and retains locally newer title", async () => {
    const { task, link, payload, send, row, readLink } = await fixture();
    await db
      .update(schema.externalLinkTable)
      .set({
        metadata: JSON.stringify({
          lastSync: {
            title: {
              source: "kaneo",
              value: payload.issue.title,
              timestamp: "2026-01-01T00:00:00Z",
            },
          },
        }),
      })
      .where(eq(schema.externalLinkTable.id, link.id));
    const beforeLink = await readLink();
    expect((await send()).status).toBe(200);
    expect(await row()).toEqual(task);
    expect(await readLink()).toEqual(beforeLink);
  });
  it.each(["{", "null", '{"lastSync":17}'])(
    "invalid stored metadata %s returns409 without overwriting text",
    async (metadata) => {
      const { task, link, send, row, readLink } = await fixture();
      await db
        .update(schema.externalLinkTable)
        .set({ metadata })
        .where(eq(schema.externalLinkTable.id, link.id));
      const beforeLink = await readLink();
      const response = await send();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "TASK_CONFLICT" });
      expect(await row()).toEqual(task);
      expect(await readLink()).toEqual(beforeLink);
    },
  );
});
