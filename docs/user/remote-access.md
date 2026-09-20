# Remote access

Connect a phone, browser, or another desktop app to Dispatch running on a different machine. The host
must stay running and reachable while you work.

Dispatch has no product account, login, logout, or profile flow. The normal remote paths are direct
pairing over a LAN or private network, Tailscale, and desktop-managed SSH.

The command examples below use the canonical Dispatch launcher name `dispatch`. A packaged Dispatch
build may also provide `t3` as a legacy compatibility alias. A source checkout does not install either
launcher globally; from the repository root, use
`node apps/server/dist/bin.mjs <subcommand>` after `vp run build:desktop` when you need the same CLI
subcommand from a source build.

## Pair over a LAN or private network

Use direct pairing when the client can reach the host's network address. Pairing authorizes the client
to reconnect without a Dispatch account.

On a desktop host, open **Settings → Connections**, enable **Network access**, then create a pairing
link using an address the other device can reach. Changing network access restarts the desktop app. You
can turn it off in the same place.

For a command-line host, replace `<private-ip>` with the host's LAN or tailnet address:

```bash
dispatch serve --host <private-ip>
```

If a server is already running, generate a fresh link without restarting it:

```bash
dispatch pair
```

Scan the QR code on your phone or paste the pairing URL into **Add environment** in the receiving app.
Connection settings are under **Settings → Connections** on web and desktop and **Settings →
Environments** on mobile. A loopback address such as `127.0.0.1` reaches only the device opening the
link.

Use a fresh one-time pairing link for each new device. You do not need the original token to reconnect
after pairing succeeds. Links created in Settings can only be copied from the client that created them
while its Connections page stays open. If you leave or reload that page, create another link to share.

### Balance new threads across machines

Auto balance is off by default. On web and desktop, enable it in **Settings → Connections → Load
balancing** to automatically choose a machine for new threads in projects grouped across connected
environments. The section appears once two or more machines are switched on.

Each machine starts at **Normal**. Choose **Prefer** to favor it when it has CPU and memory available,
**Less often** to reduce its share, or **Manual only** to exclude it from automatic selection. These are
preferences, not fixed traffic percentages. Preferences are saved separately in each client.

The composer checks eligible machines when choosing a draft's environment, then keeps that choice
stable. Choose **Auto balance** again to check current resources, or choose a specific machine to
override it. Choosing a branch or worktree also keeps the draft on that machine. Existing threads stay
where they started. If resource checks are unavailable or all eligible machines are full, choose a
machine manually to continue. Mobile keeps its manual environment selection.

## Tailscale HTTPS

Join both devices to the same tailnet. In the desktop app, enable **Tailscale HTTPS** in **Settings →
Connections**. Turn it off there to remove that route.

To start a command-line server with Tailscale HTTPS:

```bash
dispatch serve --tailscale-serve
```

For an already-running server:

```bash
dispatch pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`. The mapping created by
`pair --tailscale` persists across restarts. Remove its default-port mapping with:

```bash
tailscale serve --https=443 off
```

If that port is already in use, choose another with `--tailscale-serve-port`. See
`dispatch pair --help` for other pairing options.

## Desktop-managed SSH

In the desktop app, open **Settings → Connections → Add environment**, choose **SSH**, and enter a host
or SSH alias such as `user@example.com`. Dispatch starts or reuses a server there and opens the port
forward for you. Projects, provider credentials, and agent work stay on the remote machine.

The remote host must be Linux or an Apple Silicon Mac with `curl` or `wget`, `tar`, `sha256sum` or
`shasum`, and [provider setup](./install.md#providers). On a fresh host, the first launch downloads
Dispatch's server under `~/.dispatch/runtime`, so it takes longer than later ones. If the host already
has a legacy `~/.t3/runtime`, Dispatch adopts that runtime tree in place instead of copying it.

Provider CLIs must be on the `PATH` of a non-interactive login shell there; check with:

```bash
ssh user@example.com 'sh -lc "command -v claude codex"'
```

If SSH reconnecting fails after an app update, retry the launch once. Removing the connection stops a
server that Dispatch launched; a server that was already running is left alone.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device). That provider login is
separate from Dispatch itself.

