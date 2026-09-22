import { describe, expect, it } from "@effect/vitest";

import { resolveDesktopProductUpdateChannel } from "./DesktopUpdateSettings";

describe("resolveDesktopProductUpdateChannel", () => {
  it("keeps stable explicit and presents prerelease channels as Preview", () => {
    expect(resolveDesktopProductUpdateChannel("latest")).toBe("latest");
    expect(resolveDesktopProductUpdateChannel("preview")).toBe("preview");
    expect(resolveDesktopProductUpdateChannel("nightly")).toBe("preview");
  });
});
