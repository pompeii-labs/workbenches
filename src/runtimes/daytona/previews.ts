import { posix } from 'node:path';

import { AnnouncementLog } from '../../previews/log.js';
import { PreviewPolicy } from '../../previews/policy.js';
import { PreviewScript } from '../../previews/script.js';
import type { RuntimePreviewFeed, RuntimePreviewListener } from '../contracts.js';
import { RuntimeError } from '../error.js';
import { StagingDirectories } from '../remote/directories.js';
import type { TransferRules } from '../staging/rules.js';
import { quote } from '../staging/shell.js';
import type { DaytonaSandbox, DaytonaSignedPreviewUrl } from './contracts.js';
import type { FollowedCommand } from './follow.js';
import { portListening } from './service.js';

/** Where the helper lives in the sandbox, outside every staged path and the outbox. */
const helperDirectory = '/opt/workbench/bin';
const previewDirectory = '/opt/workbench/previews';
const controlFile = `${previewDirectory}/announcements.jsonl`;

/** Daytona signs a preview URL for at most a day. */
const maximumSignedSeconds = 86_400;

type PreviewSandbox = Pick<
    DaytonaSandbox,
    | 'run'
    | 'upload'
    | 'download'
    | 'follow'
    | 'signedPreviewUrl'
    | 'expireSignedPreviewUrl'
>;

/**
 * Owns how one run in a Daytona sandbox announces previews: the `wbx` helper
 * staged into the sandbox, the control file it appends to, a control session
 * that runs `tail -F` on that file and is followed over the toolbox's log
 * WebSocket, and the validation every announcement goes through. The follower
 * is the prompt path; `refresh` at each turn end reads the file again as the
 * fallback. Both sources report offsets into the same file, so an
 * announcement is never published twice.
 */
export class SandboxPreviews implements RuntimePreviewFeed {
    static readonly helperDirectory = helperDirectory;
    static readonly controlFile = controlFile;
    readonly #log: AnnouncementLog;
    #listener: RuntimePreviewListener | undefined;
    #follower: Promise<FollowedCommand | undefined> | undefined;
    #publishing: Promise<void> = Promise.resolve();
    #closed = false;

    constructor(
        private readonly sandbox: PreviewSandbox,
        private readonly rules: TransferRules,
        reserved: () => Iterable<number>
    ) {
        this.#log = new AnnouncementLog(
            new PreviewPolicy(reserved),
            {
                listening: async (port) =>
                    (await sandbox.run(portListening(port))).code === 0,
            },
            (message) => this.#listener?.warn(message)
        );
    }

    /** Stages the helper and an empty control file, replacing any an earlier run left. */
    async install(): Promise<void> {
        await new StagingDirectories(this.sandbox, this.rules).prepare([
            helperDirectory,
            previewDirectory,
        ]);
        const helper = posix.join(helperDirectory, PreviewScript.command);
        await this.sandbox.upload(
            helper,
            new TextEncoder().encode(new PreviewScript(controlFile).text())
        );
        const result = await this.sandbox.run(
            [
                `chmod 700 ${quote(helper)}`,
                `rm -f ${quote(controlFile)}`,
                `: > ${quote(controlFile)}`,
                `chmod 600 ${quote(controlFile)}`,
            ].join(' && ')
        );
        if (result.code !== 0) {
            throw new Error(
                `Failed to install the preview helper in the ${this.rules.provider} sandbox`
            );
        }
    }

    /**
     * `command` with the helper directory first on PATH. The toolbox quotes
     * environment values, so PATH is set on the command line, where the
     * sandbox's own PATH expands.
     */
    command(command: string): string {
        return `PATH=${quote(helperDirectory)}:"$PATH" ${command}`;
    }

    /** True when `port` belongs to a preview this run shows. */
    shows(port: number): boolean {
        return this.#log.shows(port);
    }

    /** True when the run has accepted at least one preview. */
    get announced(): boolean {
        return !this.#log.empty;
    }

    /**
     * Mints a new signed URL for the port of an announced preview. Nothing is
     * cached: every call asks Daytona again, and the URL and its token go to
     * the caller only.
     */
    async signedUrl(
        port: number,
        ttlSeconds: number
    ): Promise<DaytonaSignedPreviewUrl> {
        this.assertShown(port);
        if (
            !Number.isSafeInteger(ttlSeconds) ||
            ttlSeconds < 1 ||
            ttlSeconds > maximumSignedSeconds
        ) {
            throw new RuntimeError(
                'daytona',
                'launch',
                `A signed preview URL must expire after a whole number of seconds from 1 to ${maximumSignedSeconds}`
            );
        }
        if (!this.sandbox.signedPreviewUrl) {
            throw new RuntimeError(
                'daytona',
                'launch',
                'This Daytona sandbox cannot sign preview URLs'
            );
        }
        return this.sandbox.signedPreviewUrl(port, ttlSeconds);
    }

    /** Expires a signed URL for the port of an announced preview. */
    async expire(port: number, token: string): Promise<void> {
        this.assertShown(port);
        if (!token.trim()) {
            throw new RuntimeError('daytona', 'launch', 'A preview token is required');
        }
        if (!this.sandbox.expireSignedPreviewUrl) {
            throw new RuntimeError(
                'daytona',
                'launch',
                'This Daytona sandbox cannot expire signed preview URLs'
            );
        }
        await this.sandbox.expireSignedPreviewUrl(port, token);
    }

    watch(listener: RuntimePreviewListener): void {
        if (this.#closed || this.#listener) return;
        this.#listener = listener;
        const failed = (error: unknown) =>
            listener.warn(
                `Stopped following preview announcements: ${error instanceof Error ? error.message : String(error)}`
            );
        this.#follower = this.sandbox
            .follow?.(
                `exec tail -n +1 -F ${quote(controlFile)}`,
                (bytes, start) => this.offer(bytes, start),
                failed
            )
            .catch((error: unknown) => {
                failed(error);
                return undefined;
            });
    }

    refresh(): Promise<void> {
        if (this.#closed || !this.#listener) return this.#publishing;
        this.#publishing = this.#publishing.then(() => this.read());
        return this.#publishing;
    }

    async close(): Promise<void> {
        if (this.#closed) return this.#publishing;
        await this.stop();
        const final = this.refresh();
        this.#closed = true;
        return final;
    }

    /** Stops following and ends the control session without publishing anything more. */
    async stop(): Promise<void> {
        const follower = this.#follower;
        this.#follower = undefined;
        await (await follower)?.stop();
    }

    /** Refuses a port that is not one of this run's previews. */
    private assertShown(port: number): void {
        if (!this.#log.shows(port)) {
            throw new RuntimeError(
                'daytona',
                'launch',
                `Port ${port} is not a preview this run announced`
            );
        }
    }

    private offer(bytes: Uint8Array, start: number): void {
        if (this.#closed) return;
        this.#publishing = this.#publishing.then(() => this.publish(bytes, start));
    }

    /** Reads the whole control file a chunk at a time, so its size never matters. */
    private async read(): Promise<void> {
        try {
            const reader = (await this.sandbox.download(controlFile)).getReader();
            let position = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                await this.publish(value, position);
                position += value.byteLength;
            }
        } catch (error) {
            this.#listener?.warn(
                `Could not read preview announcements: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    private async publish(bytes: Uint8Array, start: number): Promise<void> {
        try {
            for (const preview of await this.#log.offer(bytes, start)) {
                await this.#listener?.available(preview);
            }
        } catch (error) {
            this.#listener?.warn(
                `Could not publish a preview: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}
