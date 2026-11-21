import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { OutcomeWarning } from '../outcomes/contracts.js';
import type { WorkerOutcomeData, WorkerOutcomeFile } from './outcome.js';
import { isRecord } from './protocol.js';
import { WorkerOutcomeRedaction } from './redaction.js';

export type WorkerOutcomeRequest = (
    path: string,
    options: {
        method: string;
        token: string;
        body?: unknown;
        raw?: Uint8Array;
        contentType?: string;
    }
) => Promise<unknown>;

/** Uploads private redacted copies sequentially, removing each copy after its attempt. */
export class WorkerOutcomeUpload {
    constructor(
        private readonly request: WorkerOutcomeRequest,
        /** Waits between retries of a failed part or step. */
        private readonly wait: (milliseconds: number) => Promise<void>
    ) {}

    async uploadOutcome(
        run: string,
        token: string,
        outcome: WorkerOutcomeData,
        credentials: string[],
        report: (message: string) => void
    ): Promise<void> {
        const base = `/v1/runs/${encodeURIComponent(run)}/outcome`;
        const redaction = new WorkerOutcomeRedaction(credentials);
        const emit = (message: string) => report(redaction.text(message));
        const warnings = [...outcome.manifest.warnings];
        for (const [ordinal, file] of outcome.files.entries()) {
            try {
                await this.file(
                    base,
                    token,
                    { ...file, path: redaction.text(file.path) },
                    ordinal,
                    redaction,
                    warnings,
                    emit,
                    outcome.directory
                );
            } catch (error) {
                const message = redaction.text(
                    error instanceof Error ? error.message : String(error)
                );
                emit(message);
                warnings.push({
                    code: 'outcome_upload_failed',
                    message: `Could not upload ${file.path}: ${message}`,
                });
            }
        }
        const manifest = redaction.value({ ...outcome.manifest, warnings });
        try {
            const complete = await this.retry(`${base}/complete`, {
                method: 'POST',
                token,
                body: manifest,
            });
            if (!isRecord(complete))
                throw new Error('Malformed outcome completion response');
        } catch (error) {
            throw new Error(
                redaction.text(error instanceof Error ? error.message : String(error))
            );
        }
    }

    private async file(
        base: string,
        token: string,
        file: WorkerOutcomeFile,
        ordinal: number,
        redaction: WorkerOutcomeRedaction,
        warnings: OutcomeWarning[],
        report: (message: string) => void,
        staging: string
    ): Promise<void> {
        await mkdir(staging, { recursive: true, mode: 0o700 });
        const directory = await mkdtemp(join(staging, 'upload-'));
        try {
            await this.send(
                base,
                token,
                file,
                ordinal,
                redaction,
                warnings,
                report,
                join(directory, 'content')
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }

    private async send(
        base: string,
        token: string,
        file: WorkerOutcomeFile,
        ordinal: number,
        redaction: WorkerOutcomeRedaction,
        warnings: OutcomeWarning[],
        report: (message: string) => void,
        path: string
    ): Promise<void> {
        // Shared outcome blobs remain immutable for local inspection and other outcomes.
        const descriptor = await redaction.write(await file.source(), path);
        const begin = await this.retry(`${base}/files`, {
            method: 'POST',
            token,
            body: {
                path: file.path,
                ...descriptor,
                ordinal,
                media_type: file.media_type,
            },
        });
        if (this.skipped(begin, file.path, warnings, report)) return;
        if (isRecord(begin) && begin.stored === true) return;
        if (
            !isRecord(begin) ||
            typeof begin.upload !== 'string' ||
            typeof begin.part_bytes !== 'number' ||
            !Number.isSafeInteger(begin.part_bytes) ||
            begin.part_bytes <= 0 ||
            begin.part_bytes > 64 * 1024 ** 2
        )
            throw new Error('Malformed outcome file upload response');
        const upload = `${base}/files/${encodeURIComponent(begin.upload)}`;
        const parts: Array<{ number: number; etag: string }> = [];
        const input = await open(path, 'r');
        try {
            let offset = 0;
            while (offset < descriptor.size) {
                const bytes = Buffer.alloc(
                    Math.min(begin.part_bytes, descriptor.size - offset)
                );
                let read = 0;
                while (read < bytes.length) {
                    const result = await input.read(
                        bytes,
                        read,
                        bytes.length - read,
                        offset + read
                    );
                    if (!result.bytesRead)
                        throw new Error('Outcome upload copy ended early');
                    read += result.bytesRead;
                }
                const number = parts.length + 1;
                const part = await this.retry(`${upload}/parts/${number}`, {
                    method: 'PUT',
                    token,
                    raw: bytes,
                    contentType: 'application/octet-stream',
                });
                if (!isRecord(part) || typeof part.etag !== 'string')
                    throw new Error('Malformed outcome part response');
                parts.push({ number, etag: part.etag });
                offset += bytes.length;
            }
        } finally {
            await input.close();
        }
        const complete = await this.retry(`${upload}/complete`, {
            method: 'POST',
            token,
            body: { parts },
        });
        if (this.skipped(complete, file.path, warnings, report)) return;
        if (
            !isRecord(complete) ||
            complete.path !== file.path ||
            complete.size !== descriptor.size
        )
            throw new Error('Malformed outcome file completion response');
    }

    private skipped(
        value: unknown,
        path: string,
        warnings: OutcomeWarning[],
        report: (message: string) => void
    ): boolean {
        if (!isRecord(value) || !isRecord(value.skipped)) return false;
        if (
            typeof value.skipped.code !== 'string' ||
            typeof value.skipped.message !== 'string'
        )
            throw new Error('Malformed outcome skip response');
        warnings.push({
            code: value.skipped.code,
            message: `Skipped ${path}: ${value.skipped.message}`,
        });
        report(value.skipped.message);
        return true;
    }

    private async retry(
        path: string,
        options: Parameters<WorkerOutcomeRequest>[1]
    ): Promise<unknown> {
        for (let attempt = 0; ; attempt += 1) {
            try {
                return await this.request(path, options);
            } catch (error) {
                const status =
                    error instanceof Error && 'status' in error
                        ? error.status
                        : undefined;
                if (
                    attempt >= 2 ||
                    (status !== 0 && !(typeof status === 'number' && status >= 500))
                )
                    throw error;
                await this.wait(100 * 2 ** attempt);
            }
        }
    }
}
