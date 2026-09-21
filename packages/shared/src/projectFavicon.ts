import type { RepositoryIdentity } from "@dispatch/contracts";

export const PROJECT_FAVICON_FALLBACK_MARKER = "project-favicon-missing";
const CANONICAL_DISPATCH_REPOSITORY_KEY = "github.com/eminuckan/dispatch";

function normalizeRepositoryKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");
}

/**
 * The Dispatch repository used to carry T3 artwork in its project config. Keep
 * that legacy artwork available to real T3 repositories, but attribute the
 * canonical Dispatch checkout to Dispatch regardless of its automatic favicon.
 */
export function isCanonicalDispatchRepository(
  identity: Pick<RepositoryIdentity, "canonicalKey"> | null | undefined,
): boolean {
  return identity !== null && identity !== undefined
    ? normalizeRepositoryKey(identity.canonicalKey) === CANONICAL_DISPATCH_REPOSITORY_KEY
    : false;
}

export function getProjectFaviconResourceKey(
  environmentId: string,
  workspaceRoot: string,
  faviconPath?: string | null,
) {
  return JSON.stringify([environmentId, workspaceRoot, faviconPath || null]);
}

export function getProjectFaviconCacheKey(
  environmentId: string,
  workspaceRoot: string,
  url: string,
) {
  let revision = url;

  try {
    const pathname = new URL(url, "https://t3.invalid").pathname;
    revision = pathname.slice(pathname.lastIndexOf("/") + 1);
  } catch {
    // Keep the full value as a safe fallback for malformed URLs.
  }

  return JSON.stringify([environmentId, workspaceRoot, revision]);
}

export function isProjectFaviconFallbackUrl(url: string | null | undefined): boolean {
  if (!url) return false;

  try {
    const pathname = new URL(url, "https://t3.invalid").pathname;
    return pathname.slice(pathname.lastIndexOf("/") + 1) === PROJECT_FAVICON_FALLBACK_MARKER;
  } catch {
    return false;
  }
}
