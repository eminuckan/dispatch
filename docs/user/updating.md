# Updating Dispatch

Dispatch does not currently publish its own installer, package channel, or hosted release endpoint. For a source checkout, update from the canonical repository and rebuild the client or server you run.

## Before you update

Updating or restarting a server can interrupt active agent turns and terminal commands. Saved threads, settings, and project files remain in the server's state directory.

**Settings → General → Continue threads after restarts** is off by default. Enable it when you want supported active threads to resume after a restart. Terminal commands can still be interrupted, and a provider without saved resume state may need a new message after the server returns.

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

## Packaged update controls

The source tree supports canonical `dispatch update` plus the legacy `t3 update` compatibility alias, along with background-service and client-driven update machinery. Those paths require a Dispatch-built release channel to be configured. Until Dispatch publishes that release channel, do not treat upstream packages or upstream update feeds as Dispatch updates.

If you create and operate your own packaged Dispatch build, use the release configuration for that build and follow the update action shown by that client. A source checkout should continue to update through Git as described above.

## Mobile builds

This fork does not currently advertise a Dispatch App Store or Google Play release. Update a locally built mobile client from the same Dispatch checkout and rebuild it when its native runtime changes.
