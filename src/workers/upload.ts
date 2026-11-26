import { open } from 'node:fs/promises';

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
    }
) => Promise<unknown>;

/** Sends unchanged blob slices directly to storage, redacting only metadata. */
export class WorkerOutcomeUpload {
    constructor(
        private readonly request: WorkerOutcomeRequest,
        /** Waits between retries of a failed part or step. */
        private readonly wait: (milliseconds: number) => Promise<void>,
        private readonly transfer: (
            url: string,
            options: RequestInit
        ) => Promise<Response> = fetch
    ) {}

    /** True when the server confirmed every file stored. */
    async uploadOutcome(
        run: string,
        token: string,
        outcome: WorkerOutcomeData,
        credentials: string[],
        report: (message: string) => void
    ): Promise<boolean> {
        const base = `/v1/runs/${encodeURIComponent(run)}/outcome`;
        const redaction = new WorkerOutcomeRedaction(credentials);
        const emit = (message: string) => report(redaction.text(message));
        const warnings = [...outcome.manifest.warnings];
        let stored = true;
        for (const [ordinal, file] of outcome.files.entries()) {
            try {
                if (
                    !(await this.file(
                        base,
                        token,
                        { ...file, path: redaction.text(file.path) },
                        ordinal,
                        warnings,
                        emit
                    ))
                )
                    stored = false;
            } catch (error) {
                stored = false;
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
        return stored;
    }

    /** True when the file is stored, false when the server skipped it. */
    private async file(
        base: string,
        token: string,
        file: WorkerOutcomeFile,
        ordinal: number,
        warnings: OutcomeWarning[],
        report: (message: string) => void
    ): Promise<boolean> {
        const size = file.content.size_bytes;
        const begin = await this.retry(`${base}/files`, {
            method: 'POST',
            token,
            body: {
                path: file.path,
                size,
                sha256: file.content.digest.slice('sha256:'.length),
                ordinal,
                media_type: file.content.media_type,
            },
        });
        if (this.skipped(begin, file.path, warnings, report)) return false;
        if (isRecord(begin) && begin.stored === true) return true;
        if (
            !isRecord(begin) ||
            typeof begin.upload !== 'string' ||
            typeof begin.part_bytes !== 'number' ||
            !Number.isSafeInteger(begin.part_bytes) ||
            begin.part_bytes <= 0 ||
            !Array.isArray(begin.parts) ||
            !begin.parts.every(
                (part: unknown) => typeof part === 'string' && /^https?:\/\//.test(part)
            ) ||
            begin.parts.length !== Math.max(1, Math.ceil(size / begin.part_bytes))
        )
            throw new Error('Malformed outcome file upload response');
        const upload = `${base}/files/${encodeURIComponent(begin.upload)}`;
        const parts: Array<{ number: number; etag: string }> = [];
        const input = await open(await file.source(), 'r');
        try {
            let offset = 0;
            for (const url of begin.parts) {
                if (typeof url !== 'string')
                    throw new Error('Malformed outcome part URL');
                const bytes = Buffer.alloc(Math.min(begin.part_bytes, size - offset));
                let read = 0;
                while (read < bytes.length) {
                    const result = await input.read(
                        bytes,
                        read,
                        bytes.length - read,
                        offset + read
                    );
                    if (!result.bytesRead) throw new Error('Outcome blob ended early');
                    read += result.bytesRead;
                }
                const number = parts.length + 1;
                const etag = await this.retryStep(async () => {
                    const response = await this.transfer(url, {
                        method: 'PUT',
                        headers: { 'Content-Length': String(bytes.length) },
                        body: bytes,
                        // Generous enough for a full part on a slow home uplink.
                        signal: AbortSignal.timeout(15 * 60_000),
                    });
                    await response.body?.cancel();
                    if (!response.ok)
                        throw new Error(
                            `Outcome part upload failed (HTTP ${response.status})`
                        );
                    const etag = response.headers.get('ETag');
                    if (etag === null)
                        throw new Error('Outcome part response has no ETag');
                    return etag;
                });
                parts.push({ number, etag });
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
        if (this.skipped(complete, file.path, warnings, report)) return false;
        if (
            !isRecord(complete) ||
            complete.path !== file.path ||
            complete.size !== size
        )
            throw new Error('Malformed outcome file completion response');
        return true;
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
        return this.retryStep(
            () => this.request(path, options),
            // An API refusal answers the same way every time; only network and server failures get retried.
            (error) => {
                const status =
                    error instanceof Error && 'status' in error
                        ? error.status
                        : undefined;
                return status === 0 || (typeof status === 'number' && status >= 500);
            }
        );
    }

    private async retryStep<T>(
        operation: () => Promise<T>,
        retryable: (error: unknown) => boolean = () => true
    ): Promise<T> {
        for (let attempt = 0; ; attempt += 1) {
            try {
                return await operation();
            } catch (error) {
                if (attempt >= 2 || !retryable(error)) throw error;
                await this.wait(100 * 2 ** attempt);
            }
        }
    }
}
