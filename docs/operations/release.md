# Dispatch release workflow

Dispatch releases are published from the canonical repository:

`https://github.com/eminuckan/dispatch`

The core release contract is the GitHub Release produced by `.github/workflows/release.yml`.
Publishing to services outside GitHub is safe by default: the legacy npm packages, the compatibility
AUR package, the hosted web app, and the marketing site are all skipped
unless their Dispatch-owned repository gate is explicitly set to `true`.

The platform build implementation lives in `.github/workflows/release-desktop.yml`. It packages the
single JS bundle built by the main workflow, builds native helpers, produces desktop installers, and
builds the self-contained CLI archives used by installers, updates, SSH runtimes, and Windows WSL.

## Release channels and triggers

The workflow has three channels:

| Channel   | Trigger                               | Commit                                                                                                                     | GitHub Release behavior                                                                                                                                  |
| --------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stable`  | `v*.*.*` tag push, or manual dispatch | A pushed tag builds that exact tagged commit. A manual stable release builds the commit from the latest published nightly. | Plain `X.Y.Z` is the repository latest release. A suffixed version such as `X.Y.Z-rc.1` is a prerelease.                                                 |
| `nightly` | schedule or manual dispatch           | Scheduled and manual nightlies use the selected default-branch commit.                                                     | GitHub prerelease with `vX.Y.Z-nightly.YYYYMMDD.<run>` tag.                                                                                              |
| `preview` | manual dispatch only                  | The selected commit, including a branch commit.                                                                            | Opt-in GitHub prerelease with `vX.Y.Z-preview.YYYYMMDD.<run>` tag, a dedicated desktop updater feed, and a warning prepended to generated release notes. |

Manual dispatch defaults to `preview`. Stable and nightly manual releases must be dispatched from
the repository default branch; preview is the branch-build path.

Scheduled checks run at minutes 8 and 38 of every hour. A scheduled nightly is skipped when the
latest published nightly is less than six hours old or when the candidate commit has no new commits
after that nightly. Manual nightlies bypass those two scheduled-release checks.

Nightly and preview versions use the next patch after the stable core version in
`apps/desktop/package.json`. For example, a current stable core of `0.0.42` produces
`0.0.43-nightly...` or `0.0.43-preview...`.

A manual stable release promotes the latest published nightly commit. Its version defaults to the
stable version that nightly previewed; the optional `version` workflow input can override it. A tag
push remains the escape hatch when a specific tagged commit must be released instead.

## Core GitHub Release graph

The normal graph is:

1. `resolve_commit` chooses the commit and applies the channel source rules.
2. `preflight` resolves the release version, tag, previous tag, prerelease state, and release name.
3. `quality` runs `vp check`, `vp run typecheck`, and `vp run test`.
4. `build_bundle` aligns package versions and builds the platform-independent server, web client, and
   Electron main process once.
5. Six platform jobs call `release-desktop.yml` to package that shared bundle and build native pieces.
6. `publish_cli` optionally publishes the legacy npm compatibility packages. A skipped job is valid.
7. `release` publishes the GitHub Release after quality and all platform jobs succeed. It explicitly
   accepts `publish_cli` as either successful or skipped.
8. AUR, hosted web, marketing, stable version finalization, and Discord announcement run afterward
   according to their own conditions.

GitHub Release publication therefore does not require npm, AUR, a hosted web deployment, or a marketing
deployment. Enabling one of those integrations can make that integration's own job a
release dependency where the workflow says so; leaving its gate unset keeps the independent Dispatch
release path available.

## Produced artifacts

The workflow builds these desktop targets on native-architecture runners:

- macOS arm64 and x64 DMG builds. The packaging output also includes the macOS zip used by
  `electron-updater`.
- Linux x64 and arm64 AppImages.
- Windows x64 and arm64 NSIS installers.

Every target except macOS x64 also builds and smoke-tests a self-contained CLI archive on matching
hardware. macOS x64 has no CLI archive because the Node single-executable path used here is not
supported reliably on x64 macOS.

The current archive filenames intentionally retain the compatibility format
`t3-<version>-<platform>-<arch>.tar.gz` or `.zip`. The installed product command is `dispatch`; the
installers also keep `t3` as a legacy launcher alias. Use `dispatch` in operator documentation and
commands. Treat the `t3-*` archive filenames as persisted release-format compatibility, not as the
Dispatch product name.

The GitHub Release also contains `SHA256SUMS` generated from the final archive bytes. Windows builds
embed the same-architecture Linux CLI archive as their WSL runtime, so the WSL payload is the same
archive published for Linux.

Stable, nightly, and preview desktop releases include updater manifests and any blockmaps produced by
their targets. The release job merges the per-architecture macOS and Windows manifests back into the
single channel manifest expected by `electron-updater`. Preview is isolated by channel name rather
than by omitting metadata: macOS follows `preview-mac.yml`, Windows follows `preview.yml`, and Linux
follows `preview-linux.yml` or the architecture-suffixed equivalent. The Preview release job requires
Preview manifests and fails if `latest*` or `nightly*` manifests leak into that release.

## Safe-by-default external publishing gates

All gates below are GitHub repository variables. The workflow requires the literal string `true`.
Any other value, including an unset variable, leaves the integration disabled.

| Integration                       | Repository gate                       | Channels                 | When disabled                                                               |
| --------------------------------- | ------------------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| Legacy npm compatibility packages | `DISPATCH_RELEASE_PUBLISH_LEGACY_NPM` | stable, nightly, preview | npm publication is skipped and the GitHub Release can still publish.        |
| Legacy AUR compatibility package  | `DISPATCH_RELEASE_PUBLISH_AUR_COMPAT` | stable, nightly          | AUR publication is skipped. Preview never publishes AUR.                    |
| Hosted web deployment             | `DISPATCH_RELEASE_DEPLOY_WEB`         | stable, nightly          | hosted web deployment is skipped. Preview never deploys hosted web.         |
| Marketing deployment              | `DISPATCH_RELEASE_DEPLOY_MARKETING`   | nightly only             | marketing deployment is skipped. Stable and preview never deploy marketing. |

### Dispatch Connect public origin

Official release builds use `https://connect.opendispatch.dev` as the public Dispatch Connect origin.
This value is public configuration, not a credential. Operators of a release fork can override it with
the `DISPATCH_CONNECT_URL` repository variable. The release workflow passes the canonical name into
the shared JS bundle, reusable desktop/CLI packaging jobs, and hosted-web Vercel build; the existing
public-config loader expands it to `VITE_DISPATCH_CONNECT_URL` and
`EXPO_PUBLIC_DISPATCH_CONNECT_URL` where those build systems consume the public alias.

