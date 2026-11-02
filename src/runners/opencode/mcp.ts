import { record, string } from './json.js';
import type { OpenCodeServer } from './server.js';

/** OpenCode's own limit for connecting one MCP server that sets no startup timeout. */
const OPENCODE_DEFAULT_STARTUP_MS = 30_000;
/**
 * OpenCode reloads its tool registry 100 ms after a server's tools change and
 * reports nothing when the reload is done, so this covers it.
 */
const TOOL_REGISTRATION_MS = 250;

/**
 * OpenCode 2 connects MCP servers in the background after a location opens,
 * and a turn sees only the tools of servers already connected. This waits
 * until every configured server has connected, failed, or needs sign-in, so
 * the first turn has the same tools as the ones after it. It reads `/mcp`
 * again only when the event stream reports a status change. A server still
 * starting after its own startup timeout is left to join later.
 */
export class OpenCodeMcpStartup {
    constructor(
        private readonly server: Pick<
            OpenCodeServer,
            'requestJson' | 'mcpStatusChanged'
        >
    ) {}

    async wait(): Promise<void> {
        const configured = configuredServers(
            await this.server.requestJson('/config', { method: 'GET' })
        );
        if (configured.size === 0) return;
        const deadline = Date.now() + Math.max(...configured.values());
        for (;;) {
            const changed = this.server.mcpStatusChanged();
            const statuses = serverStatuses(
                await this.server.requestJson('/mcp', { method: 'GET' })
            );
            const settled = [...configured.keys()].every((name) => {
                const status = statuses.get(name);
                return status !== undefined && status !== 'pending';
            });
            if (settled) {
                if ([...statuses.values()].includes('connected'))
                    await Bun.sleep(TOOL_REGISTRATION_MS);
                return;
            }
            if (!(await settlesWithin(changed, deadline - Date.now()))) return;
        }
    }
}

/** Whether `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
    if (ms <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
    });
    try {
        return await Promise.race([promise.then(() => true), expired]);
    } finally {
        clearTimeout(timer);
    }
}

/** Enabled servers in OpenCode's resolved config, by their startup limit. */
export function configuredServers(entries: unknown): Map<string, number> {
    const defaults: number[] = [];
    const servers = new Map<string, Record<string, unknown>>();
    for (const value of Array.isArray(entries) ? entries : []) {
        const entry = record(value);
        if (entry?.type !== 'document') continue;
        const mcp = record(record(entry.info)?.mcp);
        const startup = record(mcp?.timeout)?.startup;
        if (typeof startup === 'number') defaults.push(startup);
        for (const [name, server] of Object.entries(record(mcp?.servers) ?? {})) {
            const config = record(server);
            if (config) servers.set(name, config);
        }
    }
    const fallback = defaults.at(-1) ?? OPENCODE_DEFAULT_STARTUP_MS;
    return new Map(
        [...servers]
            .filter(([, config]) => config.disabled !== true)
            .map(([name, config]) => {
                const startup = record(config.timeout)?.startup;
                return [name, typeof startup === 'number' ? startup : fallback];
            })
    );
}

function serverStatuses(listing: unknown): Map<string, string> {
    const statuses = new Map<string, string>();
    for (const value of Array.isArray(listing) ? listing : []) {
        const server = record(value);
        const name = string(server?.name);
        const status = string(record(server?.status)?.status);
        if (name && status) statuses.set(name, status);
    }
    return statuses;
}
