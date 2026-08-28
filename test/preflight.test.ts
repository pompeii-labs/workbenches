import { describe, expect, test } from 'bun:test';
import type { ResolvedWorkbench } from '../src/types.js';
import { WorkbenchPreflight } from '../src/workbench/index.js';

describe('Workbench smoke preflight', () => {
    test('reports resolved executables and optional integrations without launching', () => {
        const result = new WorkbenchPreflight({
            environment: {},
            findExecutable: (name) => `/bin/${name}`,
        }).check(workbench());

        expect(result).toEqual({
            runner: { name: 'opencode', path: '/bin/opencode' },
            tools: [{ name: 'lux', path: '/bin/lux' }],
            enabledMcps: [],
            disabledMcps: ['lux'],
            optionalEnvironment: ['LUX_TOKEN'],
            workspaces: [],
        });
    });

    test('enables an MCP when its declared environment is present', () => {
        const result = new WorkbenchPreflight({
            environment: { LUX_TOKEN: 'bound' },
            findExecutable: (name) => `/bin/${name}`,
        }).check(workbench());
        expect(result.enabledMcps).toEqual(['lux']);
        expect(result.disabledMcps).toEqual([]);
    });

    test('checks the manifest runner without coupling generic preflight to an adapter', () => {
        const fixture = workbench();
        fixture.manifest.runner = 'codex';

        const result = new WorkbenchPreflight({
            environment: { LUX_TOKEN: 'bound' },
            findExecutable: (name) => `/bin/${name}`,
        }).check(fixture);

        expect(result.runner).toEqual({ name: 'codex', path: '/bin/codex' });
    });

    test('rejects unsupported execution contracts before executable checks', () => {
        const fixture = workbench();
        fixture.manifest.runtime = 'docker';
        let checked = false;
        expect(() =>
            new WorkbenchPreflight({
                findExecutable() {
                    checked = true;
                    return '/bin/tool';
                },
            }).check(fixture)
        ).toThrow('Unsupported runtime: docker');
        expect(checked).toBeFalse();
    });

    test('rejects required environment and undeclared MCP references', () => {
        const required = workbench();
        required.manifest.env.LUX_TOKEN = { required: true };
        expect(() =>
            new WorkbenchPreflight({
                environment: {},
                findExecutable: (name) => `/bin/${name}`,
            }).check(required)
        ).toThrow('Missing required environment variable: LUX_TOKEN');

        const undeclared = workbench();
        undeclared.manifest.env = {};
        expect(() =>
            new WorkbenchPreflight({
                environment: { LUX_TOKEN: 'bound' },
                findExecutable: (name) => `/bin/${name}`,
            }).check(undeclared)
        ).toThrow('references undeclared environment variable: LUX_TOKEN');
    });
});

function workbench(): ResolvedWorkbench {
    return {
        manifestPath: '/repo/.workbenches/core/workbench.yml',
        packageDirectory: '/repo/.workbenches/core',
        repositoryDirectory: '/repo',
        instructionsPath: '/repo/.workbenches/core/instructions.md',
        skills: [],
        manifest: {
            spec: 0,
            version: '0.1.0',
            name: 'lux-migrations',
            runner: 'opencode',
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            skills: [],
            tools: ['lux'],
            mcps: [
                {
                    name: 'lux',
                    transport: 'http',
                    url: 'https://api.luxdb.dev/mcp',
                    headers: { Authorization: 'Bearer $' + '{LUX_TOKEN}' },
                },
            ],
            env: { LUX_TOKEN: { required: false } },
            runtime: 'local',
        },
    };
}
