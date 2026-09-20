import { describe, expect, it } from "@effect/vitest";

import { applyDispatchEnvironmentAliases, withDispatchEnvironmentAliases } from "./dispatchEnv.ts";

describe("Dispatch environment aliases", () => {
  it("maps Dispatch names onto legacy config slots", () => {
    const environment: Record<string, string | undefined> = { DISPATCH_HOME: "/tmp/dispatch" };

    applyDispatchEnvironmentAliases(environment);

    expect(environment.T3CODE_HOME).toBe("/tmp/dispatch");
  });

  it("gives canonical Dispatch names precedence over legacy values", () => {
    const normalized = withDispatchEnvironmentAliases({
      DISPATCH_PORT: "4888",
      T3CODE_PORT: "3773",
    });

    expect(normalized.T3CODE_PORT).toBe("4888");
  });

  it("leaves legacy-only configuration intact", () => {
    const normalized = withDispatchEnvironmentAliases({ T3CODE_HOST: "127.0.0.1" });

    expect(normalized.T3CODE_HOST).toBe("127.0.0.1");
    expect(normalized.DISPATCH_HOST).toBeUndefined();
  });

  it.each(["", "   "])("treats blank canonical values as unset (%j)", (canonical) => {
    const normalized = withDispatchEnvironmentAliases({
      DISPATCH_HOME: canonical,
      T3CODE_HOME: "/tmp/legacy-home",
    });

    expect(normalized.T3CODE_HOME).toBe("/tmp/legacy-home");
    expect(normalized.DISPATCH_HOME).toBe(canonical);
  });
});
