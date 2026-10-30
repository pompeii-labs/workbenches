import { describe, expect, test } from 'bun:test';
import {
    configuredServers,
    OpenCodeMcpStartup,
} from '../../../src/runners/opencode/mcp.js';

// The resolved config OpenCode 2.2.2 reports for a package config whose V1
// `mcp` entries it translated into `mcp.servers`.
const config = [
    { type: 'directory', path: '/staged' },
    {
        type: 'document',
        path: '/staged/native/runner/opencode.json',
        info: {
            mcp: {
                servers: {
                    meshy: {
                        type: 'local',
                        command: ['npx', '-y', 'meshy'],
                        disabled: false,
                        timeout: {
                            startup: 120000,
                            catalog: 120000,
                            execution: 120000,
                        },
                    },
                    elevenlabs: { type: 'local', command: ['elevenlabs'] },
                    retired: { type: 'local', command: ['retired'], disabled: true },
                },
            },
        },
    },
    {
        type: 'document',
        info: {
            mcp: { timeout: { startup: 45000 }, servers: { lux: { type: 'remote' } } },
        },
    },
];

/** A server that reports a status change after each `/mcp` read, until `quiet`. */
function server(listings: unknown[][], resolved: unknown = config, quiet = false) {
    const paths: string[] = [];
    return {
        paths,
        mcpStatusChanged: () =>
            quiet ? new Promise<void>(() => {}) : Promise.resolve(),
        requestJson: async (path: string) => {
            paths.push(path);
            if (path === '/config') return resolved;
            return listings[Math.min(paths.length - 2, listings.length - 1)] ?? [];
        },
    };
}

const status = (name: string, value: string) => ({ name, status: { status: value } });

describe('OpenCode MCP startup', () => {
    test('reads enabled servers and their startup limits from the resolved config', () => {
        expect([...configuredServers(config)]).toEqual([
            ['meshy', 120000],
            ['elevenlabs', 45000],
            ['lux', 45000],
        ]);
        expect(configuredServers([{ type: 'document', info: {} }]).size).toBe(0);
        expect(configuredServers({ data: [] }).size).toBe(0);
    });

    test('reads status again on each change until every server leaves pending', async () => {
        const native = server([
            [],
            [status('meshy', 'pending'), status('elevenlabs', 'connected')],
            [
                status('meshy', 'connected'),
                status('elevenlabs', 'connected'),
                status('lux', 'needs_auth'),
            ],
        ]);
        await new OpenCodeMcpStartup(native).wait();
        expect(native.paths).toEqual(['/config', '/mcp', '/mcp', '/mcp']);
    });

    test('does not wait when no server is configured or none connected', async () => {
        const empty = server([], []);
        await new OpenCodeMcpStartup(empty).wait();
        expect(empty.paths).toEqual(['/config']);
        const failed = server([
            [
                status('meshy', 'failed'),
                status('elevenlabs', 'failed'),
                status('lux', 'failed'),
            ],
        ]);
        await new OpenCodeMcpStartup(failed).wait();
        expect(failed.paths).toEqual(['/config', '/mcp']);
    });

    test('stops waiting at the server startup limit when no change arrives', async () => {
        const quick = [
            {
                type: 'document',
                info: {
                    mcp: {
                        servers: { meshy: { type: 'local', timeout: { startup: 20 } } },
                    },
                },
            },
        ];
        const native = server([[status('meshy', 'pending')]], quick, true);
        await new OpenCodeMcpStartup(native).wait();
        expect(native.paths).toEqual(['/config', '/mcp']);
    });
});