This release default does not change source/dev or self-hosted behavior. Outside the official release
workflows, leaving `DISPATCH_CONNECT_URL` unset continues to mean that Dispatch Connect is optional and
must be configured by the operator. `CONNECT_JEV_API_KEY`, environment credentials, account sessions,
and every other Connect server secret remain server-side and are never added to release build env.

### Legacy npm compatibility publication

The public npm names `t3` and `@t3code/t3-<platform>-<arch>` are legacy compatibility names. Dispatch
does not assume ownership of them and never publishes them unless
`DISPATCH_RELEASE_PUBLISH_LEGACY_NPM=true` is set.

When enabled, `publish_cli` downloads the already-built CLI archives, constructs the legacy npm
tarballs, dry-runs every package first, and then publishes with provenance. The dist-tag follows the
release channel: `latest`, `nightly`, or `preview`.

The npm trusted-publisher configuration must point at `eminuckan/dispatch` and
`.github/workflows/release.yml` for every legacy package being published. A failure after opting in is
a real release failure: the GitHub Release job accepts `publish_cli` only when it succeeded or was
skipped. With the gate unset, no npm ownership or npm credentials are required for the GitHub Release.

### Legacy AUR compatibility publication

Set `DISPATCH_RELEASE_PUBLISH_AUR_COMPAT=true` to run `.github/workflows/publish-aur.yml` after a
stable or nightly GitHub Release. The reusable workflow requires `AUR_SSH_PRIVATE_KEY` and publishes
the existing compatibility package definitions under `packaging/aur`.

