const WILDCARD_PATTERN = /[.*+?^${}()|[\]\\]/gu;

function originPatternRegex(pattern: string): RegExp {
  const source = pattern
    .replace(WILDCARD_PATTERN, "\\$&")
    .replaceAll("\\*", ".*")
    .replaceAll("\\?", ".");
  return new RegExp(`^${source}$`, "u");
}

/**
 * Match an Origin header against the same deployment-facing wildcard shapes
 * accepted by Better Auth trustedOrigins. Origins never contain paths, so an
 * anchored glob is enough here and avoids reflecting arbitrary request origins.
 */
export function isAllowedCorsOrigin(origin: string, allowedOrigins: readonly string[]): boolean {
  return allowedOrigins.some(
    (pattern) =>
      pattern === origin ||
      ((pattern.includes("*") || pattern.includes("?")) &&
        originPatternRegex(pattern).test(origin)),
  );
}
