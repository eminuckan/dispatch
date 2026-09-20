import {
  readMigratedStorageItem,
  removeMigratedStorageItem,
  writeMigratedStorageItem,
} from "./storage";

const STORAGE_KEY = "dispatch:snap-shot-setup-resume:v1";
let startupChecked = false;

export function readSnapShotSetupResume(): { wasEnabled: boolean } | null {
  try {
    const value = readMigratedStorageItem(window.localStorage, STORAGE_KEY);
    if (value === "enabled" || value === "disabled") return { wasEnabled: value === "enabled" };
  } catch {
    // Permission setup still works when local storage is unavailable.
  }
  return null;
}

export function saveSnapShotSetupResume(wasEnabled: boolean): void {
  try {
    writeMigratedStorageItem(window.localStorage, STORAGE_KEY, wasEnabled ? "enabled" : "disabled");
  } catch {
    // Permission setup still works when local storage is unavailable.
  }
}

export function clearSnapShotSetupResume(): void {
  try {
    removeMigratedStorageItem(window.localStorage, STORAGE_KEY);
  } catch {
    // Storage may be unavailable.
  }
}

// Check once per renderer startup so opening System Settings does not redirect
// subsequent navigation in the current session.
export function shouldResumeSnapShotSetupOnStartup(): boolean {
  if (startupChecked) return false;
  startupChecked = true;
  return readSnapShotSetupResume() !== null;
}