This is a post-release integration. Leaving the gate unset has no effect on the GitHub Release.

### Hosted web deployment

Hosted web deployment is opt-in with `DISPATCH_RELEASE_DEPLOY_WEB=true`. It runs only after a
successful stable or nightly GitHub Release and never runs for preview.

The job requires these Vercel secrets:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

It also requires all three Dispatch-owned repository variables, with no built-in domain fallback:

- `DISPATCH_WEB_ROUTER_URL`
- `DISPATCH_WEB_LATEST_DOMAIN`
- `DISPATCH_WEB_NIGHTLY_DOMAIN`

`VERCEL_TEAM_SLUG` is optional and overrides the CLI scope; otherwise the job uses
`VERCEL_ORG_ID`.

Stable deploys alias the deployment to `DISPATCH_WEB_LATEST_DOMAIN` and to the host derived from
`DISPATCH_WEB_ROUTER_URL`. Nightly deploys alias only to `DISPATCH_WEB_NIGHTLY_DOMAIN`. The workflow
does not provide or infer any public Dispatch domain, so operators must configure domains they own.

### Marketing deployment

Marketing deployment is opt-in with `DISPATCH_RELEASE_DEPLOY_MARKETING=true` and runs only for
nightly releases after the GitHub Release succeeds.

It requires:

- secrets `VERCEL_TOKEN` and `VERCEL_ORG_ID`;
- repository variable `DISPATCH_MARKETING_VERCEL_PROJECT_ID`;
- optional `VERCEL_TEAM_SLUG` for the Vercel scope.

The job exports the explicit Dispatch project ID as `VERCEL_PROJECT_ID` before deployment. It does
not search for an upstream project name and has no fallback project lookup.

## Canonical release and updater identity

The canonical release repository is `eminuckan/dispatch`. CLI update discovery reads GitHub Releases
from that repository, and the default archive download base is its `releases/download` path.

Use `DISPATCH_RELEASE_BASE_URL` to point installers and the runtime updater at a mirror. Existing
installations may still supply `T3CODE_RELEASE_BASE_URL`; it is a compatibility fallback only, and
`DISPATCH_RELEASE_BASE_URL` wins when both are set.

The canonical CLI is `dispatch`. Typical operator commands are:

```sh
dispatch --version
dispatch update
dispatch update --channel nightly
dispatch service restart
```

The `t3` launcher remains available as a legacy alias for existing installations and scripts. New
documentation and automation should use `dispatch`.

Desktop updater metadata is configured with `DISPATCH_DESKTOP_UPDATE_REPOSITORY`. The release
workflow writes it from `${{ github.repository }}`, which resolves to `eminuckan/dispatch` in the
canonical repository. Direct/local builds may set it explicitly. The desktop artifact builder still
accepts `T3CODE_DESKTOP_UPDATE_REPOSITORY` as a migration fallback, then falls back to
`GITHUB_REPOSITORY` when neither explicit name is set.

Desktop Stable and Preview are update tracks of the same packaged application identity. Preview builds
ship a GitHub publish/update configuration with `channel: preview`; Stable uses the default `latest`
channel. `electron-updater` maps that custom channel to the platform manifest names above and scans
GitHub prereleases for the `preview` semver prerelease identifier. Stable installs keep
`allowPrerelease=false`, so they do not discover Preview releases. Preview installs explicitly reset
`allowDowngrade=false` after assigning the updater channel because `electron-updater` itself enables
downgrades whenever `autoUpdater.channel` is assigned.

