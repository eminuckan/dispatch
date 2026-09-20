const DISPATCH_ENV_PREFIX = "DISPATCH_";
const LEGACY_ENV_PREFIX = "T3CODE_";

/**
 * Makes the Dispatch environment namespace canonical while preserving the
 * existing T3CODE_* config readers as a compatibility boundary.
 *
 * Dispatch values intentionally win when both names are present.
 */
export function applyDispatchEnvironmentAliases(
  environment: Record<string, string | undefined>,
): void {
  for (const [name, value] of Object.entries(environment)) {
    if (!name.startsWith(DISPATCH_ENV_PREFIX) || value === undefined || value.trim().length === 0)
      continue;
    const suffix = name.slice(DISPATCH_ENV_PREFIX.length);
    if (suffix.length === 0) continue;
    environment[`${LEGACY_ENV_PREFIX}${suffix}`] = value;
  }
}

/** Returns a copy suitable for config resolution without mutating the caller. */
export function withDispatchEnvironmentAliases(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const normalized = { ...environment };
  applyDispatchEnvironmentAliases(normalized);
  return normalized;
}
