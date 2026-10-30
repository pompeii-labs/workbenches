import { RuntimeError } from '../error.js';
import type {
    DaytonaClient,
    DaytonaCreateOptions,
    DaytonaSandbox,
    DaytonaSandboxSummary,
    DaytonaSnapshot,
    DaytonaSnapshotOptions,
} from './contracts.js';
import { ImageDigests } from './digests.js';
import { DaytonaToolbox } from './toolbox.js';
import {
    DaytonaApiError,
    type DaytonaApiOptions,
    DaytonaTransport,
    type SandboxDto,
} from './transport.js';

/**
 * Daytona over its REST API, with an injected `fetch` and nothing else.
 *
 * Sandbox management calls (create, list, delete, preview URLs) use the documented
 * OpenAPI surface at `DAYTONA_API_URL`. Commands and files go to the sandbox's
 * toolbox, reached at `<toolboxProxyUrl>/<sandboxId>` with the same credential.
 * Every toolbox path and payload lives in `DaytonaToolbox`, so that is the
 * one place to adjust if Daytona revises it. Image digests are read from the
 * image's registry without the Daytona credential, anonymously and then with
 * `registryLogins` when the registry refuses.
 */
export class DaytonaApi implements DaytonaClient {
    private readonly transport: DaytonaTransport;
    private readonly digests: ImageDigests;

    constructor(options: DaytonaApiOptions) {
        if (!options.apiKey.trim()) {
            throw new RuntimeError(
                'daytona',
                'prepare',
                'A Daytona API key is required'
            );
        }
        this.transport = new DaytonaTransport(options);
        const fetcher = options.fetch;
        this.digests = new ImageDigests(
            (input, init) => fetcher(input, init),
            this.transport.requestTimeoutMs,
            options.registryLogins
        );
    }

    imageDigest(reference: string): Promise<string> {
        return this.digests.resolve(reference);
    }

    /**
     * `POST /snapshots`. A resend is safe because a snapshot's name is unique:
     * Daytona answers 409 for a name that exists, and that snapshot is returned.
     */
    async createSnapshot(options: DaytonaSnapshotOptions): Promise<DaytonaSnapshot> {
        const { resources } = options;
        const body = {
            name: options.name,
            imageName: options.image,
            ...(resources.cpu ? { cpu: resources.cpu } : {}),
            ...(resources.memoryGb ? { memory: resources.memoryGb } : {}),
            ...(resources.diskGb ? { disk: resources.diskGb } : {}),
        };
        try {
            return snapshot(
                await this.transport.json<unknown>('POST', '/snapshots', {
                    json: body,
                    repeatable: true,
                })
            );
        } catch (error) {
            if (error instanceof DaytonaApiError && error.status === 409) {
                const existing = await this.getSnapshot(options.name);
                if (existing) return existing;
            }
            throw error;
        }
    }

    async getSnapshot(name: string): Promise<DaytonaSnapshot | undefined> {
        const dto = await this.transport
            .json<unknown>('GET', `/snapshots/${encodeURIComponent(name)}`)
            .catch((error) => {
                if (error instanceof DaytonaApiError && error.status === 404) {
                    return undefined;
                }
                throw error;
            });
        return dto === undefined ? undefined : snapshot(dto);
    }

    async deleteSnapshot(name: string): Promise<void> {
        const existing = await this.getSnapshot(name);
        if (!existing) return;
        try {
            await this.transport.request(
                'DELETE',
                `/snapshots/${encodeURIComponent(existing.id)}`
            );
        } catch (error) {
            if (error instanceof DaytonaApiError && error.status === 404) return;
            throw error;
        }
    }

    /**
     * `POST /snapshots/{id}/activate`. Daytona answers 400 for a snapshot that
     * is not inactive, which another run may have just activated.
     */
    async activateSnapshot(name: string): Promise<void> {
        const existing = await this.getSnapshot(name);
        if (!existing) return;
        try {
            await this.transport.request(
                'POST',
                `/snapshots/${encodeURIComponent(existing.id)}/activate`
            );
        } catch (error) {
            if (
                error instanceof DaytonaApiError &&
                (error.status === 400 || error.status === 404)
            ) {
                return;
            }
            throw error;
        }
    }

    async createSandbox(options: DaytonaCreateOptions): Promise<DaytonaSandbox> {
        // Resources belong to the snapshot: Daytona refuses them here.
        const body = {
            snapshot: options.snapshot,
            labels: options.labels,
            ...(options.env && Object.keys(options.env).length > 0
                ? { env: options.env }
                : {}),
            // A run owns its sandbox until cleanup, so inactivity auto-stop is off
            // (0 disables it; the default is 15 minutes). Daytona's wall-clock TTL
            // is the safety net if this process dies: it destroys the sandbox
            // `leaseMinutes` after creation in any state, so an abandoned sandbox
            // never outlives the lease and needs no separate stop or delete.
            autoStopInterval: 0,
            ttlMinutes: options.leaseMinutes,
        };
        let created: SandboxDto;
        try {
            created = await this.transport.json<SandboxDto>('POST', '/sandbox', {
                json: body,
            });
        } catch (error) {
            // A timeout or an unreadable reply does not mean nothing was created.
            if (!this.rejected(error)) await this.reclaim(options.labels, error);
            throw error;
        }
        try {
            const ready = await this.transport.waitUntilStarted(created.id);
            return new DaytonaToolbox(
                this.transport,
                ready.id,
                await this.transport.toolboxUrl(ready)
            );
        } catch (error) {
            // Never leave a sandbox behind that the caller never received.
            await this.deleteSandbox(created.id).catch(() => {});
            throw error;
        }
    }

