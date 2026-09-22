import type { DesktopUpdateChannel } from "@dispatch/contracts";
import { compareSemverVersions, parseSemver } from "@dispatch/shared/semver";

const NIGHTLY_VERSION_PATTERN = /^[^-+]+-nightly\.\d{8}\.\d+$/;
const PREVIEW_VERSION_PATTERN = /^[^-+]+-preview\.\d{8}\.\d+$/;
export function isNightlyDesktopVersion(version: string): boolean {
  return NIGHTLY_VERSION_PATTERN.test(version);
}

export function isPreviewDesktopVersion(version: string): boolean {
  return PREVIEW_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  if (NIGHTLY_VERSION_PATTERN.test(appVersion)) return "nightly";
  if (PREVIEW_VERSION_PATTERN.test(appVersion)) return "preview";
  return "latest";
}

export function isNewerDesktopVersion(candidateVersion: string, currentVersion: string): boolean {
  if (!parseSemver(candidateVersion) || !parseSemver(currentVersion)) return false;
  return compareSemverVersions(candidateVersion, currentVersion) > 0;
}
