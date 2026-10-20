# Database migrations

Each file is one schema change, named `NNNN_title.sql` with a four digit number and a lowercase snake case title, for example `0002_add_labels.sql`.

To add a migration, add the next numbered file to this folder. Nothing else changes: `index.ts` reads the folder at build time through a Bun macro, so `bun run`, `bun test`, and the compiled binary embed the same list. Running, testing, or building stops with an error naming the file when a name breaks the pattern or when numbers do not run from 1 without gaps or repeats. Other files here, such as this README, are ignored.

Never edit a shipped file. Each database records the sha256 of every migration it applied and Workbench refuses to open one whose file has changed. Fix a mistake with a new migration.

Each migration runs in its own transaction together with its record in `__migrations`, so it applies completely or not at all. A database that holds a version this build does not know is refused with a message to upgrade Workbench.
