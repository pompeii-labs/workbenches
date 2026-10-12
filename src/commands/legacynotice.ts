import { NoticeStore } from '../database/noticestore.js';
import { WorkbenchDatabase } from '../database/workbenchdatabase.js';
import { LegacyLayout } from '../files/legacylayout.js';

/**
 * Tells the user, once, that sessions an earlier version recorded as files are
 * not shown. Only commands a person reads call it, so a status line or a
 * detached worker never uses up the one announcement.
 */
export class LegacyNotice {
    constructor(private readonly home: string) {}

    show(): void {
        const legacy = new LegacyLayout(this.home);
        if (!legacy.exists()) return;
        const notices = new NoticeStore(WorkbenchDatabase.forHome(this.home));
        if (notices.claim('legacy-layout', new Date().toISOString()))
            process.stderr.write(`${legacy.notice()}\n`);
    }
}