## Browser access

Dispatch does not currently publish its own hosted web endpoint. Use the web client served by your
Dispatch environment or open a direct pairing URL in a browser that can reach the host. A pairing link
does not make an unreachable backend reachable or convert HTTP to HTTPS.

For a plain HTTP LAN endpoint, open the direct pairing URL from a browser on that network or pair from
the desktop app. On mobile, an IP address entered without a scheme uses HTTP, so include `https://`
when your server uses HTTPS.

## Manage or revoke direct access

On the host, **Settings → Connections** lets authorized administrators create pairing links and revoke
client sessions. Revoking an unused link prevents new pairings; revoke a device's session to remove its
existing access. Command-line management is available through `dispatch auth --help`.

A session with an open connection stays listed after its access credential expires.

Treat pairing URLs and authorization codes as passwords. Do not include them in screenshots, logs, or
bug reports.

## Legacy T3 Connect compatibility

T3 Connect and Clerk remain optional compatibility for deployments that still use the upstream
authenticated relay. They are cloud-disabled by default in Dispatch and are not the normal setup path.
Dispatch does not expose a product account, login, logout, or profile UI for this compatibility mode.
Keep this path only for existing deployments until Dispatch has an accountless relay-auth mechanism.

An existing legacy deployment may still have a previously established authenticated relay session.
When that session is available, Dispatch can keep using it for managed relay discovery, environment
connectivity, and relay-backed mobile push. New users should use direct pairing, Tailscale, or SSH
instead of establishing a T3 Connect account.

The legacy CLI surface remains available where the build includes the required cloud configuration:

```bash
dispatch connect
dispatch connect status
dispatch connect unlink
dispatch connect logout
```

These commands exist for compatibility with the upstream relay workflow. `dispatch connect` and
Clerk-backed authorization are not part of Dispatch's ordinary accountless user flow. Do not configure
upstream T3 Connect values in a normal cloud-disabled build just to enable these commands.

### Legacy relay troubleshooting

`dispatch connect status` reports saved legacy authorization and link configuration; it is not a live
reachability check. If a previously linked environment appears offline, run `dispatch service status`
and read the displayed log. If the service disappears when SSH closes, see
[background-service troubleshooting](./background-service.md#troubleshooting).

| Error                                                     | Recovery                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `environment_link_limit_exceeded` or managed tunnel limit | Deregister an unused environment using the legacy deployment's administration path, then restart Dispatch on the host.           |
| `auth_invalid` or `invalid_bearer`                        | The stored legacy relay authorization is no longer usable. Restore it only through the deployment's existing compatibility flow. |
| Expired or invalid link proof                             | Check the host's date and time, update Dispatch, then restart it.                                                                |
| HTTP 403 without a recognized error                       | Check relay access, proxies, and firewall rules. Keep any Cloudflare Ray ID for a bug report.                                    |
| HTTP 408, 429, or 5xx                                     | Check network and relay availability. Startup retries temporary failures for up to ten minutes.                                  |

After fixing a permanent rejection, restart the host's server. On Linux, use
`systemctl --user restart t3code.service` for the compatibility service identifier. For a foreground
server, stop it and run `dispatch serve` again with your usual options. Include the diagnostic message
and trace ID when reporting a persistent failure.

For a connection that still fails after linking, check the date and time on both devices. For server
version warnings, follow [Updating Dispatch](./updating.md).

## Using the Desktop App as a Remote Only

If a computer should only drive work running elsewhere, turn off its local environment. In the desktop
app, open **Settings → Connections** and switch off **Local environment**. Dispatch restarts without a
local server: no local agents or terminals run, WSL backends stay off, and other devices can no longer
connect to this computer. Your projects, history, and saved connections are kept, and you keep working
through direct pairing, Tailscale, or SSH.

Switch **Local environment** back on in the same place to restart with your previous local settings.
