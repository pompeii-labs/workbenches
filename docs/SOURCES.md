# Sources, saved packages, and target workspaces

The reference engine recognizes:

```text
/local/repository
/local/repository#migrations
https://github.com/lux-db/lux.git#migrations
lux-db/lux#migrations
lux-migrations
```

The final form is a saved alias. `#name` selects either the `.workbenches/`
directory name or manifest `name` when a source publishes more than one package.

For GitHub sources, `list`, `validate`, and `smoke` inspect repository metadata,
trees, and blobs through the GitHub API. Responses stay in memory. These commands
do not clone, create a temporary checkout, or write repository content locally.
Public repositories require no credentials. Private repositories can use
`GITHUB_TOKEN` or `GH_TOKEN`; a GitHub 404 is reported honestly as either missing
or inaccessible because GitHub deliberately does not distinguish those cases.

`wb add` is the explicit installation boundary. It fetches only the selected,
self-contained Workbench package, writes it into a content-addressed local
snapshot, and records its source, selector, package version, SHA-256 digest, and
source Git revision. The package digest is the reproducibility authority. Source
revisions are provenance metadata and may not include local uncommitted package
content.

Instructions and skills used by a saved Workbench must live inside its package.
The spec-0 parser still accepts repository-contained paths for backward
compatibility, but such a package cannot be saved by this engine. Symlinks are
rejected during save to prevent a snapshot from reaching outside its package.

A direct local repository reference runs against that repository by default. A
saved alias runs against the current directory by default, because the saved
package provides expertise while the current directory is the work target. `wb
run <ref> --dir <workspace>` makes the target explicit. Direct remote runs are
rejected with an instruction to save the package first; the engine never creates
a disposable remote work target.

Remote inspection currently follows the GitHub default branch. Other Git hosts,
exact ref selection, update policy, signature verification, and registry trust
are roadmap work; remote ingestion must not yet be described as a stable or
hardened supply-chain boundary.
