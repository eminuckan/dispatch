import { expect, it } from "vite-plus/test";
import {
  isTeamProtocolRole,
  looksLikeTeamProtocol,
  teamProtocolSummary,
} from "./teamProtocolPresentation.ts";

it("formats only managed protocol roles", () => {
  expect(isTeamProtocolRole("plan")).toBe(true);
  expect(isTeamProtocolRole("review")).toBe(true);
  expect(isTeamProtocolRole("integrate")).toBe(true);
  expect(isTeamProtocolRole("worker")).toBe(false);
});

it("presents plan rationale and task objectives without protocol internals", () => {
  expect(
    teamProtocolSummary(
      "plan",
      '```json\n{"acceptance":["hidden"],"tasks":[{"objective":"Fix startup","context":"private"}],"rationale":"Check startup."}\n```',
    ),
  ).toBe("Check startup.\n\n- Fix startup");
});

it("presents review and integration summaries", () => {
  expect(
    teamProtocolSummary(
      "review",
      '{"action":"correct","summary":"Add the timeout check.","checks":[]}',
    ),
  ).toBe("Add the timeout check.");
  expect(
    teamProtocolSummary(
      "integrate",
      '{"action":"accept","summary":"Combined result verified.","checks":[]}',
    ),
  ).toBe("Combined result verified.");
});

it("does not reinterpret arbitrary or malformed JSON as a valid protocol summary", () => {
  expect(teamProtocolSummary("review", '{"hello":"world"}')).toBeNull();
  expect(teamProtocolSummary("review", '{"action":"blocked","summary":"Nope"}')).toBeNull();
  expect(teamProtocolSummary("plan", '{"tasks":[')).toBeNull();
});

it("recognizes partial protocol-shaped objects for streaming suppression", () => {
  expect(looksLikeTeamProtocol('{"action":"correct","summary":"')).toBe(true);
  expect(looksLikeTeamProtocol('{"ac')).toBe(true);
  expect(looksLikeTeamProtocol('{"normal":"json"}')).toBe(false);
  expect(looksLikeTeamProtocol("ordinary commentary")).toBe(false);
});
