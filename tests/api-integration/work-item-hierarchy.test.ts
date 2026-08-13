import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("API integration: typed work item hierarchy", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("persists types, filters them, enforces hierarchy, and blocks moves", async () => {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const { project: destinationProject } = await createProjectFixture({
      workspaceId: member.workspace.id,
      slug: "destination",
    });
    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const createTask = async (
      title: string,
      workItemType: "task" | "epic" | "sub_epic",
    ) => {
      const response = await app.request(`/api/task/${project.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          description: "",
          priority: "medium",
          status: "to-do",
          workItemType,
        }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as {
        id: string;
        title: string;
        position: number;
        workItemType: string;
      };
    };

    const epic = await createTask("Delivery epic", "epic");
    const subEpic = await createTask("API sub-epic", "sub_epic");
    const leaf = await createTask("Write tests", "task");
    const secondEpic = await createTask("Second epic", "epic");

    expect(epic.workItemType).toBe("epic");
    await expect(
      db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, epic.id),
      }),
    ).resolves.toMatchObject({ workItemType: "epic" });

    const listResponse = await app.request(
      `/api/task/tasks/${project.id}?workItemType=epic`,
    );
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as {
      data: { columns: Array<{ tasks: Array<{ id: string }> }> };
    };
    expect(list.data.columns.flatMap((column) => column.tasks).map((task) => task.id)).toEqual(
      expect.arrayContaining([epic.id, secondEpic.id]),
    );
    expect(list.data.columns.flatMap((column) => column.tasks).map((task) => task.id)).not.toContain(
      subEpic.id,
    );

    const createRelation = (sourceTaskId: string, targetTaskId: string) =>
      app.request("/api/task-relation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceTaskId, targetTaskId, relationType: "subtask" }),
      });

    expect((await createRelation(epic.id, subEpic.id)).status).toBe(200);
    expect((await createRelation(subEpic.id, leaf.id)).status).toBe(200);
    expect((await createRelation(secondEpic.id, subEpic.id)).status).toBe(409);
    expect((await createRelation(leaf.id, epic.id)).status).toBe(409);

    const updateResponse = await app.request(`/api/task/${subEpic.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: subEpic.title,
        description: "",
        priority: "medium",
        status: "to-do",
        projectId: project.id,
        position: subEpic.position,
        workItemType: "epic",
      }),
    });
    expect(updateResponse.status).toBe(409);

    const moveResponse = await app.request(`/api/task/move/${subEpic.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ destinationProjectId: destinationProject.id }),
    });
    expect(moveResponse.status).toBe(409);
  });
});
