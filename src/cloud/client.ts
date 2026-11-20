import { mkdir, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { RegistryClient } from '../registry/client.js';
import type { RegistryKeyring } from '../registry/keyring.js';
import type { RunSnapshot } from '../runs/supervision.js';
import type { SessionInputResult } from '../sessions/control.js';
import {
    type CloudEvent,
    type CloudFiles,
    type CloudRun,
    parseEvent,
    parseRun,
    terminal,
} from './contracts.js';
import { CloudObservation } from './observation.js';

/** Drives runs on workbenches.dev through its public API with the `wb login` key. */
export class CloudClient {
    /**
     * `silence` is how long a live event socket may stay quiet before it is
     * replaced: an idle connection can die without a close frame, and a fresh
     * one resumes from the last sequence.
     */
    constructor(
        private readonly registry: RegistryClient,
        private readonly keyring: RegistryKeyring,
        private readonly silence: number
    ) {}

    /** The client a command's setup composed for `--cloud`. */
    static from(data: unknown): CloudClient {
        if (!(data instanceof CloudClient))
            throw new Error('Cloud client is unavailable');
        return data;
    }

    async start(body: Record<string, unknown>): Promise<CloudRun> {
        if (typeof body.workbench === 'string') {
            const reference = RegistryClient.parseVersionReference(body.workbench);
            if (reference) {
                const token = await this.token();
                const value: unknown = await this.registry.request('/v1/resolutions', {
                    method: 'POST',
                    token,
                    body: {
                        publisher: reference.publisher,
                        workbench: reference.workbench,
                    },
                });
                if (
                    !RegistryClient.isRecord(value) ||
                    !RegistryClient.isRecord(value.latest_version) ||
                    typeof value.latest_version.id !== 'string' ||
                    typeof value.latest_version.version !== 'string' ||
                    typeof value.workbench_id !== 'string'
                )
                    throw new Error(
                        'The cloud API returned a malformed Workbench resolution'
                    );
                const selected =
                    value.latest_version.version === reference.version
                        ? value.latest_version.id
                        : (
                              await this.registry.versions(value.workbench_id, token)
                          ).versions.find(
                              (version) => version.version === reference.version
                          )?.id;
                if (!selected)
                    throw new Error(
                        `Workbench version ${reference.version} does not exist`
                    );
                body = { ...body, workbench: { version_id: selected } };
            }
        }
        return parseRun(
            await this.registry.request<unknown>('/v1/runs', {
                method: 'POST',
                token: await this.token(),
                body: { ...body, idempotency_key: crypto.randomUUID() },
            })
        );
    }

    async read(id: string, signal?: AbortSignal): Promise<CloudRun> {
        return parseRun(
            await this.registry.request<unknown>(this.path(id), {
                token: await this.token(),
                ...(signal ? { signal } : {}),
            })
        );
    }

    /** Unfinished runs, those waiting on input first, or every run with `all`. The API filters by status. */
    async *list(all: boolean): AsyncGenerator<CloudRun> {
        for (const view of all ? ['all'] : ['needs_input', 'active']) {
            let cursor: string | null = null;
            do {
                const query = new URLSearchParams({ limit: '100', view });
                if (cursor) query.set('cursor', cursor);
                const value: unknown = await this.registry.request(
                    `/v1/runs?${query}`,
                    {
                        token: await this.token(),
                    }
                );
                if (
                    !RegistryClient.isRecord(value) ||
                    !Array.isArray(value.runs) ||
                    (value.next !== null && typeof value.next !== 'string')
                )
                    throw new Error('The cloud API returned a malformed run list');
                for (const run of value.runs) yield parseRun(run);
                if (value.next === cursor && cursor !== null)
                    throw new Error('The cloud API repeated a run list cursor');
                cursor = value.next;
            } while (cursor);
        }
    }

    /**
     * Answers a pending request and returns once the runner has taken it, as a
     * local answer does, so a `wait` from the receipt no longer reports the
     * request. A runner that has not taken it within 30 seconds leaves the
     * receipt pending.
     */
    async answer(
        id: string,
        request: string,
        response: unknown
    ): Promise<SessionInputResult & { command_status: string }> {
        const receipt = await this.command(id, 'answer', {
            request_id: request,
            response,
        });
        for await (const event of this.follow(
            id,
            receipt.after_sequence,
            AbortSignal.timeout(30_000)
        )) {
            const data = RegistryClient.isRecord(event.data) ? event.data : {};
            if (
                data.id === request &&
                [
                    'question.answered',
                    'question.rejected',
                    'input.accepted',
                    'input.rejected',
                ].includes(event.type)
            )
                return {
                    ...receipt,
                    after_sequence: event.sequence,
                    command_status: 'delivered',
                };
        }
        return receipt;
    }

    async command(
        id: string,
        kind: 'send' | 'steer' | 'queue' | 'answer' | 'cancel',
        payload: Record<string, unknown>
    ): Promise<SessionInputResult & { command_status: string }> {
        const run = await this.read(id);
        const value: unknown = await this.registry.request(
            `${this.path(id)}/commands`,
            {
                method: 'POST',
                token: await this.token(),
                body: { kind, payload, idempotency_key: crypto.randomUUID() },
            }
        );
        if (
            !RegistryClient.isRecord(value) ||
            !RegistryClient.isRecord(value.command) ||
            typeof value.command.id !== 'string' ||
            value.command.run_id !== id ||
            typeof value.command.status !== 'string' ||
            typeof value.after_sequence !== 'number' ||
            !Number.isSafeInteger(value.after_sequence) ||
            value.after_sequence < 0
        )
            throw new Error('The cloud API returned a malformed command receipt');
        return {
            session_id: run.session_id,
            run_id: id,
            input_id: value.command.id,
            after_sequence: value.after_sequence,
            command_status: value.command.status,
        };
    }

    async events(id: string, after = 0, signal?: AbortSignal): Promise<CloudEvent[]> {
        const value: unknown = await this.registry.request(
            `${this.path(id)}/events?after=${after}&limit=500`,
            { token: await this.token(), ...(signal ? { signal } : {}) }
        );
        if (
            !RegistryClient.isRecord(value) ||
            !Array.isArray(value.events) ||
            typeof value.next !== 'number'
        )
            throw new Error('The cloud API returned a malformed event page');
        const events = value.events.map((event) => parseEvent(event, id));
        let sequence = after;
        for (const event of events) {
            if (event.sequence !== sequence + 1)
                throw new Error('The cloud event sequence has a gap');
            sequence = event.sequence;
        }
        if (value.next !== sequence)
            throw new Error('The cloud API returned an invalid event cursor');
        return events;
    }

    async *follow(
        id: string,
        after = 0,
        signal?: AbortSignal
    ): AsyncGenerator<CloudEvent> {
        this.path(id);
        while (!signal?.aborted) {
            const url = new URL(
                `${this.registry.apiUrl}${this.path(id)}/events?after=${after}`
            );
            url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            const socket = new WebSocket(url, {
                headers: { Authorization: `Bearer ${await this.token()}` },
            });
            const queue: string[] = [];
            let closed = false;
            let reauthenticate = false;
            let failure: Error | undefined;
            let notify = () => {};
            const stop = () => {
                closed = true;
                socket.close();
                notify();
            };
            let quiet = setTimeout(stop, this.silence);
            socket.addEventListener('message', (message) => {
                clearTimeout(quiet);
                quiet = setTimeout(stop, this.silence);
                if (typeof message.data !== 'string') {
                    failure = new Error(
                        'The cloud event stream returned a non-text frame'
                    );
                    stop();
                    return;
                }
                queue.push(message.data);
                notify();
            });
            socket.addEventListener('error', () => {
                stop();
            });
            socket.addEventListener('close', (event) => {
                reauthenticate = event.code === 4001;
                closed = true;
                notify();
            });
            signal?.addEventListener('abort', stop, { once: true });
            if (signal?.aborted) stop();
            try {
                while (!signal?.aborted) {
                    const source = queue.shift();
                    if (source !== undefined) {
                        const value: unknown = JSON.parse(source);
                        const event = parseEvent(value, id);
                        if (event.sequence <= after) continue;
                        if (event.sequence !== after + 1)
                            throw new Error('The cloud event sequence has a gap');
                        after = event.sequence;
                        yield event;
                        if (
                            event.type === 'run.completed' ||
                            event.type === 'run.failed' ||
                            event.type === 'run.cancelled'
                        )
                            return;
                    } else if (closed) break;
                    else
                        await new Promise<void>((resolve) => {
                            notify = resolve;
                        });
                }
                if (failure) throw failure;
                if (signal?.aborted) return;
                if (terminal((await this.read(id, signal)).status)) {
                    let page: CloudEvent[];
                    do {
                        page = await this.events(id, after, signal);
                        for (const event of page) {
                            after = event.sequence;
                            yield event;
                        }
                    } while (page.length === 500);
                    return;
                }
                if (!reauthenticate)
                    await new Promise<void>((resolve) => setTimeout(resolve, 250));
            } catch (error) {
                if (signal?.aborted) return;
                throw error;
            } finally {
                clearTimeout(quiet);
                signal?.removeEventListener('abort', stop);
                socket.close();
            }
        }
    }

    async wait(
        id: string,
        options: {
            afterSequence?: number;
            timeoutMilliseconds?: number;
            signal?: AbortSignal;
        } = {}
    ): Promise<RunSnapshot> {
        const after = options.afterSequence ?? 0;
        const timeout = options.timeoutMilliseconds;
        if (!Number.isSafeInteger(after) || after < 0)
            throw new Error('--after must be a non-negative integer');
        if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0))
            throw new Error('--timeout must be a non-negative number of seconds');
        const observation = new CloudObservation(await this.read(id), after);
        const abort = new AbortController();
        const stop = () => abort.abort();
        const timer = timeout === undefined ? undefined : setTimeout(stop, timeout);
        options.signal?.addEventListener('abort', stop, { once: true });
        try {
            await this.replay(id, observation);
            let current = await this.read(id);
            if (terminal(current.status)) await this.replay(id, observation);
            let result = observation.settled(current);
            if (result) return result;
            if (!abort.signal.aborted && !options.signal?.aborted)
                for await (const event of this.follow(
                    id,
                    observation.sequence,
                    abort.signal
                )) {
                    observation.apply(event);
                    current = await this.read(id, abort.signal);
                    if (terminal(current.status))
                        await this.replay(id, observation, abort.signal);
                    result = observation.settled(current);
                    if (result) return result;
                }
            return {
                ...observation.snapshot(),
                ...(options.signal?.aborted
                    ? { interrupted: true }
                    : { state: 'timeout' }),
            };
        } catch (error) {
            if (!abort.signal.aborted && !options.signal?.aborted) throw error;
            return {
                ...observation.snapshot(),
                ...(options.signal?.aborted
                    ? { interrupted: true }
                    : { state: 'timeout' }),
            };
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            options.signal?.removeEventListener('abort', stop);
            abort.abort();
        }
    }

    async snapshot(id: string): Promise<RunSnapshot> {
        const observation = new CloudObservation(await this.read(id), 0);
        await this.replay(id, observation);
        const current = await this.read(id);
        if (terminal(current.status)) await this.replay(id, observation);
        return observation.snapshot(current);
    }

    private async replay(
        id: string,
        observation: CloudObservation,
        signal?: AbortSignal
    ): Promise<void> {
        let page: CloudEvent[];
        do {
            page = await this.events(id, observation.sequence, signal);
            for (const event of page) observation.apply(event);
        } while (page.length === 500);
    }

    async files(id: string): Promise<CloudFiles> {
        const value: unknown = await this.registry.request(
            `${this.path(id)}/outcome/files`,
            { token: await this.token() }
        );
        if (
            !RegistryClient.isRecord(value) ||
            !Array.isArray(value.files) ||
            typeof value.archive_url !== 'string'
        )
            throw new Error('The cloud API returned a malformed outcome');
        return {
            archive_url: value.archive_url,
            files: value.files.map((file) => {
                if (
                    !RegistryClient.isRecord(file) ||
                    typeof file.path !== 'string' ||
                    typeof file.name !== 'string' ||
                    typeof file.media_type !== 'string' ||
                    typeof file.size !== 'number' ||
                    typeof file.url !== 'string' ||
                    (file.description !== undefined &&
                        file.description !== null &&
                        typeof file.description !== 'string')
                )
                    throw new Error('The cloud API returned a malformed outcome file');
                return {
                    path: file.path,
                    name: file.name,
                    media_type: file.media_type,
                    size: file.size,
                    url: file.url,
                    ...(typeof file.description === 'string'
                        ? { description: file.description }
                        : {}),
                };
            }),
        };
    }

    async download(id: string, directory: string, files: CloudFiles): Promise<string> {
        const destination = resolve(directory);
        const paths = new Set<string>();
        for (const file of files.files) {
            if (
                paths.has(file.path) ||
                !file.path ||
                file.path.startsWith('/') ||
                file.path.includes('\\') ||
                file.path
                    .split('/')
                    .some((part) => !part || part === '.' || part === '..')
            )
                throw new Error('The cloud outcome contains an unsafe file path');
            paths.add(file.path);
        }
        await mkdir(destination);
        for (const file of files.files) {
            const path = join(destination, file.path);
            const response = await this.registry.response(
                `${this.path(id)}/outcome/files/${file.path.split('/').map(encodeURIComponent).join('/')}`,
                { token: await this.token() }
            );
            await mkdir(dirname(path), { recursive: true });
            const target = await open(path, 'wx');
            try {
                if (response.body) await target.writeFile(response.body);
            } finally {
                await target.close();
            }
        }
        return destination;
    }

    async diff(id: string): Promise<string> {
        return (
            await this.registry.response(`${this.path(id)}/changes`, {
                token: await this.token(),
            })
        ).text();
    }

    private path(id: string): string {
        if (!/^wb_[a-z0-9]{24}$/.test(id))
            throw new Error('Cloud commands require a cloud run ID (wb_...)');
        return `/v1/runs/${id}`;
    }

    private async token(): Promise<string> {
        const token = await this.keyring.select();
        if (!token)
            throw new Error('Cloud commands require wb login for an organization');
        return token;
    }
}
