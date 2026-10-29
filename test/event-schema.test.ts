import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';

import { WORKBENCH_EVENT_TYPES } from '../src/runs/index.js';

interface EventSchema {
    $id: string;
    $defs: {
        infrastructure: {
            required: string[];
            properties: {
                cost: {
                    oneOf: Array<{
                        required: string[];
                        properties: { kind: { const: string } };
                    }>;
                };
            };
        };
    };
    properties: {
        protocol: { const: number };
        type: { enum: string[] };
    };
}

describe('Workbench event schema', () => {
    test('stays in sync with the TypeScript event catalog', async () => {
        const source = await readFile(
            join(
                import.meta.dir,
                '..',
                'schemas',
                'events',
                'v0',
                'workbench-event.schema.json'
            ),
            'utf8'
        );
        const schema = JSON.parse(source) as EventSchema;

        expect(schema.$id).toBe(
            'https://workbenches.dev/schemas/events/v0/workbench-event.schema.json'
        );
        expect(schema.properties.protocol.const).toBe(0);
        expect(schema.properties.type.enum).toEqual([...WORKBENCH_EVENT_TYPES]);
        expect(schema.$defs.infrastructure.required).toEqual([
            'provider',
            'duration_ms',
            'cost',
        ]);
        expect(schema.$defs.infrastructure.properties.cost.oneOf).toEqual([
            expect.objectContaining({
                required: ['kind', 'currency', 'amount_usd', 'source'],
                properties: expect.objectContaining({
                    kind: { const: 'estimated' },
                }),
            }),
            expect.objectContaining({
                required: ['kind', 'currency'],
                properties: expect.objectContaining({
                    kind: { const: 'unavailable' },
                }),
            }),
        ]);
    });
});

describe('preview.available event schema', () => {
    async function validator() {
        const ajv = new Ajv2020({ allErrors: true });
        ajv.addFormat('date-time', fullFormats['date-time']);
        ajv.addFormat('uri', fullFormats.uri);
        return ajv.compile(
            JSON.parse(
                await readFile(
                    join(
                        import.meta.dir,
                        '..',
                        'schemas',
                        'events',
                        'v0',
                        'workbench-event.schema.json'
                    ),
                    'utf8'
                )
            )
        );
    }

    const preview = (data: Record<string, unknown>) => ({
        protocol: 0,
        run_id: 'wb_test00000000000000000000',
        sequence: 1,
        timestamp: '2026-10-20T00:00:00.000Z',
        type: 'preview.available',
        runner: 'opencode',
        data,
    });

    test('accepts a local preview with a loopback URL and one without a URL', async () => {
        const validate = await validator();
        for (const data of [
            {
                name: 'demo',
                port: 5173,
                protocol: 'http',
                url: 'http://127.0.0.1:5173/',
            },
            { name: 'a'.repeat(40), port: 65_535, protocol: 'http' },
        ]) {
            expect({ data, valid: validate(preview(data)) }).toEqual({
                data,
                valid: true,
            });
        }
    });

    test('rejects missing fields, invalid names and ports, and other protocols', async () => {
        const validate = await validator();
        const valid = { name: 'demo', port: 5173, protocol: 'http' };
        for (const data of [
            { port: 5173, protocol: 'http' },
            { name: 'demo', protocol: 'http' },
            { name: 'demo', port: 5173 },
            { ...valid, name: 'Demo' },
            { ...valid, name: '-demo' },
            { ...valid, name: 'a'.repeat(41) },
            { ...valid, port: 80 },
            { ...valid, port: 65_536 },
            { ...valid, port: 5173.5 },
            { ...valid, protocol: 'tcp' },
            { ...valid, url: 'not a url' },
        ]) {
            expect({ data, valid: validate(preview(data)) }).toEqual({
                data,
                valid: false,
            });
        }
    });
});

describe('tool and file detail schema', () => {
    async function validator() {
        const ajv = new Ajv2020({ allErrors: true });
        ajv.addFormat('date-time', fullFormats['date-time']);
        ajv.addFormat('uri', fullFormats.uri);
        return ajv.compile(
            JSON.parse(
                await readFile(
                    join(
                        import.meta.dir,
                        '..',
                        'schemas',
                        'events',
                        'v0',
                        'workbench-event.schema.json'
                    ),
                    'utf8'
                )
            )
        );
    }

    const event = (type: string, data: Record<string, unknown>) => ({
        protocol: 0,
        run_id: 'wb_test00000000000000000000',
        sequence: 1,
        timestamp: '2026-10-20T00:00:00.000Z',
        type,
        runner: 'opencode',
        data,
    });

    test('accepts tool input, output, MCP identity, and a file patch', async () => {
        const validate = await validator();
        for (const sample of [
            event('tool.started', {
                id: 'call_1',
                name: 'docs_search',
                input: { query: 'events' },
                mcp: { server: 'docs', tool: 'search' },
            }),
            event('tool.completed', {
                id: 'call_1',
                name: 'bash',
                status: 'completed',
                input: { command: 'ls' },
                input_truncated: true,
                output: 'a\nb\n',
                output_truncated: true,
            }),
            event('file.changed', {
                path: '/workspace/a.txt',
                operation: 'edit',
                patch: '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
                additions: 1,
                deletions: 1,
                patch_truncated: true,
            }),
            event('file.changed', { path: '/workspace/logo.png', operation: 'write' }),
        ]) {
            expect({ sample, valid: validate(sample) }).toEqual({
                sample,
                valid: true,
            });
        }
    });

    test('rejects malformed details', async () => {
        const validate = await validator();
        for (const sample of [
            event('tool.started', { id: 'call_1', name: 'bash', input: 'ls' }),
            event('tool.completed', { id: 'call_1', name: 'bash', output: ['a'] }),
            event('tool.completed', {
                id: 'call_1',
                name: 'bash',
                output_truncated: false,
            }),
            event('tool.started', { id: 'call_1', name: 'x', mcp: { server: 'docs' } }),
            event('file.changed', { path: 'a', operation: 'edit', patch: '@@' }),
            event('file.changed', {
                path: 'a',
                operation: 'edit',
                patch: '@@',
                additions: -1,
                deletions: 0,
            }),
        ]) {
            expect({ sample, valid: validate(sample) }).toEqual({
                sample,
                valid: false,
            });
        }
    });
});
