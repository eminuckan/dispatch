# Install Dispatch

Dispatch runs coding agents on your computer and lets you control them from its web and desktop clients. The Dispatch fork does not currently publish its own installer or packaged release endpoint, so the supported setup for this repository is a source checkout.

Do not use upstream installers, release artifacts, or package-manager entries to install Dispatch. Those install the upstream project rather than this fork.

## Requirements

Install these on the machine where the agents will run:

- Git.
- Node.js 24.
- Vite+ and its `vp` command.
- At least one authenticated coding-agent provider.

Install `vp` on macOS or Linux:

```bash
curl -fsSL https://vite.plus | bash
```

On Windows PowerShell:

```powershell
irm https://vite.plus/ps1 | iex
```

## Clone and run Dispatch

```bash
git clone https://github.com/eminuckan/dispatch.git
cd dispatch
vp i
```

For the local server and web client:

```bash
vp run dev
```

For the Electron desktop client:

```bash
vp run dev:desktop
```

The development runner prints the local address or pairing URL to open. Fresh linked worktrees keep isolated development state under `.dispatch`; an existing worktree-local `.t3` is adopted in place for compatibility. Keep that development state separate from any live installation.

## Build from source

Build the desktop and server bundles with:

```bash
vp run build:desktop
```

You can run the built server directly:

```bash
node apps/server/dist/bin.mjs
```

Local desktop artifacts are available through the platform packaging commands in the [development runbook](../operations/development.md#desktop-artifacts). They are local builds and do not create or configure a Dispatch release channel.

The current source tree retains several upstream compatibility identifiers. In particular, the legacy CLI alias `t3`, `.t3` data directories, `T3CODE_*` environment variables, service identifiers, and some wire values may still appear in commands or paths. Those identifiers are compatibility details; the canonical CLI and product name are Dispatch.

## Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects there. Install provider CLIs inside that distro. Dispatch can provision its server runtime into WSL when the desktop build contains the required runtime payload.

## Open a project from a terminal

Packaged Dispatch builds use the `dispatch` launcher and may also expose `t3` as a legacy compatibility alias. When the launcher comes from a Dispatch build and the desktop app is already running on the same machine, this command opens the current directory:

```bash
dispatch app
```

Pass a path, such as `dispatch app ../my-project`, to open another directory. A source checkout by itself does not install the launcher globally.

## Mobile app

The repository contains a mobile client, but this fork does not currently advertise a Dispatch App Store or Google Play release. Use the source-built web or desktop client for normal setup until Dispatch publishes its own mobile distribution.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment, and enable the provider you want. Installation, login, and configuration belong to that environment's machine, even when you connect from another computer.

| Provider    | Install and authenticate                                                                     |
| ----------- | -------------------------------------------------------------------------------------------- |
| Codex       | Install [Codex CLI](https://developers.openai.com/codex/cli), then run `codex login`.        |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`. |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                        |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                           |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                     |
| Antigravity | Install and sign in with Google from Dispatch's provider settings.                           |

Provider CLIs must be on the server's `PATH`. If Dispatch cannot find one, set its **Binary path** in provider settings, especially when using a version manager. Cursor's executable is `cursor-agent`, although its login command is `agent login`. Antigravity can use its managed runtime without a `PATH` entry.

When a provider CLI is behind its latest release, its provider card can show the available version and, when Dispatch recognizes the provider's installer, offer **Update now**. Otherwise update the provider CLI the same way you installed it.

Add another provider instance for a separate account or configuration. Each instance can have its own environment variables, such as API keys or a custom base URL. Mark secret values as sensitive; after saving, Dispatch does not display their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md), [Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and [Antigravity](./providers-antigravity.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating Dispatch](./updating.md): update a source checkout and rebuild it.
