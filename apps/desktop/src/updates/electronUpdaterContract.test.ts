import { describe, expect, it } from "vite-plus/test";
import { MacUpdater } from "electron-updater/out/MacUpdater.js";
import { findFile, Provider } from "electron-updater/out/providers/Provider.js";
import type {
  ProviderPlatform,
  ProviderRuntimeOptions,
} from "electron-updater/out/providers/Provider.js";
import type { ResolvedUpdateFileInfo, UpdateInfo } from "electron-updater/out/types.js";

class ChannelProbeProvider extends Provider<UpdateInfo> {
  constructor(platform: ProviderPlatform) {
    super({
      platform,
      isUseMultipleRangeRequest: false,
      executor: {} as ProviderRuntimeOptions["executor"],
    });
  }

  channelName(channel: string): string {
    return this.getCustomChannelName(channel);
  }

  override getLatestVersion(): Promise<UpdateInfo> {
    throw new Error("not used");
  }

  override resolveFiles(): ResolvedUpdateFileInfo[] {
    return [];
  }
}

function file(url: string): ResolvedUpdateFileInfo {
  return {
    url: new URL(`https://github.com/eminuckan/dispatch/releases/download/v1.2.3/${url}`),
    info: { url, sha512: `${url}-sha` },
  };
}

describe("electron-updater 6.8.9 channel/artifact contract", () => {
  it("maps the Preview channel to the platform manifest names the release workflow publishes", () => {
    expect(new ChannelProbeProvider("darwin").channelName("preview")).toBe("preview-mac");
    expect(new ChannelProbeProvider("win32").channelName("preview")).toBe("preview");

    const previousArch = process.env.TEST_UPDATER_ARCH;
    try {
      process.env.TEST_UPDATER_ARCH = "x64";
      expect(new ChannelProbeProvider("linux").channelName("preview")).toBe("preview-linux");
      process.env.TEST_UPDATER_ARCH = "arm64";
      expect(new ChannelProbeProvider("linux").channelName("preview")).toBe("preview-linux-arm64");
    } finally {
      if (previousArch === undefined) delete process.env.TEST_UPDATER_ARCH;
      else process.env.TEST_UPDATER_ARCH = previousArch;
    }
  });

  it("selects the current Windows architecture from a merged multi-arch manifest", () => {
    const currentArch = process.arch === "arm64" ? "arm64" : "x64";
    const otherArch = currentArch === "arm64" ? "x64" : "arm64";
    const selected = findFile(
      [file(`Dispatch-1.2.3-${otherArch}.exe`), file(`Dispatch-1.2.3-${currentArch}.exe`)],
      "exe",
    );

    expect(selected?.url.pathname).toContain(`-${currentArch}.exe`);
  });

  it("filters merged macOS manifests to arm64 on Apple Silicon and x64 otherwise", () => {
    const files = [
      file("Dispatch-1.2.3-arm64.zip"),
      file("Dispatch-1.2.3-arm64.dmg"),
      file("Dispatch-1.2.3-x64.zip"),
      file("Dispatch-1.2.3-x64.dmg"),
    ];
    const filterFilesForArch = (
      MacUpdater as unknown as {
        filterFilesForArch(
          entries: ResolvedUpdateFileInfo[],
          isArm64Mac: boolean,
        ): ResolvedUpdateFileInfo[];
      }
    ).filterFilesForArch;

    expect(filterFilesForArch(files, true).map((entry) => entry.info.url)).toEqual([
      "Dispatch-1.2.3-arm64.zip",
      "Dispatch-1.2.3-arm64.dmg",
    ]);
    expect(filterFilesForArch(files, false).map((entry) => entry.info.url)).toEqual([
      "Dispatch-1.2.3-x64.zip",
      "Dispatch-1.2.3-x64.dmg",
    ]);
  });
});
