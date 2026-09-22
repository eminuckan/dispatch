import { expect, it } from "vite-plus/test";
import { verificationDecision } from "./OrchestrationEvidence.ts";

it("retains complete short evidence", () => {
  const evidence = [
    { criterionIndex: 0, command: "node", args: ["check.js"], passed: true, output: "Verified" },
  ];
  expect(JSON.parse(verificationDecision("Accepted", evidence, "worker"))).toEqual({
    task: "worker",
    summary: "Accepted",
    evidence,
  });
});

it("bounds aggregate escaped evidence without losing any check verdict or criterion", () => {
  const evidence = Array.from({ length: 20 }, (_, criterionIndex) => ({
    criterionIndex,
    command: "\u0000".repeat(128),
    args: Array.from({ length: 40 }, () => "\u0000".repeat(4_000)),
    passed: criterionIndex !== 19,
    output: "\u0000".repeat(16_384),
  }));
  const encoded = verificationDecision("\u0000".repeat(8_000), evidence, "worker");
  expect(encoded.length).toBeLessThanOrEqual(8_000);
  const parsed = JSON.parse(encoded) as {
    truncated: boolean;
    evidence: Array<{ criterionIndex: number; passed: boolean }>;
  };
  expect(parsed.truncated).toBe(true);
  expect(parsed.evidence.map(({ criterionIndex, passed }) => ({ criterionIndex, passed }))).toEqual(
    evidence.map(({ criterionIndex, passed }) => ({ criterionIndex, passed })),
  );
});

it("keeps the diagnostic tail when successful and failed output must be shortened", () => {
  const encoded = verificationDecision(
    "Verification",
    [true, false].map((passed, criterionIndex) => ({
      criterionIndex,
      command: "node",
      args: ["check.js"],
      passed,
      output: `${"x".repeat(10_000)}\nFinal diagnostic`,
    })),
  );
  expect(encoded.length).toBeLessThanOrEqual(8_000);
  const parsed = JSON.parse(encoded) as { evidence: Array<{ output: string }> };
  expect(parsed.evidence.every(({ output }) => output.endsWith("Final diagnostic"))).toBe(true);
});
