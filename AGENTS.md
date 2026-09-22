# Dispatch

Dispatch is an open-source GUI for coding agents. A Node WebSocket server wraps provider CLIs and agents (Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity) and serves web, desktop, and mobile clients.

Dispatch is an independent open-source project derived from T3 Code. Preserve upstream attribution and compatibility where it is technically required, but new product identity, user-facing copy, release ownership, and newly written state belong to Dispatch.

## Product principles

These are the constraints to preserve as Dispatch continues to diverge from upstream.

### 1. Open at the core

Dispatch is open source. Keep product and engineering work reviewable, preserve required third-party notices, and prefer changes that remain understandable to people running their own builds.

### 2. Performance without compromise

Performance is a product constraint. Watch for regressions caused by sending too much data over websockets, GPU-heavy CSS, unnecessary repainting, and expensive list rendering.

### 3. Remote ready

Dispatch's websocket layer and canonical `dispatch` CLI support remote workflows. Users may connect directly over their local network, through Tailscale, SSH, or optional Dispatch Connect. Dispatch Connect accounts are convenience/discovery identity, not environment authority: a device still needs an explicit environment pairing grant. Dispatch Connect uses Dispatch-owned authentication and pairing; do not restore the retired Clerk or upstream T3 Connect integration. New features should account for remote clients where reasonable.

### 4. Multi-surface

Dispatch has 3 key app surfaces: **web**, **desktop**, and **mobile**.

**Web** is served by the Dispatch server and may also be deployed as a hosted client when a Dispatch-owned host is configured. Do not assume the upstream `app.t3.codes` deployment is a Dispatch service.

**Desktop** is the main Electron surface and bundles the server runner. It can also host the server for remote web or mobile clients.

**Mobile** is a React Native app for iOS and Android. It connects to Dispatch servers for remote control. Do not claim upstream T3 Code store listings as Dispatch distribution.

## Engineering approach

Prefer ambitious ideas implemented with simple systems and obvious behavior. Do not preserve complexity just because it already exists, and do not introduce machinery merely because it looks architecturally impressive. Understand the real constraint, then choose the smallest model that makes correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Contributors may be controlling Dispatch remotely while changing this repository. Be careful about accessing live state, killing dev servers, or taking actions that can damage the running Dispatch instance they are using.

## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing Dispatch.
- **we, us, and maintainers** mean the people maintaining Dispatch.
- **user** means the person using Dispatch to direct coding agents.
- **agent** means the coding agent a user runs inside Dispatch. Depending on context, that may also include you.
- **provider** means the agent runtime or harness Dispatch talks to, such as Codex, Claude, Cursor, or OpenCode.
- **client** means the web, desktop, or mobile UI.
- **environment** means one running Dispatch server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **thread** means the durable conversation and work history for a project.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **Dispatch home** means the base data directory. New installs use `~/.dispatch`; legacy T3/T3 Jev homes remain readable for compatibility.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** The developer may have live state under `~/.dispatch`, `~/.t3-jev`, or `~/.t3`. Reading or snapshotting it can be useful, but never start a development server against live state, open its database read-write, or clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (wraps web, adds Electron shell/IPC), and mobile (React Native, separate navigation). Shared logic lives in `packages/client-runtime`
- **Providers.** Codex, Claude, Cursor, Grok, OpenCode, and Antigravity each have an adapter. Provider-shaped features need a decision per adapter, even if the decision is "not supported here".
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server, web, mobile, and desktop all follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel behave differently. Multi-device and multi-environment cases are real.
- **Docs.** Check whether the change makes existing guidance inaccurate. Apply the [documentation rules](#documentation) before adding anything.

## Dev servers

- `vp i` installs. Worktrees get this from the t3.json setup script; if module resolution looks broken, it probably did not run.
- `vp run dev` starts server and web. In a fresh linked worktree, state defaults to that worktree's gitignored `.dispatch`; an existing worktree-local `.t3` is adopted in place for compatibility. An explicit `--home-dir` wins, followed by `DISPATCH_HOME`, then the worktree home, then legacy `T3CODE_HOME`.
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift.
- Sharing over the tailnet is three steps: run `vp run dev --share` in the background, wait for the `pairingUrl:` line in its output, then give that full URL to an unpaired browser. Do not wire up `tailscale serve` by hand, open the URL yourself, or consume the user's pairing link. A browser with the reusable dev cookie can use the bare origin. If a normal one-time token was consumed, mint a fresh one with `node apps/server/src/bin.ts pair`. It carries standard scopes, while the startup URL carries admin scopes needed for Connections settings.
- To reuse web dev auth across worktrees, configure one fixed `DISPATCH_DEV_AUTH_TOKEN` in the main checkout's gitignored `.env`; the legacy `T3CODE_DEV_AUTH_TOKEN` alias remains supported. The compatibility `t3.json` setup links that file into worktrees. Never commit or publish the token or a startup URL. See [Reusable dev credential](docs/operations/development.md#reusable-dev-credential).
- Stop what you started, by the PID you tracked. See rule 1.

## Test data

An empty database is a bad test. Seed your worktree's local `.dispatch` state with a snapshot of real data instead of pointing at live state:

- Snapshot from the developer's actual live home only when needed. Depending on migration history that can be `~/.dispatch`, `~/.t3-jev`, or `~/.t3`. Fresh worktree state lives at `<worktree>/.dispatch/userdata`; if that worktree already has only legacy `.t3` state, Dispatch adopts it in place.
- Snapshot the database with `VACUUM INTO`, which is safe even while a server has the source open and yields one consistent file:

  ```bash
  mkdir -p .dispatch/userdata
  rm -f .dispatch/userdata/state.sqlite*  # VACUUM INTO refuses to overwrite
  # Set LIVE_STATE_SQLITE to the actual live state.sqlite path first.
  bun -e "new (require('bun:sqlite').Database)(process.env.LIVE_STATE_SQLITE, { readonly: true }).run(\"VACUUM INTO '.dispatch/userdata/state.sqlite'\")"
  ```

  A plain `cp` is only safe when no server has the source open, and must bring the `-wal` and `-shm` siblings along. A live file copy is a corrupt copy.

- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Smallest proof that the change works. `vp test run <files>` for the tests you touched, targeted lint and typecheck for the scope you changed.
- Test meaningful logic or observable behavior. Do not render components to static markup to assert props or attributes, or add tests that merely assert callback wiring or mirror the implementation.
- **Do not run repo-wide checks.** No `vp check`, no `vp run -r test`, no `vp run -r typecheck` unless I ask. CI owns the full suite.
- Backend behavior changes ship with focused tests for that behavior.
- The server is event-sourced and its async flows emit typed receipts. Wait on receipts and worker drains, never on sleeps or polling. A test that needs a timeout to pass is wrong.
- Upon request, user-visible frontend changes should get one integrated pass in a real client: `test-dispatch-app` for web, `test-dispatch-mobile` for mobile. The primary agent does this once after integrating. Subagents do not launch their own dev servers. Ask permission before doing computer use or spinning up browsers.

For authorized mobile verification, a missing or outdated native client is a build step, not a blocker. Run `node scripts/mobile-native-client.ts ensure <ios|android> <device-id>` on the simulator host before starting Metro. It checks the local Expo fingerprint and builds/installs when needed. See `test-dispatch-mobile` for the full workflow.

## Desktop releases and update feeds

Every distributed desktop release must remain updateable in place. A feedless Stable, Preview, or Nightly package is a release blocker, not an acceptable shortcut. Pull-request CI artifacts may remain explicitly download-only; never install a mock-update fixture as a user's real application.

- Package `app-update.yml` for `eminuckan/dispatch` and publish the matching channel manifests and referenced update artifacts: Stable uses `latest`, Preview uses `preview`, and legacy Nightly uses `nightly`. Include the macOS updater ZIP as well as the DMG, correct platform/architecture entries, hashes, and any generated blockmaps. Preview manifests must not leak into Stable or Nightly feeds.
- Preserve the canonical application/bundle identity and signing/notarization requirements. Stable and Preview replace the same installed Dispatch app without deleting user data. Keep installed/package/feed versions consistent and strictly increasing; switching Preview back to Stable must never downgrade.
- Official builds must include the public `DISPATCH_CONNECT_URL` (`https://connect.opendispatch.dev` by default). Verify Sign in and Create account are reachable in the packaged client, not only in a dev build. Never ship hosted JEV keys, account tokens, or other server secrets with the app.
- Before calling a release ready, inspect the packaged update configuration and published manifests, then verify check/download/install/restart from an older supported build, retained user state, and What's New for the installed version with persistent dismissal. Do not equate a configured feed with a published, working feed or report signing as notarization.
- A one-time manual replacement is allowed only to bootstrap an old feedless installation. Subsequent releases must use the updater; uninstalling the app or clearing its data must not become the normal update procedure. Follow [the release and isolated updater validation procedure](docs/operations/release.md), including the macOS LaunchServices restart-isolation checks for test fixtures.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images. Motion or timing needs a short video.
- Upload PR evidence to GitHub. Never commit PR-only screenshots or assets such as `.github/pr-assets/`.
- One concern per PR. If the description says "also", split it.
- When babysitting: poll checks and comments newer than the last push, verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## Documentation

Most code changes do not need an internal documentation change. Agents can read the code.

- `docs/internals/` is for architectural decisions and their reasons, constraints that span components, and implementation traps that are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the relevant code answers the question, leave it out.
- Do not document every feature, enumerate fields or methods, narrate control flow, maintain file catalogs, or append PR summaries. Types, tests, and code already record the implementation. The glossary defines shared vocabulary; it is not a feature index.
- Keep a local implementation explanation in a nearby code comment. Use an internal doc when the reasoning crosses boundaries or needs context the code cannot carry well. Link to the relevant source instead of copying it.
- When a documented decision or constraint changes, rewrite or remove the affected text. Do not append another account of the new behavior. A new internal page needs a distinct, durable reason to exist.
- `docs/user/` helps users accomplish tasks. Give each major feature a concise section explaining what it does, how to start, and anything unintuitive. A settings path is useful; descriptions of visible buttons, icons, layouts, animations, or every UI state are not. Before adding text, ask what task or decision it helps the user with.
- Keep user docs in the shipped product's voice, without implementation details or contributor tooling. Update the relevant feature section when how to use it changes. A UI tweak does not need a documentation entry, and a new control does not need its own page.
- `docs/operations/` holds maintainer setup, release, and debugging procedures. Keep instructions for operating an installed Dispatch server in the user guides.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree. `.plans/` is gitignored only as a safety net for legacy tooling.
- Track active maintainer work in the GitHub issue or project item that owns it. External proposals follow `CONTRIBUTING.md` and belong in Ideas discussions.
- A merged PR is the implementation record. Close or update its tracking item when the work lands; do not preserve a second checklist in the repository.

## How it works

Clients send typed WebSocket requests. The server turns them into _commands_, a pure _decider_ turns commands into persisted _events_, and a _projector_ derives the read model the UI renders. Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into orchestration events. Side effects run in queue-backed _reactors_ that emit _receipts_ when milestones land. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore.

Full glossary with file links: `docs/internals/glossary.md`

## Where code lives

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read `.repos/effect-smol/LLMS.md` before writing Effect code.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it, `apps/mobile` is React Native, `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client code shared by web and mobile.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them. Sync with `vpr sync:repos` when bumping the matching dependency.

## Taste

- Apply the nested radius rule to every rounded surface in web, desktop, and mobile. For adjacent nested corners, keep them concentric: `outer radius = inner radius + total inset`. Include hover, pressed, selected, and keyboard-focus backgrounds in this check, even when the inner surface is transparent at rest.
- Preserve existing radii when correcting spacing. Derive padding or margin from the radius difference and count every intervening layout border, wrapper, gap, and offset on both axes. For a bordered parent, `padding = outer radius - inner radius - border width`; an overlaid pseudo-element border consumes no layout space. Keep the two insets meeting each rounded corner equal, and update any dependent height, overlap, or clipping geometry together. Prefer the shared component and existing geometry tokens over local overrides.
- Check actual corner pairs, not merely rounded descendants. Flush clipping layers share one contour. Nested circles and pills follow the same rule using their rendered, size-clamped radii; overlapping drawers and controls outside the parent's corner arc are separate surfaces. Layers separated by more than 24px may use independent radii. If preserving both radii makes a positive concentric inset impossible, move the inner content clear of the corner arc instead of changing the radii or clipping the hover/focus state. Review compact/expanded layouts, narrow widths, and scroll boundaries whenever those states exist.
- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Inferred types over annotations. `any` is the enemy.
- Comments describe how a thing is used, and move when the code moves. To be used mostly to describe functions, not to annotate every line of behavior.
- Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Don't verify with browsers or computer use unless the user explicitly agrees or requests it.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
