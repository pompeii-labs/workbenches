import {
    createReadStream as readStream,
    createWriteStream as writeStream,
} from 'node:fs';
import { chmod, lstat, mkdir, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import tar from 'tar-stream';
import {
    formatBytes,
    normalizeArchivePath,
    validateRelativePath,
    validateSymlink,
} from '../staging/rules.js';

/** Extracts a gzip tar into `destination`, refusing unsafe paths, links, and sizes. */
export async function extractArchive(
    archive: string,
    destination: string,
    maximumBytes = Number.POSITIVE_INFINITY,
    reportedMaximumBytes = maximumBytes,
    label = 'E2B'
): Promise<number> {
    const extract = tar.extract();
    let bytes = 0;
    extract.on('entry', (header, stream, next) => {
        void (async () => {
            const normalized = normalizeArchivePath(header.name);
            const name =
                header.type === 'directory'
                    ? normalized.replace(/\/$/, '')
                    : normalized;
            if (header.type === 'directory' && (name === '.' || name === '')) {
                stream.resume();
                return;
            }
            validateRelativePath(name, label);
            bytes += header.type === 'file' ? (header.size ?? 0) : 0;
            if (bytes > maximumBytes) {
                stream.resume();
                throw new Error(
                    `${label} output exceeds the ${formatBytes(reportedMaximumBytes)} transfer safety limit`
                );
            }
            const path = join(destination, name);
            await validateParents(destination, name, label);
            await mkdir(dirname(path), { recursive: true });
            if (header.type === 'directory') {
                await mkdir(path, { recursive: true });
                stream.resume();
            } else if (header.type === 'symlink') {
                const link = header.linkname;
                if (!link)
                    throw new Error(`${label} archive symlink is missing: ${name}`);
                validateSymlink(dirname(path), link, path, destination, label);
                await rm(path, { recursive: true, force: true });
                await symlink(link, path);
                stream.resume();
            } else if (header.type === 'file') {
                await rm(path, { recursive: true, force: true });
                await pipeline(stream, writeStream(path, { mode: header.mode }));
                await chmod(path, header.mode ?? 0o644);
            } else {
                stream.resume();
                throw new Error(`Unsupported ${label} archive entry: ${name}`);
            }
        })().then(
            () => next(),
            (error) => extract.destroy(error as Error)
        );
    });
    await pipeline(readStream(archive), createGunzip(), extract);
    return bytes;
}

async function validateParents(
    root: string,
    name: string,
    label: string
): Promise<void> {
    let current = root;
    for (const segment of name.split('/').slice(0, -1)) {
        current = join(current, segment);
        const details = await lstat(current).catch(() => undefined);
        if (details && (!details.isDirectory() || details.isSymbolicLink())) {
            throw new Error(`Unsafe ${label} archive parent: ${name}`);
        }
    }
}
