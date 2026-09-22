import type { ReviewResult } from "./OrchestrationProtocol.ts";

type VerificationEvidence = ReviewResult["checks"][number] & {
  readonly passed: boolean;
  readonly output: string;
};

/** Full checks remain on the review attempt; decision summaries allow 8,000 characters. */
export function verificationDecision(
  summary: string,
  evidence: ReadonlyArray<VerificationEvidence>,
  task?: string,
): string {
  const decision = { ...(task === undefined ? {} : { task }), summary, evidence };
  const encoded = JSON.stringify(decision);
  if (encoded.length <= 8_000) return encoded;

  // Bound the serialized JSON, including escaping and the aggregate of all checks.
  for (const limit of [2_000, 1_000, 500, 250, 120, 60, 30, 0]) {
    const clip = (text: string, tail = false) =>
      text.length <= limit
        ? text
        : limit === 0
          ? ""
          : tail
            ? `…${text.slice(-(limit - 1))}`
            : `${text.slice(0, limit - 1)}…`;
    const bounded = JSON.stringify({
      ...decision,
      summary: clip(summary),
      truncated: true,
      evidence: evidence.map((entry) => ({
        criterionIndex: entry.criterionIndex,
        command: clip(entry.command),
        args: entry.args.map((arg) => clip(arg)),
        passed: entry.passed,
        output: clip(entry.output, true),
      })),
    });
    if (bounded.length <= 8_000) return bounded;
  }
  throw new Error("Verification evidence exceeds the supported review limits.");
}
