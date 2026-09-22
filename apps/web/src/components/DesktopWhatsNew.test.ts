import { describe, expect, it } from "@effect/vitest";

import { resolveWhatsNewExternalUrl } from "./DesktopWhatsNew";

describe("resolveWhatsNewExternalUrl", () => {
  it("allows only http and https links from release markdown", () => {
    expect(resolveWhatsNewExternalUrl("https://github.com/eminuckan/dispatch/releases")).toBe(
      "https://github.com/eminuckan/dispatch/releases",
    );
    expect(resolveWhatsNewExternalUrl("http://example.com/release")).toBe(
      "http://example.com/release",
    );
    expect(resolveWhatsNewExternalUrl("javascript:alert(1)")).toBeNull();
    expect(resolveWhatsNewExternalUrl("file:///tmp/release.html")).toBeNull();
    expect(resolveWhatsNewExternalUrl(undefined)).toBeNull();
  });
});
