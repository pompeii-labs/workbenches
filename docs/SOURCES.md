# Source and workspace behavior

This document describes the reference engine, not the normative package format.

## Add and run

```sh
wb add publisher/name
wb add https://github.com/owner/repository --name core --ref main --as project-core
wb add ./.workbenches/core --as local-core
wb run project-core --dir /path/to/workspace --task "Review this project"
```

Bare `publisher/name` is a registry identity only. A registry miss never falls
back to GitHub. Git sources require full HTTPS GitHub repository URLs. `--name`
selects a package; `--ref` selects a branch, tag, or commit. Multi-package sources
offer an interactive picker or a non-interactive error listing the available
`--name` choices. Source fragments (`#name`) are not acquisition syntax.

Registry references can require a held organization key: an internal workbench
resolves only with the key of its owning organization (`wb login --org
<publisher>`), and looks missing without it. Keys are sent to the registry only,
never to GitHub.

Aliases default to manifest names. `--as` selects another alias. Identical adds
are idempotent, collisions never overwrite, and changed remote packages at an
existing alias require `wb upgrade <alias>`.

Remote adds fetch only the selected package and store an immutable snapshot.
Local adds register the absolute package directory without copying the workspace.
Each new session reads current local instructions, skills, manifest, and package
files. Existing v1 frozen local entries stay frozen until explicitly re-added.
Deleted or invalid local sources fail clearly on the next new run.

`wb run` accepts saved aliases only. The engine-managed official creator is
launched through `wb create`. `--dir` and `--repo` select work targets, not package
sources. The default target is the current directory.

## Session ownership

At session creation the engine captures package bytes in session-owned storage.
It does not snapshot, copy, or hash the workspace for this purpose. Resumes use
that package even after source edits, upgrade, alias removal, or source deletion.
Legacy sessions keep their exact available original package; the engine does not
substitute a newer alias when their original package is missing or changed.

`wb upgrade` updates saved remotes only. Local registrations need no upgrade.
`wb update` checks or replaces the CLI itself. Removing an alias never removes
the original live source or a package still owned by a resumable session.

## Authoring and publishing

Successful `wb create` verification auto-registers the live local package. An
improvement at the same directory preserves its alias. Alias collisions do not
turn a verified creation into failure: the result includes the package path and
an explicit `wb add ... --as ...` instruction.

`wb push [source]` stores a new version as `organization/<workbench.yml name>`,
independent of the local alias and package directory. The source is a local
package reference or a saved alias. Pushed workbenches are internal: members and
organization keys see them, nobody else does. `wb publish <org/name | source>`
submits a stored version for public review and reports the submission status,
dashboard URL, and latest approved version when available. A pending submission
is not a public release. `wb unpublish <org/name>` makes a public workbench
internal again. All three use the default connected organization; `--org <slug>`
selects another one.

## Inspection and safety

Inspection commands retain local/source references for authoring and validation.
GitHub inspection uses metadata, trees, and blobs through the GitHub API, not a
clone. Public repositories need no credentials; private repositories may use
`GITHUB_TOKEN` or `GH_TOKEN`. GitHub 404s can mean missing or inaccessible.

Saved and session-owned packages must keep instructions and skills within the
package. Symlinks are rejected. Other Git hosts and signature verification are
not supported; remote ingestion is not a hardened supply-chain boundary.
