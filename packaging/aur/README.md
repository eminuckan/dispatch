# AUR packaging

This directory maintains the [`t3code-bin`](https://aur.archlinux.org/packages/t3code-bin) and
[`t3code-nightly-bin`](https://aur.archlinux.org/packages/t3code-nightly-bin) packages. Both
names are retained as AUR compatibility identifiers; this repository does not claim that renamed
`dispatch-*` AUR packages have been published. The package sources repackage Dispatch's x64 AppImage
(`Dispatch-<version>-x64.AppImage`) from the
[`eminuckan/dispatch`](https://github.com/eminuckan/dispatch) GitHub Releases.

## Publishing

The release workflow calls `.github/workflows/publish-aur.yml` after publishing a GitHub release;
the workflow can also be run manually for a specific tag. It selects the stable or nightly
package, then updates its version and checksums, builds it, regenerates `.SRCINFO`, and pushes it
to the existing compatibility-named AUR repository. The checked-in PKGBUILDs are release templates;
publishing is only valid for a Dispatch tag whose release contains the matching AppImage.

To validate a release on Arch Linux:

```bash
sudo pacman -Syu --needed base-devel github-cli jq namcap
GH_TOKEN=$(gh auth token) RELEASE_TAG=v0.0.33 \
  packaging/aur/scripts/release.sh
```
