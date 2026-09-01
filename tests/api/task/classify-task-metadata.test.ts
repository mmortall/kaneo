import { describe, expect, it } from "vitest";
import { classifyTaskMetadata } from "../../../apps/api/src/task/classify-task-metadata";

describe("classifyTaskMetadata", () => {
  it("marks explicit blockers and blocked tasks as agent blockers", () => {
    expect(
      classifyTaskMetadata({
        title: "Blocker: grant production access",
        status: "in-progress",
      }).taskCategory,
    ).toBe("agent_blocker");
    expect(
      classifyTaskMetadata({ title: "Alias decision", status: "blocked" })
        .taskCategory,
    ).toBe("agent_blocker");
  });

  it("marks explicit research language as research", () => {
    expect(
      classifyTaskMetadata({ title: "Research H4 execution hypothesis" }),
    ).toEqual({ taskCategory: "research", strategyHorizons: ["position"] });
    expect(
      classifyTaskMetadata({ title: "Проверь результаты недельного теста" }),
    ).toEqual({ taskCategory: "research", strategyHorizons: ["long_term"] });
  });

  it("keeps implementation as default category", () => {
    expect(classifyTaskMetadata({ title: "Deploy dashboard" })).toEqual({
      taskCategory: "live_implementation",
      strategyHorizons: [],
    });
    expect(
      classifyTaskMetadata({
        title: "Build email subscription analysis pipeline with tests",
      }).taskCategory,
    ).toBe("live_implementation");
  });

  it("supports strategies spanning several explicit horizons", () => {
    expect(
      classifyTaskMetadata({ title: "Compare M15, H1/H4, D1 and W1 sets" })
        .strategyHorizons,
    ).toEqual(["short", "position", "long_term"]);
  });

  it("classifies yearly strategies as ultra long term", () => {
    expect(
      classifyTaskMetadata({ title: "Annual multi-year allocation review" })
        .strategyHorizons,
    ).toEqual(["ultra_long_term"]);
  });
});
