import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RunnerImageInput } from '../../runners/session.js';

const maximumImageBytes = 20 * 1024 * 1024;
const imageTypes = new Map([
    ['.gif', 'image/gif'],
    ['.jpeg', 'image/jpeg'],
    ['.jpg', 'image/jpeg'],
    ['.png', 'image/png'],
    ['.webp', 'image/webp'],
]);

export interface PromptImageAttachment extends RunnerImageInput {
    id: string;
    path: string;
    name: string;
}

export class PromptAttachmentReader {
    constructor(private readonly baseDirectory: string) {}

    async readPasted(value: string): Promise<PromptImageAttachment | undefined> {
        const candidate = pastedFilePath(value);
        if (!candidate) return;
        const path = candidate.startsWith('~/')
            ? resolve(homedir(), candidate.slice(2))
            : resolve(this.baseDirectory, candidate);
        const mimeType = imageTypes.get(extname(path).toLowerCase());
        if (!mimeType) return;
        const details = await stat(path).catch(() => undefined);
        if (!details?.isFile()) return;
        if (details.size > maximumImageBytes) {
            throw new Error('Image attachments must be 20 MB or smaller');
        }
        const bytes = await readFile(path);
        return {
            id: crypto.randomUUID(),
            path,
            name: basename(path),
            mimeType,
            data: bytes.toString('base64'),
        };
    }
}

function pastedFilePath(value: string): string | undefined {
    if (value.includes('\n') || value.includes('\r')) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const candidate = unquote(trimmed);
    if (candidate.startsWith('file://')) {
        try {
            return fileURLToPath(candidate);
        } catch {
            return;
        }
    }
    return process.platform === 'win32'
        ? candidate
        : candidate.replace(/\\(.)/gu, '$1');
}

function unquote(value: string): string {
    if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))
    ) {
        return value.slice(1, -1);
    }
    return value;
}
