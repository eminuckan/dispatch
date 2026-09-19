import { expect, it } from "vite-plus/test";
import { teamAgentDisplayName } from "./teamAgentNames.ts";
it("retains names through retries and appended handoffs without collisions", () => {
  const actors = ["lead", "first", "first", "second"];
  const names = ["lead", "first", "second"].map((id) => teamAgentDisplayName("run", actors, id));
  expect(new Set(names).size).toBe(3);
  expect(teamAgentDisplayName("run", [...actors, "replacement"], "first")).toBe(names[1]);
  expect(teamAgentDisplayName("run", [...actors, "replacement"], "replacement")).not.toBe(names[1]);
  expect(teamAgentDisplayName("run", JSON.parse(JSON.stringify(actors)), "first")).toBe(names[1]);
});
it("keeps names unique for long histories and makes no name for unassigned identities", () => {
  const actors = Array.from({ length: 40 }, (_, index) => `agent-${index}`);
  expect(new Set(actors.map((id) => teamAgentDisplayName("run", actors, id))).size).toBe(40);
  expect(teamAgentDisplayName("run", actors, "unknown")).toBe("Worker");
});
