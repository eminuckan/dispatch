---
name: test-dispatch-app
description: Test Dispatch's web and desktop UI through its built-in Browser panel against isolated development state. Use for browser verification, browser pairing recovery, and test fixtures. Use test-dispatch-mobile for native mobile verification.
---

# Test Dispatch web and desktop

Prefer Dispatch's built-in Browser panel for verification when its tools and
panel runtime are available. If the tools are absent or `preview_status`
reports the panel unavailable, use the existing browser automation tools
already connected to the session instead. Do not install a new automation
system just for verification. For native mobile testing, use
[test-dispatch-mobile](../test-dispatch-mobile/SKILL.md).

## Start the app

Reuse this task's healthy dev server. Otherwise run `vp run dev` from the
repository root and retain its terminal session. Use the worktree's ignored
`.dispatch` state and read the actual ports and pairing URL from the dev-runner output.
If the worktree already contains only legacy `.t3` state, Dispatch may adopt it in place.
Never run against a live install's `userdata` directory or set `VITE_HTTP_URL` or `VITE_WS_URL`.

Test with meaningful project and thread data. Read
[references/sqlite-fixtures.md](references/sqlite-fixtures.md) only when
inspecting or seeding SQLite. Stop the test server before direct fixture writes.

## Use the Browser panel

When the Browser panel tools are available, call `preview_status`. If it reports
the panel available, call `preview_open` when closed, navigate to the complete
startup pairing URL once with `preview_navigate`, then use `preview_snapshot`
and Dispatch's interaction tools. If the tools are absent or the panel runtime is
unavailable, open the same pairing URL in the session's existing browser automation
and keep using that tab. If the token was consumed or expired, run
`node apps/server/src/bin.ts pair` for a fresh one.

## Verify and retain

Exercise the affected flow and capture the state that proves it works. Keep
the server, state, and panel available while the user inspects or iterates.
An assistant turn ending is not teardown. Stop only processes you started,
using retained terminal sessions or captured PIDs.

When sharing is requested, start with `vp run dev --share` and give the user
a fresh complete pairing URL that you have not consumed. Keep other credentials
out of screenshots, commits, and replies.