    /** True when Daytona refused the request, so it created nothing. */
    private rejected(error: unknown): boolean {
        return (
            error instanceof DaytonaApiError &&
            error.status !== undefined &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status !== 408
        );
    }

    /**
     * Deletes any sandbox carrying `labels`, which are unique to one run, after
     * a create request whose outcome is unknown. If that cannot be done, the
     * error says which label to look for so the sandbox can be deleted by hand.
     */
    private async reclaim(
        labels: Record<string, string>,
        cause: unknown
    ): Promise<void> {
        try {
            for (const sandbox of await this.listSandboxes(labels)) {
                await this.deleteSandbox(sandbox.id);
            }
        } catch (error) {
            throw new RuntimeError(
                'daytona',
                'prepare',
                `${cause instanceof Error ? cause.message : String(cause)}. A Daytona sandbox may have been created and could not be removed (${error instanceof Error ? error.message : String(error)}). Delete sandboxes with labels ${JSON.stringify(labels)}.`,
                { cause }
            );
        }
    }

    async listSandboxes(
        labels: Record<string, string>
    ): Promise<DaytonaSandboxSummary[]> {
        const result: DaytonaSandboxSummary[] = [];
        let cursor: string | undefined;
        do {
            const page = await this.transport.json<{
                items?: SandboxDto[];
                nextCursor?: string | null;
            }>('GET', '/sandbox', {
                query: {
                    labels: JSON.stringify(labels),
                    limit: '200',
                    ...(cursor ? { cursor } : {}),
                },
            });
            for (const item of page.items ?? []) {
                result.push({
                    id: item.id,
                    labels: item.labels ?? {},
                    state: item.state ?? 'unknown',
                });
            }
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return result;
    }

    async getSandbox(id: string): Promise<DaytonaSandbox | undefined> {
        const dto = await this.transport
            .json<SandboxDto>('GET', `/sandbox/${encodeURIComponent(id)}`)
            .catch((error) => {
                if (error instanceof DaytonaApiError && error.status === 404) {
                    return undefined;
                }
                throw error;
            });
        if (!dto) return undefined;
        return new DaytonaToolbox(
            this.transport,
            dto.id,
            await this.transport.toolboxUrl(dto),
            dto.state
        );
    }

    async deleteSandbox(id: string): Promise<void> {
        try {
            await this.transport.request(
                'DELETE',
                `/sandbox/${encodeURIComponent(id)}`
            );
        } catch (error) {
            // Already gone is the state the caller wanted.
            if (error instanceof DaytonaApiError && error.status === 404) return;
            throw error;
        }
    }

    /** `POST /sandbox/{sandboxIdOrName}/start`, then waits until it is started. */
    async startSandbox(id: string): Promise<DaytonaSandbox> {
        await this.transport.request(
            'POST',
            `/sandbox/${encodeURIComponent(id)}/start`
        );
        const ready = await this.transport.waitUntilStarted(id);
        return new DaytonaToolbox(
            this.transport,
            ready.id,
            await this.transport.toolboxUrl(ready),
            ready.state
        );
    }

    /** `POST /sandbox/{sandboxIdOrName}/stop`, then waits until it is stopped. */
    async stopSandbox(id: string): Promise<void> {
        await this.transport.request('POST', `/sandbox/${encodeURIComponent(id)}/stop`);
        await this.transport.waitUntilStopped(id);
    }

    /** `POST /sandbox/{sandboxIdOrName}/ttl/{ttlMinutes}`. The deadline counts from now. */
    async setSandboxTtl(id: string, minutes: number): Promise<void> {
        await this.transport.request(
            'POST',
            `/sandbox/${encodeURIComponent(id)}/ttl/${interval(minutes, 0)}`
        );
    }

    /** `POST /sandbox/{sandboxIdOrName}/autodelete/{interval}`. */
    async setAutoDeleteInterval(id: string, minutes: number): Promise<void> {
        await this.transport.request(
            'POST',
            `/sandbox/${encodeURIComponent(id)}/autodelete/${interval(minutes, -1)}`
        );
    }

    /**
     * `POST /sandbox/{sandboxIdOrName}/autoarchive/{interval}`. Daytona
     * documents `0` as the maximum interval, so a caller that needs a bound
     * passes the minutes it needs.
     */
    async setAutoArchiveInterval(id: string, minutes: number): Promise<void> {
        await this.transport.request(
            'POST',
            `/sandbox/${encodeURIComponent(id)}/autoarchive/${interval(minutes, 0)}`
        );
    }
}

/** A whole number of minutes for a path segment, no smaller than `minimum`. */
function interval(minutes: number, minimum: number): string {
    if (!Number.isSafeInteger(minutes) || minutes < minimum) {
        throw new DaytonaApiError(`Invalid Daytona interval: ${minutes} minutes`);
    }
    return String(minutes);
}

/** A snapshot from a Daytona reply, narrowed to the fields the engine reads. */
function snapshot(value: unknown): DaytonaSnapshot {
    const field = (name: string): unknown =>
        typeof value === 'object' && value !== null
            ? Reflect.get(value, name)
            : undefined;
    const id = field('id');
    const name = field('name');
    const state = field('state');
    const errorReason = field('errorReason');
    if (typeof id !== 'string' || typeof name !== 'string') {
        throw new DaytonaApiError('Daytona returned a snapshot without an id or name');
    }
    return {
        id,
        name,
        state: typeof state === 'string' ? state : 'unknown',
        ...(typeof errorReason === 'string' && errorReason ? { errorReason } : {}),
    };
}
