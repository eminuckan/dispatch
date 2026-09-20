export const BRAND_ASSET_PATHS = {
  dispatchIconSvg: "assets/dispatch/icon.svg",
  dispatchMarkSvg: "assets/dispatch/mark.svg",
  dispatchIconComposerProject: "assets/dispatch/app-icon.icon",

  developmentIosIconPng: "assets/dispatch/icon-1024.png",
  developmentUniversalIconPng: "assets/dispatch/icon-1024.png",

  productionIosIconPng: "assets/dispatch/icon-1024.png",
  productionMacIconPng: "assets/dispatch/icon-1024.png",
  productionLinuxIconPng: "assets/dispatch/icon-1024.png",
  productionWindowsIconIco: "assets/dispatch/icon.ico",
  productionWebFaviconIco: "assets/dispatch/icon.ico",
  productionWebFavicon16Png: "assets/dispatch/icon-16.png",
  productionWebFavicon32Png: "assets/dispatch/icon-32.png",
  productionWebAppleTouchIconPng: "assets/dispatch/icon-180.png",

  nightlyIosIconPng: "assets/dispatch/icon-1024.png",
  nightlyMacIconPng: "assets/dispatch/icon-1024.png",
  nightlyLinuxIconPng: "assets/dispatch/icon-1024.png",
  nightlyWindowsIconIco: "assets/dispatch/icon.ico",
  nightlyWebFaviconIco: "assets/dispatch/icon.ico",
  nightlyWebFavicon16Png: "assets/dispatch/icon-16.png",
  nightlyWebFavicon32Png: "assets/dispatch/icon-32.png",
  nightlyWebAppleTouchIconPng: "assets/dispatch/icon-180.png",

  developmentDesktopIconPng: "assets/dispatch/icon-1024.png",
  developmentWindowsIconIco: "assets/dispatch/icon.ico",
  developmentWebFaviconIco: "assets/dispatch/icon.ico",
  developmentWebFavicon16Png: "assets/dispatch/icon-16.png",
  developmentWebFavicon32Png: "assets/dispatch/icon-32.png",
  developmentWebAppleTouchIconPng: "assets/dispatch/icon-180.png",
} as const;

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export function resolveWebAssetBrandForPackageVersion(version: string): WebAssetBrand {
  return /^[^-+]+-(?:nightly|preview)\./.test(version) ? "nightly" : "production";
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  favicon16Png: "favicon-16x16.png",
  favicon32Png: "favicon-32x32.png",
  appleTouchIconPng: "apple-touch-icon.png",
} as const;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: {
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
  },
  nightly: {
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
  },
  production: {
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
  },
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return [
    {
      sourceRelativePath: sourcePaths.faviconIco,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconIco}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon16Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon16Png}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon32Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon32Png}`,
    },
    {
      sourceRelativePath: sourcePaths.appleTouchIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.appleTouchIconPng}`,
    },
  ];
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const DEVELOPMENT_PUBLIC_ICON_OVERRIDES = resolveWebIconOverrides(
  "development",
  "apps/web/public",
);
