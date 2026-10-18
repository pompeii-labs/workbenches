# Database migrations

Each file is one schema change, named `NNNN_title.sql` with a four digit number and a lowercase snake case title, for example `0002_add_labels.sql`.

To add a migration, create the file with the next number and add it to the list in `src/database/migrations/index.ts`. A test fails when a file is missing from the list, when numbers have gaps or repeats, or when a name breaks the pattern.

Never edit a shipped file. Each database records the sha256 of every migration it applied and Workbench refuses to open one whose file has changed. Fix a mistake with a new migration.

Each migration runs in its own transaction together with its record in `__migrations`, so it applies completely or not at all. A database that holds a version this build does not know is refused with a message to upgrade Workbench.
