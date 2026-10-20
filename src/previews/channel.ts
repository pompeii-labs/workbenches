import { type FSWatcher, watch } from 'node:fs';
import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

import { WorkbenchFiles } from '../files/layout.js';
import type { RunEvents } from '../runs/events.js';
import { PreviewAnnouncements } from './announcements.js';
import { PreviewHelper } from './helper.js';
import { type PreviewAnnouncement, PreviewPolicy } from './policy.js';
import { LoopbackPorts } from './probe.js';

/** The control file name inside a run's preview directory. */
const CONTROL_FILE = 'announcements.jsonl';

export interface PreviewChannelOptions {
    home: string;
    runId: string;
    events: Pick<RunEvents, 'emit'>;
    /** Ports the engine listens on itself, read each time an announcement is checked. */
    reserved: () => Iterable<number>;
    warn: (message: string) => void;
}

/**
 * Owns how one run on the host announces previews: the `wbx` helper on the
 * runner's PATH, the control file it appends to, a watcher that picks up each
 * announcement as it lands, and the `preview.available` events it produces.
 * The watcher is the prompt path; `refresh` at each turn end is the fallback.
 */
export class PreviewChannel {
    readonly #helperDirectory: string;
    readonly #previewDirectory: string;
    readonly #announcements: PreviewAnnouncements;
    #watcher: FSWatcher | undefined;
    #refreshing: Promise<void> = Promise.resolve();
    #closed = false;

    constructor(private readonly options: PreviewChannelOptions) {
        const files = new WorkbenchFiles(options.home);
        this.#helperDirectory = files.helperDirectory(options.runId);
        this.#previewDirectory = files.previewDirectory(options.runId);
        this.#announcements = new PreviewAnnouncements(
            join(this.#previewDirectory, CONTROL_FILE),
            new PreviewPolicy(options.reserved),
            new LoopbackPorts(),
            options.warn
        );
    }

    /** Writes the helper and an empty control file. */
    async install(): Promise<void> {
        await mkdir(this.#previewDirectory, { recursive: true, mode: 0o700 });
        const control = join(this.#previewDirectory, CONTROL_FILE);
        await writeFile(control, '', { mode: 0o600, flag: 'wx' });
        await new PreviewHelper(control).install(this.#helperDirectory);
    }

    /** `inherited` with the helper directory first on PATH, for the runner only. */
    environment(
        inherited: Record<string, string | undefined>
    ): Record<string, string | undefined> {
        return {
            ...inherited,
            PATH: [this.#helperDirectory, inherited.PATH]
                .filter(Boolean)
                .join(delimiter),
        };
    }

    /** Starts publishing announcements as soon as the control file changes. */
    watch(): void {
        if (this.#closed || this.#watcher) return;
        this.#watcher = watch(this.#previewDirectory, () => {
            void this.refresh();
        });
        this.#watcher.on('error', () => this.stopWatching());
        // Announcements written before the watcher existed are picked up too.
        void this.refresh();
    }

    /** Publishes every announcement appended since the last refresh. */
    refresh(): Promise<void> {
        if (this.#closed) return this.#refreshing;
        this.#refreshing = this.#refreshing.then(() => this.publish());
        return this.#refreshing;
    }

    /** Publishes what is left, then stops, so no preview follows the run's end. */
    async close(): Promise<void> {
        if (this.#closed) return this.#refreshing;
        this.stopWatching();
        const final = this.refresh();
        this.#closed = true;
        return final;
    }

    /** Closes the channel and removes the helper and control file. */
    async remove(): Promise<void> {
        await this.close();
        await rm(this.#helperDirectory, { recursive: true, force: true });
        await rm(this.#previewDirectory, { recursive: true, force: true });
        // The run's scratch directory goes once nothing else is in it.
        await rmdir(dirname(this.#previewDirectory)).catch(() => undefined);
    }

    private async publish(): Promise<void> {
        try {
            for (const preview of await this.#announcements.read()) {
                await this.options.events.emit(
                    'preview.available',
                    previewData(preview)
                );
            }
        } catch (error) {
            this.options.warn(
                `Could not read preview announcements: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    private stopWatching(): void {
        this.#watcher?.close();
        this.#watcher = undefined;
    }
}

/** The event data for a preview on the host, reachable at its loopback address. */
function previewData(preview: PreviewAnnouncement) {
    return {
        name: preview.name,
        port: preview.port,
        protocol: 'http' as const,
        url: `http://${LoopbackPorts.host}:${preview.port}/`,
    };
}
