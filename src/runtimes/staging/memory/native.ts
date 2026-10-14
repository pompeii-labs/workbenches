import { formatOutcomeBytes } from '../../../outcomes/presentation.js';
import { WorkspaceProtection } from '../protection.js';
import type { TransferRules } from '../rules.js';
import { quote } from '../shell.js';
import { TarArchive, type TarEntry } from '../tar.js';
import type {
    NativeStateOptions,
    NativeStateSink,
    TransferSandbox,
} from '../transfer.js';
import { MemoryArchive } from './archive.js';
import { readBoundedBytes } from './bounded.js';

/** The mode native state files are handed over with, as the disk store keeps them. */
const privateFileMode = 0o600;

/**
 * Copies runner-owned native state out of a sandbox into a `NativeStateSink`,
 * in memory. Only `state` assets are copied: credential storage is never
 * staged by the in-memory transfer, and Git metadata belongs to the workspace.
 * The sandbox's synthetic Git baseline and engine metadata are left behind,
 * and every path the staging rules protect, such as credential, key, and
 * environment files, is dropped, so the archive holds only what staging would
 * send back into a sandbox. Links are refused, as the disk store refuses them.
 */
export class MemoryNativeStateCapture {
    private readonly protection = new WorkspaceProtection();

    constructor(
        private readonly sandbox: Pick<TransferSandbox, 'run' | 'download'>,
        private readonly rules: TransferRules,
        private readonly sink: NativeStateSink
    ) {}

    async capture(options: Omit<NativeStateOptions, 'sandbox'>): Promise<void> {
        let transferred = 0;
        for (const [index, snapshot] of options.snapshots.entries()) {
            if (snapshot.binding.kind !== 'state' || !snapshot.sourceIsDirectory) {
                continue;
            }
            if (options.completed.has(index)) continue;
            const remoteArchive = `/tmp/workbench-native-state-${index}.tar.gz`;
            try {
                const result = await this.sandbox.run(
                    `tar -C ${quote(snapshot.binding.runtimePath)} --exclude=./.git --exclude=./.workbench-state -czf ${quote(remoteArchive)} .`
                );
                if (result.code !== 0) {
                    throw new Error(
                        `Failed to collect ${this.rules.provider} native state: ${result.stderr.trim() || result.stdout.trim()}`
                    );
                }
                const archive = await this.download(
                    remoteArchive,
                    options.maximumBytes - transferred,
                    options.maximumBytes
                );
                transferred += archive.byteLength;
                await this.sink.putNativeState(
                    snapshot.binding.hostPath,
                    await this.retained(archive, options.maximumBytes)
                );
            } finally {
                await this.sandbox.run(`rm -f ${quote(remoteArchive)}`).catch(() => {});
            }
            options.completed.add(index);
            await options.checkpoint?.(options.completed);
        }
    }

    /** The files of `archive` that may be staged again, packed as a gzip tar. */
    private async retained(
        archive: Uint8Array,
        maximumBytes: number
    ): Promise<Uint8Array> {
        const { changed } = await new MemoryArchive(this.rules).unpack(
            archive,
            maximumBytes,
            maximumBytes
        );
        const entries: TarEntry[] = [];
        for (const [path, entry] of [...changed].toSorted(([left], [right]) =>
            left.localeCompare(right)
        )) {
            if (entry.type !== 'file') {
                throw new Error(
                    `${this.rules.provider} native state contains a symbolic link: ${path}`
                );
            }
            if (this.protection.protectedWorkspacePath(path)) continue;
            entries.push({
                name: path,
                type: 'file',
                mode: privateFileMode,
                content: entry.content,
            });
        }
        return TarArchive.pack(entries).gzip();
    }

    private async download(
        remote: string,
        maximumBytes: number,
        reportedMaximumBytes: number
    ): Promise<Uint8Array> {
        return readBoundedBytes(
            await this.sandbox.download(remote),
            maximumBytes,
            `${this.rules.provider} native state exceeds the ${formatOutcomeBytes(reportedMaximumBytes)} transfer safety limit`
        );
    }
}
