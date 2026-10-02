import { RuntimeError } from '../error.js';
import type {
    DaytonaClient,
    DaytonaCreateOptions,
    DaytonaSandbox,
    DaytonaSandboxSummary,
} from './contracts.js';
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
 * one place to adjust if Daytona revises it.
 */
export class DaytonaApi implements DaytonaClient {
    private readonly transport: DaytonaTransport;

    constructor(options: DaytonaApiOptions) {
        if (!options.apiKey.trim()) {
            throw new RuntimeError(
                'daytona',
                'prepare',
                'A Daytona API key is required'
            );
        }
        this.transport = new DaytonaTransport(options);
    }

    async createSandbox(options: DaytonaCreateOptions): Promise<DaytonaSandbox> {
        const body = {
            buildInfo: { dockerfileContent: `FROM ${imageReference(options.image)}` },
            labels: options.labels,
            ...(options.env && Object.keys(options.env).length > 0
                ? { env: options.env }
                : {}),
            ...(options.resources?.cpu ? { cpu: options.resources.cpu } : {}),
            ...(options.resources?.memoryGb
                ? { memory: options.resources.memoryGb }
                : {}),
            ...(options.resources?.diskGb ? { disk: options.resources.diskGb } : {}),
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
}

function imageReference(image: string): string {
    if (!image.trim() || /[\s\0]/.test(image)) {
        throw new RuntimeError(
            'daytona',
            'prepare',
            `Invalid Daytona image reference: ${JSON.stringify(image)}`
        );
    }
    return image.trim();
}
