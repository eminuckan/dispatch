# Updating Dispatch

Packaged Dispatch desktop builds update in place through Dispatch releases. Source checkouts continue to update through Git.

## Before you update

Installing an update restarts Dispatch and can interrupt active agent turns and terminal commands. Saved threads, settings, project files, and other Dispatch state stay in the same state directory; the desktop updater replaces the application build, not that state directory.

**Settings → General → Continue threads after restarts** is off by default. Enable it when you want supported active threads to resume after a restart. Terminal commands can still be interrupted, and a provider without saved resume state may need a new message after the server returns.

## Packaged desktop updates

Open **Settings → About** to check for an update or choose an update track:

- **Stable** follows regular Dispatch releases.
- **Preview** follows opt-in prereleases so you can try changes before the next stable release.

Dispatch never installs an older version as an automatic downgrade. This matters when switching from Preview back to Stable: if the installed preview is newer than the current stable release, Dispatch stays on the installed version until a stable release with a higher semantic version is available. It does not repeatedly offer the older stable build.

The updater uses channel-specific release manifests, so Stable and Preview do not discover each other's release train accidentally. Preview builds retain their preview identity while installed, and changing the selected track persists across restarts.

Stable and Preview use the same existing platform signing pipeline. When release signing credentials are configured, the macOS updater artifacts go through the same signing and notarization steps and Windows goes through the same release-signing steps on either track. Changing update tracks does not bypass or replace those checks.

### What's New

When an in-app update discovers a release, Dispatch stores that release's actual release notes with the exact target version. After the matching version is installed and opened, Dispatch can show **What's New** once for that installed version. Dismissing it is remembered per version.

Release-note Markdown is rendered without raw HTML or remote images. External links are restricted to HTTP or HTTPS and open through the desktop shell. If the updater did not receive a release body, the dialog falls back to the release page instead of inventing notes.

### Older preview builds

Some older preview binaries were intentionally packaged without updater feed metadata. A binary that has no update feed cannot bootstrap itself onto the new Preview channel, even after the server-side release pipeline starts publishing preview manifests.

Install one newer trusted Dispatch desktop build manually over the existing application to cross that boundary. Your Dispatch state remains in the same state directory. Once a feed-capable build is installed, future Stable or Preview updates can use the in-app updater normally. A manually bootstrapped build may not show What's New for that first replacement because the older binary never received and stored that release's notes.

## Update a source checkout

Stop the Dispatch processes started from that checkout, then update the repository:

```bash
git pull --ff-only
vp i
```

For development, start the client you use again:

```bash
vp run dev
```

or:

```bash
vp run dev:desktop
```

For built server or desktop output, rebuild first:

```bash
vp run build:desktop
```

Then restart the process or local artifact you normally use. If the server and client run on different machines, update the machine named by the version warning and keep both sides on compatible revisions.

The canonical CLI update command is `dispatch update`; `t3 update` remains a legacy compatibility alias. A source checkout should still update through Git as described above.

## Mobile builds

Dispatch does not currently advertise a public App Store or Google Play release. Update a locally built mobile client from the same Dispatch checkout and rebuild it when its native runtime changes.
