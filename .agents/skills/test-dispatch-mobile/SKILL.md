---
name: test-dispatch-mobile
description: Test Dispatch's native iOS and Android app through its Device panel and returned AgentDevice command. Use for mobile verification, native-client builds, Metro launch, and mobile pairing against isolated development state.
---

# Test Dispatch Mobile

## Open the device

Call `device_list`, then `device_open` with the selected host and device IDs.
Dispatch boots the device and shows its live stream in the Device panel. Follow its
returned `quickStart`, using the exact `agentDevice.command` and all `targetArgs`
on every operation. Use `device_screenshot` to inspect the screen.

If Dispatch device tools or the selected device are unavailable, report the blocker
and stop verification. Do not install or switch to another automation system.

## Use an isolated backend

Reuse this task's healthy backend. Otherwise run `vp run dev` from the
repository root, retain its terminal session, and read the actual backend port
from the dev-runner output. Use the worktree's ignored `.dispatch` state. If the
worktree already contains only legacy `.t3` state, Dispatch may adopt it in place.
Never run against a live install's `userdata` directory. The Browser panel is not required for this workflow.

Test with meaningful project and thread data. Read the shared
[SQLite fixture reference](../test-dispatch-app/references/sqlite-fixtures.md) only
when inspecting or seeding SQLite. Stop the test server before fixture writes.

## Launch Dispatch Dev

For a booted iOS simulator or Android emulator, run this maintained build helper
from the checkout being tested on the selected device host:

```bash
node scripts/mobile-native-client.ts ensure <ios|android> <device-id>
```

This reuses a matching native client or builds and installs one. Authorized
mobile verification includes that build step unless the user prohibits it.
The helper handles native build and installation; use the returned AgentDevice
command for screen interaction instead of ad-hoc `simctl`, `adb`, or `xcrun` commands.

Start `vp run dev:client` from `apps/mobile`, or reuse a healthy Metro belonging
to this checkout. Open its printed development-client URL with AgentDevice
`open com.eminuckan.dispatch.dev <url>` and all returned target arguments.
The device must be able to reach both Metro and the isolated backend.

## Pair and verify

Use the helper from the repository root, with the returned executable and target
arguments stored in `agent_device_command` and the Bash array
`agent_device_target_args`:

```bash
.agents/skills/test-dispatch-mobile/scripts/pair-client.sh \
  <server-port> <base-dir> <device-reachable-backend-origin> \
  "$agent_device_command" "${agent_device_target_args[@]}"
```

It issues a fresh credential and opens the Dispatch development client's existing pairing route
through AgentDevice. Automatic pairing is development-only; target Dispatch Dev,
not a Preview or production client. For a backend on the device host, use
`http://127.0.0.1:<server-port>` on iOS or `http://10.0.2.2:<server-port>`
on Android. For a remote backend, use its reachable origin.

Confirm the intended projects appear, exercise the affected flow, and capture
evidence. Retain the app and environment while iterating. At teardown, remove
the disposable connection, close the AgentDevice session, call `device_close`,
and stop only your backend and Metro processes.
