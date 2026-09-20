/**
 * Where development state lives, and how to keep it away from the shared
 * main-install state that an older installation may still run against.
 *
 * A linked git worktree gets its own (gitignored) `.dispatch`: feature work in
 * a throwaway branch must not share a database with the real app. Existing
 * worktrees that already have `.t3` keep using it in place so migration never
 * copies or deletes developer state.
 */

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/**
 * A `.git` file points at the real git directory. A linked worktree's lives at
 * `<common-dir>/worktrees/<name>`; a submodule's at
 * `<super-git-dir>/modules/<name>`. Both are files, so the pointer — not the
 * file-vs-directory distinction alone — is what identifies a worktree.
 *
 * The common dir is not necessarily named `.git`: a worktree of a bare repo
 * points at `<repo>.git/worktrees/<name>`, and `$GIT_COMMON_DIR` can be
 * anything. So match on the `worktrees/<name>` tail, which git always uses,
 * rather than on the name of the directory containing it.
 */
const pointsAtLinkedWorktree = (gitFileContents: string, path: Path.Path): boolean => {
  const gitdir = gitFileContents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("gitdir:"))
    ?.slice("gitdir:".length)
    .trim();
  if (gitdir === undefined || gitdir.length === 0) {
    return false;
  }
  // Compare as path segments so a directory merely named `…worktrees…` cannot
  // match as a substring. Trailing separators normalize away first.
  const segments = path
    .normalize(gitdir.replaceAll("\\", "/"))
    .split(/[/\\]/)
    .filter((segment) => segment.length > 0);
  // `<common-dir>/worktrees/<name>`: `worktrees` is the penultimate segment,
  // and something must precede it. This excludes `<git-dir>/modules/<name>`.
  return segments.length >= 3 && segments.at(-2) === "worktrees";
};

/**
 * The path of the linked git worktree containing `cwd`, or undefined when
 * `cwd` is not inside one. Git marks a linked worktree by making `.git` a file
 * whose `gitdir:` points into the repository's `.git/worktrees`.
 *
 * Walks up to the repository root, so running from a subdirectory resolves the
 * same worktree as running from the top.
 */
export const resolveGitWorktreePath = (
  cwd: string,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    let directory = path.resolve(cwd);
    for (;;) {
      const gitPath = path.join(directory, ".git");
      const info = yield* fileSystem.stat(gitPath).pipe(Effect.option);
      if (Option.isSome(info)) {
        // A directory means the main checkout. Stop either way: nesting one
        // repository inside another does not make the outer one this root.
        if (info.value.type !== "File") {
          return undefined;
        }
        // A submodule also has a `.git` file, but it is not a worktree of this
        // repository and gets no worktree-local home.
        const contents = yield* fileSystem
          .readFileString(gitPath)
          .pipe(Effect.orElseSucceed(() => ""));
        return pointsAtLinkedWorktree(contents, path) ? directory : undefined;
      }
      const parent = path.dirname(directory);
      if (parent === directory) {
        return undefined;
      }
      directory = parent;
    }
  });

/**
 * The worktree-local Dispatch data directory for `cwd`, or undefined outside a
 * linked worktree. A fresh worktree resolves to `.dispatch`; when only the
 * legacy `.t3` exists it is adopted in place. If both exist, canonical
 * `.dispatch` wins.
 */
export const resolveWorktreeDispatchHome = (
  cwd: string,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveGitWorktreePath(cwd);
    if (worktreePath === undefined) {
      return undefined;
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dispatchHome = path.join(worktreePath, ".dispatch");
    if (yield* fileSystem.exists(dispatchHome).pipe(Effect.orElseSucceed(() => false))) {
      return dispatchHome;
    }

    const legacyHome = path.join(worktreePath, ".t3");
    if (yield* fileSystem.exists(legacyHome).pipe(Effect.orElseSucceed(() => false))) {
      return legacyHome;
    }

    return dispatchHome;
  });
