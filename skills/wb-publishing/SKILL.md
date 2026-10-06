---
name: wb-publishing
description: Publish Workbenches and their runtime images to the workbenches.dev registry and share them. Use when signing the wb CLI in to an organization, storing a Workbench version for a team (internal), submitting one for public review, unpublishing, pushing an OCI image for docker, e2b, or daytona runtimes, or helping someone install a published Workbench.
license: Apache-2.0
compatibility: Requires the Workbench (`wb`) CLI (see the wb-cli skill) and a workbenches.dev organization.
---

# Publishing Workbenches

The registry at workbenches.dev stores Workbench versions per organization. A version is **internal** (visible to members of its organization) until it is published; **public** versions are reviewed first. Every version is immutable.

Publishing is outward facing and hard to take back. Get the person's explicit go-ahead before `push`, `publish`, `unpublish`, or `image push`, and confirm the organization and version you are about to use.

## Before publishing

1. The package passes `wb validate` and `wb smoke` on every declared runtime, and has been trialed on real tasks (see the wb-authoring skill).
2. The manifest `version` is higher than the last stored version. Bump it for any content change.
3. The package directory holds only what should ship. `wb push` and `wb publish` upload the whole directory with no ignore rules: make sure no `.env`, credential file, private notes, or build output sits inside it. Limits: 256 files, 10 MiB total, 2 MiB per file, no symlinks.
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

`push` stores a new immutable version as `acme/<name>` (use `--as <name>` to store it under a different registry name). Internal versions are visible only to the organization's members. Teammates install it after their own `wb login --org acme`:

```sh
wb add acme/my-expert --as my-expert
```

## Publish publicly

```sh
wb publish acme/my-expert              # submit the latest stored version for review
wb publish .#my-expert --org acme      # submit a local package directly for review
```

With `org/name`, only the latest stored version can be submitted. A local source is submitted directly, without storing an internal version first. That is how a public Workbench takes a new version: the registry refuses `wb push` to a public Workbench. The CLI prints the review status: `approved` means public now; anything else means it is waiting for review, and the dashboard shows progress.

Anyone can then install it without signing in:

```sh
wb add acme/my-expert --as my-expert
```

Saved packages are frozen snapshots. Consumers get new versions with `wb upgrade my-expert`.

To make a public Workbench internal again, immediately:

```sh
wb unpublish acme/my-expert
```

## Publish a runtime image

`daytona` needs a published image. `e2b` can build from the package's Dockerfile, but a published image avoids a template build on each new tag, and `docker` consumers benefit from one instead of building locally.

```sh
docker build -t my-expert-local .workbenches/my-expert
wb image push my-expert-local --org acme --as my-expert --tag 1.2.0
```

That publishes `images.workbenches.dev/acme/my-expert:1.2.0`; reference it from the manifest:

```yaml
runtimes:
  docker:
    image: images.workbenches.dev/acme/my-expert:1.2.0
  daytona:
    class: linux
    image: images.workbenches.dev/acme/my-expert:1.2.0
```

- `wb image push` exports the local image, uploads only missing layers in chunks, and publishes the manifest. Prefer it over a direct `docker push`, which is subject to a per-request size limit.
- Use a versioned tag, never `latest`. Never overwrite a tag a released Workbench version references. Bump both the image tag and the Workbench version together.
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
| `Only the latest version can be published for now` | Publish the local package directly instead: `wb publish .#<name> --org <org>`. |
| A version conflict from the registry | Bump `version` in `workbench.yml` and push or publish again. |
| The registry refuses a push to a public Workbench | Public Workbenches take new versions only through `wb publish`. |
