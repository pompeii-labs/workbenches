---
name: wb-publishing
description: Publish Workbenches and their runtime images to the workbenches.dev registry and share them. Use when signing the wb CLI in to an organization, storing a Workbench version for a team (internal), submitting one for public review, withdrawing a review submission, unpublishing, deleting a registry Workbench, pushing an OCI image for docker, e2b, or daytona runtimes, or helping someone install a published Workbench.
license: Apache-2.0
compatibility: Requires the Workbench (`wb`) CLI (see the wb-cli skill) and a workbenches.dev organization.
---

# Publishing Workbenches

The registry at workbenches.dev stores Workbench versions per organization. A version is **internal** (visible to members of its organization) until it is published; **public** versions are reviewed first. Every version is immutable.

Publishing is outward facing and hard to take back. Get the person's explicit go-ahead before `push`, `publish`, `withdraw`, `unpublish`, `delete --yes`, or `image push`, and confirm the organization and version you are about to use.

## Before publishing

1. The package passes `wb validate` and `wb smoke` on every declared runtime, and has been trialed on real tasks (see the wb-authoring skill).
2. The manifest `version` is higher than the last stored version. Bump it for any content change.
3. The package directory holds only what should ship. `wb push` uploads the whole directory with no ignore rules: make sure no `.env`, credential file, private notes, or build output sits inside it. Limits: 256 files, 10 MiB total, 2 MiB per file, no symlinks. `wb publish` never uploads a package.
4. For public versions: nothing private. No internal project names, customer code, or copied proprietary text. Write examples fresh.

## Sign in

```sh
wb login                    # opens the browser; one approval connects one organization
wb login --org acme         # connect or refresh a specific organization
wb whoami                   # default organization, user, scopes, key expiry
wb org list
wb org use acme             # change the default
```

`wb login` is a browser approval: hand the command to the person. Keys are saved per organization and expire; `wb login --org <org>` refreshes one.

## Store a version for your team

```sh
wb push .#my-expert --org acme
```

`push` stores a new immutable internal version as `acme/<name>` (use `--as <name>` to store it under a different registry name), even when the Workbench is already public. Internal versions are visible only to the organization's members and keys. If the version has a cloud image build, the output names it and links the page that streams its log. Teammates install it after their own `wb login --org acme`:

```sh
wb add acme/my-expert --as my-expert
```

`acme/my-expert` is the latest release. Push a prerelease such as `0.3.0-alpha.1` to let teammates try a change first with `wb add acme/my-expert@0.3.0-alpha.1 --as my-expert-next`; the latest release stays what everyone else gets.

## Publish publicly

```sh
wb publish acme/my-expert                  # submit the newest stored release for review
wb publish acme/my-expert --version 1.2.0  # the same, failing if a release newer than 1.2.0 exists
```

Publishing submits a version you already pushed; it never uploads a package. Only the newest release can be published, so test unfinished work as a prerelease such as `1.3.0-alpha.1` rather than as a release. Prereleases and withdrawn versions cannot be published, and a version whose image is still building or missing is refused until the image is ready. The CLI prints the review status: `approved` means public now; anything else means it is waiting for review, and the dashboard shows progress. Your organization runs a new release by name as soon as you push it; everyone else keeps a public Workbench's approved version until a newer one is approved.

Anyone can then install it without signing in:

```sh
wb add acme/my-expert --as my-expert
```

Saved packages are frozen snapshots. Consumers get new versions with `wb upgrade my-expert`.

To make a public Workbench internal again, immediately:

```sh
wb unpublish acme/my-expert
```

To withdraw an open review submission, run `wb withdraw acme/my-expert`. It selects only that Workbench's `pending` or `changes_requested` submission, and fails with a clear message when none is open. It does not unpublish an approved version. Like publish and unpublish, it uses the organization in `org/name`; `--org`, when given, must match.

## Delete a Workbench or version