The desktop layer also rejects any offered version that is not semver-newer than the installed build
and rejects a candidate whose version belongs to a different selected track. As a result, switching
from Preview back to Stable does not install an older Stable build or loop on it; the app waits until a
newer Stable version exists. GitHubProvider can fall back to a `latest` manifest when a prerelease
channel manifest is missing, so the track check is a deliberate second boundary rather than relying
only on manifest naming.

Preview used to be packaged without `app-update.yml`. Those older feedless binaries cannot discover
the new Preview feed by themselves and need one manual replacement with a feed-capable build. Preview
keeps the stable package/bundle filename so that bootstrap is an in-place application replacement;
Dispatch state remains under the existing state directory. Runtime branding still labels the running
build as Preview.

## Build-time Dispatch environment names

Release writers use Dispatch-owned names for current product configuration. The main values operators
are likely to see are:

- Dispatch Connect: `DISPATCH_CONNECT_URL`.
- Desktop update repository: `DISPATCH_DESKTOP_UPDATE_REPOSITORY`.
- CLI macOS signing identity: `DISPATCH_CLI_MAC_SIGN_IDENTITY`.
- native build-cache reuse: `DISPATCH_DESKTOP_REUSE_RESOURCE_MONITOR` and
  `DISPATCH_DESKTOP_REUSE_LINUX_CAPTURE_HELPERS`.

The build scripts retain `T3CODE_*` readers for these migrated settings where existing local operator
configuration may still depend on them. Treat those names as compatibility input only. GitHub release
writers use the `DISPATCH_*` forms.

## macOS signing and notarization

The reusable desktop workflow enables signed macOS packaging only when all of these secrets are
present:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

The CLI archive imports the same `CSC_LINK` certificate, discovers its Developer ID identity, and
writes that identity as `DISPATCH_CLI_MAC_SIGN_IDENTITY`. Without a Developer ID identity the macOS
CLI archive is ad-hoc signed. With the identity and Apple API key values present, the CLI archive is
also submitted for notarization.

For local migration only, the CLI builder still accepts `T3CODE_CLI_MAC_SIGN_IDENTITY`.
Prefer `DISPATCH_CLI_MAC_SIGN_IDENTITY` for new configuration.

## Windows signing

Windows signing uses Azure Trusted Signing. The desktop workflow enables it only when all of these
secrets are available:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

When the set is incomplete, Windows desktop packaging remains unsigned. The CLI archive uses the same
Azure account/profile credentials for its executable signing path.

## Stable finalization

After a successful stable GitHub Release, `finalize` checks out `main`, aligns release version strings,
refreshes the lockfile when needed, and pushes a `chore(release): prepare <tag>` commit through the
configured GitHub App.

The job uses:

- `RELEASE_APP_ID`
- `RELEASE_APP_PRIVATE_KEY`

This happens after the GitHub Release already exists. A finalization failure can make the workflow run
red, but it does not undo the published release.

Nightly and preview releases do not write version bumps back to `main`.

## Discord announcements

Preview releases are never announced. Stable and nightly announcements are best effort and use the
configured Discord webhook/role secrets. Announcement steps are `continue-on-error`.

Hosted web deployment is not mandatory for an announcement when
`DISPATCH_RELEASE_DEPLOY_WEB` is disabled: a skipped web job is accepted in that case. When web
deployment was explicitly enabled, the announcement waits for it to succeed.

## Release validation

There is no non-publishing release mode. Every accepted release run publishes a real GitHub
Release when the core jobs succeed:

- `preview` is manual-only, publishes a real prerelease plus its dedicated desktop updater metadata,
  and skips AUR, hosted web, and marketing. Its warning body is prepended to generated GitHub release
  notes. Legacy npm still publishes only if its gate is explicitly enabled.
- `nightly` publishes a real prerelease and updater feed metadata. Scheduled nightlies apply the
  six-hour/change checks; manual nightlies do not.
- `stable` publishes a real stable-channel release. A manual stable promotes the latest nightly
  commit; a pushed version tag builds the exact tagged commit.

