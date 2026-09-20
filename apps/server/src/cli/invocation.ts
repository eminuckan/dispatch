import * as Effect from "effect/Effect";

import { HostProcessArguments, HostProcessInvokedAs } from "@t3tools/shared/hostProcess";

import packageJson from "../../package.json" with { type: "json" };

export type CliRunner = "npx" | "pnpm dlx" | "bunx";

/**
 * How the CLI was launched, judged by where its entry script lives. Each
 * package runner executes out of a distinctive cache/temp layout:
 *
 *   npx      ~/.npm/_npx/<hash>/node_modules/...
 *   pnpm dlx ~/.cache/pnpm/dlx/..., $PNPM_HOME/.pnpm/dlx/...,
 *            or %LOCALAPPDATA%/pnpm-cache/dlx/... on Windows
 *   bunx     ~/.bun/install/cache/... or $TMPDIR/bunx-<uid>-<spec>/...
 *
 * Global installs and repo checkouts match none of these and return null.
 * Detection is best-effort; callers fall back to the canonical `dispatch` command.
 */
function detectCliRunner(entryPath: string): CliRunner | null {
  const path = entryPath.replaceAll("\\", "/");
  if (path.includes("/_npx/")) {
    return "npx";
  }
  if (
    path.includes("/pnpm/dlx/") ||
    path.includes("/.pnpm/dlx/") ||
    path.includes("/pnpm-cache/dlx/")
  ) {
    return "pnpm dlx";
  }
  if (path.includes("/.bun/install/cache/") || path.includes("/bunx-")) {
    return "bunx";
  }
  return null;
}

type CliCommandName = "dispatch" | "t3";

function packageCommandName(entryPath: string): CliCommandName | undefined {
  const path = entryPath.replaceAll("\\", "/");
  if (path.includes("/node_modules/t3/") || /\/t3@[^/]+\/dist\/bin\.mjs$/u.test(path)) {
    return "t3";
  }
  if (path.includes("/node_modules/dispatch/") || /\/dispatch@[^/]+\/dist\/bin\.mjs$/u.test(path)) {
    return "dispatch";
  }
  return undefined;
}

function directCommandName(invokedAs: string | undefined): CliCommandName {
  const command = invokedAs?.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  return /^(?:t3|t3\.exe|t3\.cmd)$/u.test(command) ? "t3" : "dispatch";
}

/** Rebuild the package spec because package runners resolve the original literal away. */
function suggestedPackageSpec(version: string, commandName: CliCommandName): string {
  const channel = /^[^-+]+-(nightly|preview)\./.exec(version)?.[1];
  return channel === undefined ? commandName : `${commandName}@${channel}`;
}

/**
 * Render a CLI suggestion that preserves an observed legacy `t3` invocation
 * while defaulting new/direct guidance to the canonical `dispatch` command.
 */
export function formatCliCommand(input: {
  readonly subcommand: string;
  readonly entryPath: string;
  readonly version: string;
  readonly invokedAs?: string;
}): string {
  const runner = detectCliRunner(input.entryPath);
  if (runner === null) {
    const commandName = directCommandName(input.invokedAs);
    return `${commandName} ${input.subcommand}`;
  }
  const commandName = packageCommandName(input.entryPath) ?? directCommandName(input.invokedAs);
  return `${runner} ${suggestedPackageSpec(input.version, commandName)} ${input.subcommand}`;
}

/** `formatCliCommand` against this process's real entry path and version. */
export const resolveCliCommand = (subcommand: string) =>
  Effect.all({ processArguments: HostProcessArguments, invokedAs: HostProcessInvokedAs }).pipe(
    Effect.map(({ processArguments, invokedAs }) =>
      formatCliCommand({
        subcommand,
        entryPath: processArguments[1] ?? "",
        version: packageJson.version,
        invokedAs,
      }),
    ),
  );
