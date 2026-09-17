import {
    createReadStream as readStream,
    createWriteStream as writeStream,
} from 'node:fs';
import { chmod, lstat, mkdir, rm, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import tar from 'tar-stream';
import { formatBytes } from './infrastructure.js';

export async function extractArchive(
    archive: string,
    destination: string,
    maximumBytes = Number.POSITIVE_INFINITY,
    reportedMaximumBytes = maximumBytes
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
            validateRelativePath(name);
            bytes += header.type === 'file' ? (header.size ?? 0) : 0;
            if (bytes > maximumBytes) {
                stream.resume();
                throw new Error(
                    `E2B output exceeds the ${formatBytes(reportedMaximumBytes)} transfer safety limit`
                );
            }
            const path = join(destination, name);
            await validateParents(destination, name);
            await mkdir(dirname(path), { recursive: true });
            if (header.type === 'directory') {
                await mkdir(path, { recursive: true });
                stream.resume();
            } else if (header.type === 'symlink') {
                const link = header.linkname;
                if (!link) throw new Error(`E2B archive symlink is missing: ${name}`);
                validateSymlink(dirname(path), link, path, destination);
                await rm(path, { recursive: true, force: true });
                await symlink(link, path);
                stream.resume();
            } else if (header.type === 'file') {
                await rm(path, { recursive: true, force: true });
                await pipeline(stream, writeStream(path, { mode: header.mode }));
                await chmod(path, header.mode ?? 0o644);
            } else {
                stream.resume();
                throw new Error(`Unsupported E2B archive entry: ${name}`);
            }
        })().then(
            () => next(),
            (error) => extract.destroy(error as Error)
        );
    });
    await pipeline(readStream(archive), createGunzip(), extract);
    return bytes;
}

async function validateParents(root: string, name: string): Promise<void> {
    let current = root;
    for (const segment of name.split('/').slice(0, -1)) {
        current = join(current, segment);
        const details = await lstat(current).catch(() => undefined);
        if (details && (!details.isDirectory() || details.isSymbolicLink())) {
            throw new Error(`Unsafe E2B archive parent: ${name}`);
        }
    }
}

function validateRelativePath(path: string): void {
    if (
        !path ||
        path === '.' ||
        isAbsolute(path) ||
        path.split('/').some((segment) => segment === '..' || segment === '')
    ) {
        throw new Error(`Unsafe E2B archive path: ${path}`);
    }
}

function validateSymlink(
    parent: string,
    link: string,
    displayPath: string,
    root?: string
): void {
    if (isAbsolute(link)) {
        throw new Error(
            `Absolute symlink is not allowed in E2B transfer: ${displayPath}`
        );
    }
    if (root && !contains(root, resolve(parent, link))) {
        throw new Error(
            `Escaping symlink is not allowed in E2B transfer: ${displayPath}`
        );
    }
}

function contains(parent: string, child: string): boolean {
    const suffix = relative(resolve(parent), resolve(child));
    return (
        suffix === '' ||
        (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
    );
}

function normalizeArchivePath(path: string): string {
    return path.split(sep).join('/').replace(/^\.\//, '');
}
