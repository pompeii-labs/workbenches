# Releasing the Workbench CLI

The reference CLI is distributed as native standalone binaries attached to a
GitHub release. It is not currently published to npm, Homebrew, or another
package registry.

## Version and tag contract

`package.json` is the version source of truth for both source and compiled CLI
output. Release tags use the exact version prefixed with `v`:

```text
package version: 0.1.0-alpha.2
tag:             v0.1.0-alpha.2
```

The release workflow rejects `0.0.0` and any tag that does not exactly match the
package version. A version containing a SemVer prerelease suffix produces a
GitHub prerelease.

Before creating a tag:

```sh
bun install --frozen-lockfile
bun run check
bun run test:coverage
bun audit --audit-level=moderate
bun run release:package
```

Commit the version change, then create and push an annotated tag:

```sh
git tag -a v0.1.0-alpha.2 -m 'Workbench v0.1.0-alpha.2'
git push origin main v0.1.0-alpha.2
```

## Release artifacts

GitHub Actions builds on each target architecture rather than cross-compiling:

```text
workbench-darwin-arm64.tar.gz
workbench-darwin-x64.tar.gz
workbench-linux-arm64.tar.gz
workbench-linux-x64.tar.gz
checksums.txt
```

Each archive contains `workbench`, `LICENSE`, and `NOTICE`. The workflow runs the
compiled binary on its build host before uploading it, publishes SHA-256
checksums, and creates GitHub artifact attestations for provenance.

macOS binaries are ad-hoc signed by Bun but are not yet signed or notarized with
an Apple Developer identity. The project must not claim Apple notarization until
that separate release credential and workflow exist.

The workflow can be run manually from a branch to exercise verification and all
four native builds without publishing a release. Only a matching version tag can
run the publish job.

## Verification

Users can verify the checksum consumed by `install.sh` for a downloaded Linux
x64 archive directly:

```sh
grep 'workbench-linux-x64.tar.gz$' checksums.txt | sha256sum -c -
```

On macOS, use `shasum -a 256` with the selected checksum value. Once the public
repository has produced attestations, release assets can also be verified with
the GitHub CLI:

```sh
gh attestation verify workbench-darwin-arm64.tar.gz \
  --repo pompeii-labs/workbenches
```
