import { ModelCatalog, ModelRouter } from '../models/index.js';
import type { RunnerEventNormalizer, RunnerSummary } from '../runners/runner.js';
import type { ResolvedWorkbench, SpawnedRunner } from '../types.js';
import type { RunEvents } from './events.js';

export interface RunnerOutputResult {
    code: number;
    stderr: string;
    summary: RunnerSummary;
}

export class RunnerOutput {
    private static readonly maximumEventBytes = 16 * 1024 * 1024;
    private static readonly maximumErrorBytes = 64 * 1024;

    constructor(
        private readonly normalizer: RunnerEventNormalizer,
        private readonly events: RunEvents
    ) {}

    async consume(
        process: SpawnedRunner,
        cancel: () => void
    ): Promise<RunnerOutputResult> {
        const stderr = this.readText(process.stderr, RunnerOutput.maximumErrorBytes);
        try {
            await Promise.all([this.consumeEvents(process.stdout), process.exited]);
        } catch (error) {
            cancel();
            await Promise.allSettled([process.exited, stderr]);
            throw error;
        }
        const [code, errorText] = await Promise.all([process.exited, stderr]);
        return {
            code,
            stderr: errorText,
            summary: this.normalizer.summary(),
        };
    }

    static failureDetail(
        source: string,
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>
    ): string {
        return RunnerOutput.firstLine(
            RunnerOutput.redact(source, workbench, environment)
        );
    }

    static redact(
        source: string,
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>
    ): string {
        let result = source;
        const catalog = ModelCatalog.active();
        const names = new Set([
            ...Object.keys(workbench.manifest.env),
            ...Object.keys(environment).filter(RunnerOutput.isCredentialName),
            ...(catalog
                ? new ModelRouter(catalog).providerEnvironmentNames(workbench)
                : []),
        ]);
        const values = [...names]
            .flatMap((name) => {
                const value = environment[name];
                return value && value.length >= 4 ? [value] : [];
            })
            .toSorted((left, right) => right.length - left.length);
        for (const value of values) result = result.replaceAll(value, '[REDACTED]');
        return result;
    }

    private static isCredentialName(name: string): boolean {
        return /(?:^|_)(?:API_?KEY|AUTH|CREDENTIALS?|PASSWORD|PRIVATE_?KEY|SECRET|TOKEN)(?:_|$)/i.test(
            name
        );
    }

    private async consumeEvents(
        stream: ReadableStream<Uint8Array> | undefined
    ): Promise<void> {
        await this.consumeLines(stream, async (line) => {
            let value: unknown;
            try {
                value = JSON.parse(line);
            } catch {
                value = null;
            }
            const normalized = this.normalizer.consume(value);
            for (const event of normalized.events) {
                await this.events.emitDraft(event);
            }
        });
    }

    private async consumeLines(
        stream: ReadableStream<Uint8Array> | undefined,
        consume: (line: string) => Promise<void>
    ): Promise<void> {
        if (!stream) return;
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        while (true) {
            const result = await reader.read();
            if (result.done) break;
            pending += decoder.decode(result.value, { stream: true });
            if (pending.length > RunnerOutput.maximumEventBytes) {
                throw new Error('Runner emitted an oversized JSON event');
            }
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            for (const line of lines) {
                const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
                if (normalized.trim()) await consume(normalized);
            }
        }
        pending += decoder.decode();
        if (pending.trim()) await consume(pending);
    }

    private async readText(
        stream: ReadableStream<Uint8Array> | undefined,
        limit: number
    ): Promise<string> {
        if (!stream) return '';
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let result = '';
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            if (result.length < limit) {
                result += decoder.decode(next.value, { stream: true });
                if (result.length > limit) result = result.slice(0, limit);
            }
        }
        return result + decoder.decode();
    }

    private static firstLine(value: string): string {
        return (
            RunnerOutput.stripTerminalControl(value)
                .split(/\r?\n/)
                .map((line) => line.trim())
                .find(Boolean)
                ?.slice(0, 500) ?? ''
        );
    }

    private static stripTerminalControl(value: string): string {
        let result = '';
        for (let index = 0; index < value.length; index += 1) {
            if (value.charCodeAt(index) !== 27) {
                result += value[index];
                continue;
            }
            if (value[index + 1] !== '[') {
                index += 1;
                continue;
            }
            index += 2;
            while (index < value.length) {
                const code = value.charCodeAt(index);
                if (code >= 0x40 && code <= 0x7e) break;
                index += 1;
            }
        }
        return result;
    }
}
