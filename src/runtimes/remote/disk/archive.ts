import {
    createReadStream as readStream,
    createWriteStream as writeStream,
} from 'node:fs';
import { chmod, lstat, mkdir, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import tar from 'tar-stream';
import { formatOutcomeBytes } from '../../../outcomes/presentation.js';
import type { TransferRules } from '../../staging/rules.js';

export interface ExtractLimits {
    /** Extraction stops once the archive holds more file bytes than this. */
    maximumBytes: number;
    /** The limit named in the message, when it differs from the one enforced. */
    reportedMaximumBytes: number;
}

/** Extracts gzip tar archives from a sandbox, refusing unsafe paths, links, and sizes. */
export class SandboxArchive {
    constructor(readonly rules: TransferRules) {}

    /** Extracts `archive` into `destination` and returns the file bytes written. */
    async extract(
        archive: string,
        destination: string,
        limits: ExtractLimits
    ): Promise<number> {
        const { rules } = this;
        const extract = tar.extract();
        let bytes = 0;
        extract.on('entry', (header, stream, next) => {
            void (async () => {
                const normalized = rules.normalizeArchivePath(header.name);
                const name =
                    header.type === 'directory'
                        ? normalized.replace(/\/$/, '')
                        : normalized;
                if (header.type === 'directory' && (name === '.' || name === '')) {
                    stream.resume();
                    return;
                }
                rules.validateRelativePath(name);
                bytes += header.type === 'file' ? (header.size ?? 0) : 0;
                if (bytes > limits.maximumBytes) {
                    stream.resume();
                    throw new Error(
                        `${rules.provider} output exceeds the ${formatOutcomeBytes(limits.reportedMaximumBytes)} transfer safety limit`
                    );
                }
                const path = join(destination, name);
                await this.validateParents(destination, name);
                await mkdir(dirname(path), { recursive: true });
                if (header.type === 'directory') {
                    await mkdir(path, { recursive: true });
                    stream.resume();
                } else if (header.type === 'symlink') {
                    const link = header.linkname;
                    if (!link)
                        throw new Error(
                            `${rules.provider} archive symlink is missing: ${name}`
                        );
                    rules.validateSymlink({
                        parent: dirname(path),
                        link,
                        displayPath: path,
                        root: destination,
                    });
                    await rm(path, { recursive: true, force: true });
                    await symlink(link, path);
                    stream.resume();
                } else if (header.type === 'file') {
                    await rm(path, { recursive: true, force: true });
                    await pipeline(stream, writeStream(path, { mode: header.mode }));
                    await chmod(path, header.mode ?? 0o644);
                } else {
                    stream.resume();
                    throw new Error(
                        `Unsupported ${rules.provider} archive entry: ${name}`
                    );
                }
            })().then(
                () => next(),
                (error) => extract.destroy(error as Error)
            );
        });
        await pipeline(readStream(archive), createGunzip(), extract);
        return bytes;
    }

    private async validateParents(root: string, name: string): Promise<void> {
        let current = root;
        for (const segment of name.split('/').slice(0, -1)) {
            current = join(current, segment);
            const details = await lstat(current).catch(() => undefined);
            if (details && (!details.isDirectory() || details.isSymbolicLink())) {
                throw new Error(
                    `Unsafe ${this.rules.provider} archive parent: ${name}`
                );
            }
        }
    }
}
