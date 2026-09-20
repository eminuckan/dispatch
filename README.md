# Dispatch

Dispatch is an open-source control surface for coding agents. It runs the agent tooling on your machine and gives you one place to manage threads, terminals, projects, remote environments, model routing, and agent teams across the web and desktop clients.

Dispatch works with existing provider setups for Codex, Claude Code, Cursor, Grok Build, OpenCode, and Google Antigravity. Install and authenticate the providers you use on the machine where Dispatch will run them.

This repository is the canonical Dispatch source: <https://github.com/eminuckan/dispatch>.

## Current installation path

Dispatch does not currently publish its own installer or packaged release endpoint. Until that exists, build and run it from this repository instead of using upstream installers, release artifacts, or package-manager entries.

You need Node.js 24 and the Vite+ `vp` command.

### Install `vp`

macOS / Linux:

```bash
curl -fsSL https://vite.plus | bash
```

Windows PowerShell:

```powershell
irm https://vite.plus/ps1 | iex
```

Then clone Dispatch and install dependencies:

```bash
git clone https://github.com/eminuckan/dispatch.git
cd dispatch
vp i
```

Run the server and web client for local use:

```bash
vp run dev
```

Or run the Electron desktop client:

```bash
vp run dev:desktop
```

For local desktop artifacts, use the platform packaging commands documented in [Development](./docs/operations/development.md#desktop-artifacts). Those artifacts are local builds; this README will point at Dispatch releases once the fork has its own release channel.

The source tree still contains compatibility identifiers inherited from upstream, including the `t3` launcher, `.t3` data paths, and `T3CODE_*` environment variables. Treat those spellings as runtime identifiers rather than the product name.

## Providers

Before starting a thread, install and authenticate at least one provider:

- Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.
- Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`.
- Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`.
- Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`.
- OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`.
- Antigravity: enable it in provider settings, then use **Install Antigravity** and **Sign in with Google**.

## Documentation

User guides live in [docs/user](./docs/user), with the full documentation index in [docs/README.md](./docs/README.md).

- [Install and first run](./docs/user/install.md)
- [Messages and context](./docs/user/composer.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Remote access](./docs/user/remote-access.md)
- [Source control integrations](./docs/user/source-control.md)
- [Provider guides](./docs/README.md#using-dispatch)

For development, start with the [development runbook](./docs/operations/development.md) and [CONTRIBUTING.md](./CONTRIBUTING.md).

## Upstream & license

Dispatch is an independent fork of [T3 Code](https://github.com/pingdotgg/t3code), originally created by T3 Tools. Thanks to the T3 Code contributors for the open-source foundation this fork builds on.

Dispatch retains the upstream MIT license and copyright notices. See [LICENSE](./LICENSE) for the license text and attribution.