Omitting signing credentials does not turn a release into a dry run. It only leaves the affected
platform artifacts unsigned or ad-hoc signed as described above.

Before promoting a stable release, verify the latest nightly you intend to promote. After starting
the stable workflow, confirm the `Resolve release commit` notice names the nightly tag and commit you
tested. If a newer nightly became the latest before the run resolved its commit, the workflow will
promote that newer nightly instead.

After publication, smoke-test the artifacts you actually ship. For CLI/update checks, use the
canonical command:

```sh
dispatch --version
dispatch update --channel nightly
```

For desktop Preview validation, inspect the published release assets before installing anything:

- macOS must contain the merged `preview-mac.yml` with both arm64 and x64 ZIP entries;
- Windows must contain the merged `preview.yml` with both arm64 and x64 installer entries;
- Linux must contain `preview-linux.yml` for x64 and `preview-linux-arm64.yml` for arm64;
- the Preview release must not contain `latest*.yml` or `nightly*.yml` updater manifests.

Then test from an older feed-capable packaged build: select Preview, check/download/install, verify the
same Dispatch state is present after restart, verify What's New appears only for the version actually
installed and stays dismissed after another restart, and finally switch to Stable while the available
Stable version is older to confirm no downgrade is offered. The first migration from an old feedless
Preview must be tested as a manual in-place application replacement instead.

For an isolated macOS updater E2E test, do not rely on shell-only environment overrides. Squirrel
relaunches the installed app through LaunchServices, so those overrides do not survive the restart.
Prepare throwaway base and target app bundles with the same distinct test bundle identifier, embed the
isolated state directory, Electron user-data directory, backend/feed ports, and mock-update settings in
`LSEnvironment` in both bundles, and give both `app-update.yml` files a unique `updaterCacheDirName`.
Re-sign both bundles after those fixture-only edits. Before downloading an update, launch the base app
through LaunchServices without exported isolation variables and verify its process environment, helper
`--user-data-dir`, backend port, and state path all resolve to the fixture. Keep live Dispatch state and
profiles out of the fixture; this procedure is only for updater validation, not release packaging.

If validating a mirror, set `DISPATCH_RELEASE_BASE_URL` for the test process rather than changing the
repository identity.

## Troubleshooting

- **GitHub Release did not run after legacy npm:** when
  `DISPATCH_RELEASE_PUBLISH_LEGACY_NPM=true`, npm publication must succeed. Disable the gate if the
  repository does not own/configure the legacy npm names.
- **Hosted web job fails immediately:** all three `DISPATCH_WEB_*` variables and the Vercel secrets are
  required. There are no domain defaults.
- **Marketing job fails immediately:** configure `DISPATCH_MARKETING_VERCEL_PROJECT_ID` plus the
  Vercel token/org credentials. The workflow does not discover a project by name.
- **macOS signing is unexpectedly disabled:** check the complete certificate and Apple notarization
  secret set above.
- **Windows signing is unexpectedly disabled:** check the complete Azure Trusted Signing secret set.
- **Desktop updates point at the wrong repository in a local build:** set
  `DISPATCH_DESKTOP_UPDATE_REPOSITORY=eminuckan/dispatch`. The release workflow already supplies the
  current GitHub repository automatically.
- **Preview build reports no update feed:** if it is an older feedless Preview, manually replace the
  application once with a current feed-capable build. For a current Preview, confirm `app-update.yml`
  names the canonical GitHub repository and the release contains the correct platform-specific
  `preview` manifest.
- **Preview update resolves the wrong architecture:** inspect the merged manifest file entries first.
  macOS `electron-updater` filters arm64 entries on Apple Silicon (including Rosetta) and excludes
  arm64 entries on x64 Macs; Windows selects the `.exe` entry containing the running `process.arch`.
  Keep architecture markers in artifact filenames when changing release naming.
- **CLI downloads should use a mirror:** set `DISPATCH_RELEASE_BASE_URL`. Keep
  `T3CODE_RELEASE_BASE_URL` only for older installations that have not migrated yet.
