// @effect-diagnostics nodeBuiltinImport:off - Build bootstrap reads optional root env files before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { withDispatchEnvironmentAliases } from "@dispatch/shared/dispatchEnv";

export interface DispatchPublicConfig {
  readonly connectUrl: string | undefined;
  readonly hostedAppUrl: string | undefined;
}

type Environment = Readonly<Record<string, string | undefined>>;

const REPO_ROOT = NodePath.dirname(
  NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))),
);

export function loadRepoEnv({
  baseEnv = process.env,
  repoRoot = REPO_ROOT,
}: {
  readonly baseEnv?: Environment;
  readonly repoRoot?: string;
} = {}): Record<string, string | undefined> {
  const rootEnv = readEnvFile(NodePath.join(repoRoot, ".env"));
  const localEnv = readEnvFile(NodePath.join(repoRoot, ".env.local"));
  const normalizedBaseEnv = withDispatchEnvironmentAliases(baseEnv);
  const normalizedLocalEnv = withDispatchEnvironmentAliases(localEnv);
  const normalizedRootEnv = withDispatchEnvironmentAliases(rootEnv);
  const config = resolvePublicConfig(normalizedBaseEnv, normalizedLocalEnv, normalizedRootEnv);

  return {
    ...normalizedRootEnv,
    ...normalizedLocalEnv,
    ...normalizedBaseEnv,
    ...(config.connectUrl
      ? {
          DISPATCH_CONNECT_URL: config.connectUrl,
          VITE_DISPATCH_CONNECT_URL: config.connectUrl,
          EXPO_PUBLIC_DISPATCH_CONNECT_URL: config.connectUrl,
        }
      : {}),
    ...(config.hostedAppUrl
      ? {
          DISPATCH_HOSTED_APP_URL: config.hostedAppUrl,
          T3CODE_HOSTED_APP_URL: config.hostedAppUrl,
          VITE_HOSTED_APP_URL: config.hostedAppUrl,
        }
      : {}),
  };
}

export function resolvePublicConfig(...sources: readonly Environment[]): DispatchPublicConfig {
  return {
    connectUrl: firstNonEmpty(
      sources,
      "DISPATCH_CONNECT_URL",
      "VITE_DISPATCH_CONNECT_URL",
      "EXPO_PUBLIC_DISPATCH_CONNECT_URL",
    ),
    hostedAppUrl: firstNonEmpty(
      sources,
      "DISPATCH_HOSTED_APP_URL",
      "T3CODE_HOSTED_APP_URL",
      "VITE_HOSTED_APP_URL",
    ),
  };
}

function firstNonEmpty(sources: readonly Environment[], ...names: readonly string[]) {
  for (const source of sources) {
    for (const name of names) {
      const value = source[name]?.trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function readEnvFile(path: string): Record<string, string | undefined> {
  return NodeFS.existsSync(path) ? NodeUtil.parseEnv(NodeFS.readFileSync(path, "utf8")) : {};
}
