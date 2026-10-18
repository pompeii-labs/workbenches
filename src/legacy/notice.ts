import type { NoticeStore } from '../database/notices.js';
import type { LegacyLayout } from './layout.js';

/**
 * Tells the user, once, that sessions an earlier version recorded as files are
 * not shown. Only commands a person reads call it, so a status line or a
 * detached worker never uses up the one announcement.
 */
export class LegacyNotice {
    constructor(
        private readonly layout: Pick<LegacyLayout, 'exists' | 'notice'>,
        private readonly notices: Pick<NoticeStore, 'claim'>
    ) {}

    show(): void {
        if (!this.layout.exists()) return;
        if (this.notices.claim('legacy-layout', new Date().toISOString()))
            process.stderr.write(`${this.layout.notice()}\n`);
    }
}
