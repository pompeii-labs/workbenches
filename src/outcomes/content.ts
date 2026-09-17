import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, lstat } from 'node:fs/promises';
import { extname } from 'node:path';

import type {
    OutcomeContentDescriptor,
    OutcomeDigest,
    RunOutcome,
} from './contracts.js';

export function referencedContent(outcome: RunOutcome): OutcomeContentDescriptor[] {
    return [
        ...outcome.artifacts.map((artifact) => artifact.content),
        ...outcome.changesets.flatMap((changeset) => [
            ...(changeset.review ? [changeset.review] : []),
            ...changeset.entries.flatMap((entry) =>
                entry.after?.kind === 'file' ? [entry.after.content] : []
            ),
        ]),
    ];
}

export function inferMediaType(path: string): string {
    const extension = extname(path).toLowerCase();
    return (
        {
            '.css': 'text/css',
            '.csv': 'text/csv',
            '.gif': 'image/gif',
            '.htm': 'text/html',
            '.html': 'text/html',
            '.jpeg': 'image/jpeg',
            '.jpg': 'image/jpeg',
            '.js': 'text/javascript',
            '.json': 'application/json',
            '.md': 'text/markdown',
            '.pdf': 'application/pdf',
            '.png': 'image/png',
            '.svg': 'image/svg+xml',
            '.ts': 'text/typescript',
            '.txt': 'text/plain',
            '.webp': 'image/webp',
            '.xml': 'application/xml',
            '.yaml': 'application/yaml',
            '.yml': 'application/yaml',
        }[extension] ?? 'application/octet-stream'
    );
}

export async function digestFile(path: string): Promise<OutcomeDigest> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return `sha256:${hash.digest('hex')}`;
}

export async function verifyBlob(
    path: string,
    descriptor: OutcomeContentDescriptor
): Promise<void> {
    const details = await lstat(path).catch(() => undefined);
    if (!details || details.isSymbolicLink() || !details.isFile()) {
        throw new Error(`Outcome content is unavailable: ${descriptor.digest}`);
    }
    if (details.size !== descriptor.size_bytes) {
        throw new Error(`Outcome content size does not match: ${descriptor.digest}`);
    }
    if ((await digestFile(path)) !== descriptor.digest) {
        throw new Error(`Outcome content digest does not match: ${descriptor.digest}`);
    }
}

export async function validExistingBlob(
    path: string,
    descriptor: OutcomeContentDescriptor
): Promise<boolean> {
    try {
        await verifyBlob(path, descriptor);
        return true;
    } catch (error) {
        if (!(await lstat(path).catch(() => undefined))) return false;
        throw error;
    }
}

export async function installExclusive(
    source: string,
    destination: string
): Promise<void> {
    try {
        await link(source, destination);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
            return;
        throw error;
    }
}