`wb delete acme/my-expert` and `wb delete acme/my-expert@1.2.0` make no HTTP requests without `--yes` and print what would be permanently deleted and that it cannot be undone. After explicit confirmation from the person, `wb delete acme/my-expert --yes` deletes the Workbench, every version, and its registry images. `wb delete acme/my-expert@1.2.0 --yes` lists stored versions to find the exact id and deletes just that version. Its image is deleted unless a later version uses it; both preview and success say so. The registry refuses version deletion for unfinished runs, the current public version, or the only version. Whole-Workbench deletion is refused while any run of it is unfinished. The CLI prints 409 messages unchanged. The organization comes from the reference; `--org`, when given, must match it, including for previews.

## Publish a runtime image

`daytona` needs an image: push one as below, or declare `image: { build: Dockerfile, context: . }` and workbenches.dev builds it when the version is pushed, under the organization's daily build limit. A version can be published once its build is ready. `e2b` can build from the package's Dockerfile, but a published image avoids a template build on each new tag, and `docker` consumers benefit from one instead of building locally.

```sh
docker build -t my-expert-local .workbenches/my-expert
wb push .#my-expert --org acme
wb image push my-expert-local acme/my-expert@1.2.0
```

Declare `images.workbenches.dev/acme/my-expert:1.2.0` in the manifest before storing version `1.2.0`, then push its image. The command resolves that exact stored version with the organization's key before exporting or uploading and tells you to `wb push` first if it is missing. It prints the exact image reference the manifest names:

```yaml
runtimes:
  docker:
    image: images.workbenches.dev/acme/my-expert:1.2.0
  daytona:
    class: linux
    image: images.workbenches.dev/acme/my-expert:1.2.0
```

- `wb image push` exports the local image, uploads only missing layers in chunks, and publishes the manifest. Prefer it over a direct `docker push`, which is subject to a per-request size limit.
- Each Workbench owns `images.workbenches.dev/org/name`. The version tag replaces every character outside `[A-Za-z0-9._-]` with `_`, so `1.0.0+build.7` becomes `1.0.0_build.7`. A stored version accepts an image once. A version may reference only its own Workbench's registry repository, with its own tag or an earlier version's tag. Registry refusals are printed unchanged.
- The organization comes from `org/name@version`; `--org`, when given, must match. The removed image flags fail before any request with `wb image push <local image> <org/name@version>`.
- Build for the architecture consumers run: sandbox providers run `linux/amd64`. Build with `--platform linux/amd64` on Apple silicon.
- `wb image login --org acme` logs a Docker-compatible client into the registry when a tool needs plain registry credentials.

## Sharing from a repository

Any public GitHub repository with packages under `.workbenches/<name>/` is already installable without the registry:

```sh
wb list owner/repo
wb add https://github.com/owner/repo --name <name> --ref main --as <alias>
```

Use the registry when you want versions, internal sharing, review, and a stable `org/name`.

## Errors

| Error | Fix |
| --- | --- |
| `Sign in first with wb login` | The person runs `wb login`. |
| `Not signed in to organization X. Held: a, b. Run wb login --org X` | The person connects that organization. |
| `Your Workbench CLI login for X has expired. Run wb login --org X again.` | Refresh the login. |
| `--publisher was replaced by --org. Use --org <slug>` | Use `--org`. |
| `Workbench package exceeds 256 files` / `exceeds 10485760 bytes` / `file is too large` | Remove build output, assets, and anything not needed at run time from the package directory. |
| `wb publish takes a registry org/name. Push the package with wb push first, then publish it.` | Run `wb push .#<name> --org <org>`, then `wb publish <org>/<name>`. |
| `Version X is not stored` / `No stored release is available to publish` | Push a release first, then publish its registry name. |
| `Version X is a prerelease` / `is withdrawn` | Push and publish a release version. |
| `Image build ... is still building` / image missing | Wait for the build, or push the image, then publish again. |
| A version conflict from the registry | Bump `version` in `workbench.yml`, push, then publish again. |
