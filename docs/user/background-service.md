# Running Dispatch in the background

Dispatch can host agents without keeping the desktop window open. A source checkout does not install a global background service automatically; packaged Dispatch builds can provide the canonical `dispatch` launcher and service commands.

## Source checkout

Build the server bundle first:

```bash
vp run build:desktop
```

Then run the server from the repository:

```bash
node apps/server/dist/bin.mjs serve
```

For unattended use, run that command under the process manager you already use on the host. Keep its working directory on the Dispatch checkout and preserve the same user account and state directory between restarts. Update a source checkout through Git as described in [Updating Dispatch](./updating.md).

Fresh Dispatch installs use `~/.dispatch` for state. Existing `~/.t3` or `~/.t3-jev` homes can still be adopted in place for compatibility, so upgraded installations may continue to show a legacy path.

## Packaged Dispatch launcher

Dispatch builds use `dispatch` as the canonical launcher. The legacy `t3` command remains a compatibility alias where a Dispatch build provides it. Use either launcher only when it came from a Dispatch build configured for your release channel; installing the upstream package just to obtain `t3` installs the upstream project instead.

| Task                            | Command                      |
| ------------------------------- | ---------------------------- |
| Install and start               | `dispatch service install`   |
| Inspect status and log location | `dispatch service status`    |
| Restart                         | `dispatch service restart`   |
| Stop and remove from startup    | `dispatch service uninstall` |

Uninstalling the service leaves projects, threads, and settings intact. Running `dispatch service install` again can repair a service that `dispatch service status` reports as broken.

`dispatch update` is available to a packaged Dispatch build, and `t3 update` remains its compatibility alias. Both require a Dispatch release channel. Update source checkouts through Git, and use Dispatch-owned release artifacts rather than pointing either command at upstream releases.

## Platform support

Linux service installation uses systemd user services and can enable lingering so Dispatch starts at boot and stays running after logout. macOS service installation uses a per-user LaunchAgent and runs while that user is logged in. Windows background services are not supported by the compatibility service command.

## Troubleshooting

For a Dispatch-built compatibility launcher, start with:

```bash
dispatch service status
```

On Linux, if the service stops when the SSH session closes, check whether lingering is enabled:

```bash
loginctl show-user "$(id -un)" --property=Linger
```

An administrator can enable it with:

```bash
sudo loginctl enable-linger "$(id -un)"
```

The Linux service name and macOS LaunchAgent identifier currently retain their compatibility spellings, including `t3code.service` and `com.t3tools.t3code.service.plist`. Those are service identifiers, not the Dispatch product name.
