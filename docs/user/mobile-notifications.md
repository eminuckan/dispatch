# Mobile notifications

Dispatch can show alerts when an agent finishes, fails, needs approval, or asks for input. Tap a
notification to open its thread. Notification permission and Android notification channels are
controlled in system Settings.

Remote push delivery is currently a **legacy T3 Connect compatibility feature**. It is cloud-disabled
by default and requires an existing authenticated legacy relay session plus an environment with agent
activity publishing enabled. Dispatch does not present a login or account flow to create that session.
If no compatible legacy session already exists, the relay-backed notification and activity controls
remain unavailable. This compatibility path remains temporary until accountless relay authentication
replaces it.

Enable **Device Notifications** in **Settings → Notifications** when that legacy relay session is
already available. Enable **Ongoing Agent Activity** on Android or **Live Activity Updates** on iOS to
follow work without opening the app. Finished results remain visible for up to 15 minutes. You can
dismiss an Android activity card without disabling alerts; turn off ongoing activity in Settings to
stop future cards.

Ordinary alerts stay quiet while the mobile app is in the foreground. Ongoing activity continues to
update. Viewing a thread on another device does not silence your phone's alerts.

Android notifications require Android 7.0 or newer and Google Play services. Android 16 and newer can
promote ongoing activity to a Live Update, subject to system settings and device support. Other devices
show a regular ongoing notification. Android 7's battery-saving modes can delay removal of expired
cards.

Direct pairing, LAN access, and Tailscale securely connect the mobile client to an environment, but
they do not by themselves provide background push delivery. The legacy relay can deliver push while
the mobile app has no live environment connection. Force-stopping the Android app in system Settings
prevents push delivery until you open it again.
