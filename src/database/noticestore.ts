import type { WorkbenchDatabase } from './workbenchdatabase.js';

/** Messages shown to the user once per database. */
export class NoticeStore {
    constructor(private readonly database: WorkbenchDatabase) {}

    /** Records the notice and reports whether this call was the first to. */
    claim(name: string, shownAt: string): boolean {
        return (
            this.database.run(
                'INSERT OR IGNORE INTO notices (name, shown_at) VALUES (?, ?)',
                name,
                shownAt
            ).changes === 1
        );
    }
}
