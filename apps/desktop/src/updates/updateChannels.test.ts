import { describe, expect, it } from "vite-plus/test";

import {
  isNewerDesktopVersion,
  isNightlyDesktopVersion,
  isPreviewDesktopVersion,
  resolveDefaultDesktopUpdateChannel,
} from "./updateChannels.ts";

describe("updateChannels", () => {
  it("distinguishes nightly and preview builds and follows their dedicated channels", () => {
    expect(isNightlyDesktopVersion("0.0.41-preview.20260911.7")).toBe(false);
    expect(isPreviewDesktopVersion("0.0.41-preview.20260911.7")).toBe(true);
    expect(isNightlyDesktopVersion("0.0.41-nightly.20260911.7")).toBe(true);
    expect(isPreviewDesktopVersion("0.0.41-nightly.20260911.7")).toBe(false);
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-preview.20260911.7")).toBe("preview");
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-nightly.20260911.7")).toBe("nightly");
    expect(resolveDefaultDesktopUpdateChannel("0.0.41")).toBe("latest");
  });

  it("only matches the first prerelease identifier", () => {
    expect(isNightlyDesktopVersion("1.2.3-foo-preview.20260911.1")).toBe(false);
    expect(isPreviewDesktopVersion("1.2.3-foo-preview.20260911.1")).toBe(false);
    expect(isNightlyDesktopVersion("1.2.3")).toBe(false);
    expect(isPreviewDesktopVersion("1.2.3")).toBe(false);
  });

  it("accepts only valid semver versions newer than the installed version", () => {
    expect(isNewerDesktopVersion("1.2.4-preview.20260922.1", "1.2.3")).toBe(true);
    expect(isNewerDesktopVersion("1.2.4", "1.2.4-preview.20260922.1")).toBe(true);
    expect(isNewerDesktopVersion("1.2.4-preview.20260922.1", "1.2.4")).toBe(false);
    expect(isNewerDesktopVersion("1.2.3", "1.2.4-preview.20260922.1")).toBe(false);
    expect(isNewerDesktopVersion("not-a-version", "1.2.3")).toBe(false);
  });
});
