import { chmod, mkdir, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { OutcomeDigest } from './contracts.js';

/** Immutable Git index blobs can provide an exact local baseline without cloning the checkout. */
export class GitBaseline {
    private constructor(
        readonly objectFormat: 'sha1' | 'sha256',
        private readonly index: Map<string, string>,
        private readonly root: string
    ) {}

    static async open(root: string): Promise<GitBaseline> {
        const format = (await git(root, ['rev-parse', '--show-object-format'])).trim();
        if (format !== 'sha1' && format !== 'sha256') {
            throw new Error('Unsupported Git object format for local outcome capture');
        }
        const index = new Map<string, string>();
        const output = await git(root, ['ls-files', '--stage', '-z', '--', '.']);
        for (const record of output.split('\0').filter(Boolean)) {
            const match = /^(?:[0-7]{6}) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(record);
            if (!match) throw new Error('Invalid Git index entry for outcome capture');
            const [, oid, stage, path] = match;
            if (stage === '0' && oid && path) index.set(path, oid);
        }
        return new GitBaseline(format, index, root);
    }

    matchingBlob(path: string, actualOid: string | undefined): string | undefined {
        const indexed = this.index.get(path);
        return indexed && indexed === actualOid ? indexed : undefined;
    }

    async materialize(
        oid: string,
        destination: string,
        mode: number,
        size: number,
        expected: OutcomeDigest,
        digest: (path: string) => Promise<OutcomeDigest>
    ): Promise<void> {
        if (
            !new RegExp(`^[a-f0-9]{${this.objectFormat === 'sha1' ? 40 : 64}}$`).test(
                oid
            )
        ) {
            throw new Error('Invalid Git baseline object identity');
        }
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        const child = Bun.spawn(['git', 'cat-file', 'blob', oid], {
            cwd: this.root,
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
        });
        try {
            const [written, code, error] = await Promise.all([
                writeBlob(destination, child.stdout).catch((failure) => {
                    child.kill();
                    throw failure;
                }),
                child.exited,
                new Response(child.stderr).text(),
            ]);
            if (code !== 0)
                throw new Error(`Git baseline blob is unavailable: ${error.trim()}`);
            if (written !== size)
                throw new Error('Git baseline size changed during capture');
            await chmod(destination, mode);
            if ((await digest(destination)) !== expected) {
                throw new Error('Git baseline content changed during capture');
            }
        } catch (error) {
            await rm(destination, { force: true });
            throw error;
        }
    }
}

async function writeBlob(
    destination: string,
    source: ReadableStream<Uint8Array>
): Promise<number> {
    const file = await open(destination, 'wx', 0o600);
    const reader = source.getReader();
    let written = 0;
    try {
        while (true) {
            const result = await reader.read();
            if (result.done) break;
            const chunk = result.value;
            let offset = 0;
            while (offset < chunk.byteLength) {
                const next = await file.write(chunk, offset, chunk.byteLength - offset);
                if (next.bytesWritten <= 0)
                    throw new Error('Git baseline materialization stalled');
                offset += next.bytesWritten;
                written += next.bytesWritten;
            }
        }
        return written;
    } finally {
        reader.releaseLock();
        await file.close();
    }
}

async function git(root: string, args: string[]): Promise<string> {
    const child = Bun.spawn(['git', ...args], {
        cwd: root,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [output, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    if (code !== 0) throw new Error(`Git baseline is unavailable: ${error.trim()}`);
    return output;
}
