import { describe, expect, test } from 'bun:test';

import type { ResolvedWorkbench } from '../src/types.js';
import { WorkbenchInspection } from '../src/workbench/index.js';

describe('Workbench view', () => {
    test('reports configuration and authorization state without exposing values', () => {
        const inspection = WorkbenchInspection.describe({
            workbench: fixtureWorkbench(),
            origin: {
                kind: 'saved',
                alias: 'lux-core',
                source: '/repo',
                selector: 'core',
                digest: 'sha256:fixture',
                added_at: '2026-08-18T00:00:00.000Z',
                package: '/home/packages/fixture/.workbenches/core',
            },
            environment: { LUX_TOKEN: 'do-not-print-this' },
        });

        expect(inspection.data).toMatchObject({
            spec: 0,
            name: 'lux-core',
            version: '0.1.0',
            model_routes: [
                {
                    provider: 'openrouter',
                    model: 'openai/gpt-5.6-terra',
                },
            ],
            runner_auth: {
                status: 'unchecked',
                connect_command: 'wb connect lux-core',
            },
            skills: ['lux-migrations'],
            tools: ['cargo', 'lux'],
            workspaces: [{ name: 'api', required: true, access: 'read-write' }],
            environment: [{ name: 'LUX_TOKEN', required: false, bound: true }],
            mcps: [{ name: 'lux', status: 'enabled', missing_env: [] }],
        });
        const output = inspection.render();
        expect(output).toContain('LUX_TOKEN · optional · bound');
        expect(output).toContain('lux · http · https://api.luxdb.dev/mcp · enabled');
        expect(output).toContain('api · required · read-write');
        expect(output).toContain('Runner auth  unchecked · wb connect lux-core');
        expect(output).not.toContain('do-not-print-this');
        expect(JSON.stringify(inspection)).not.toContain('do-not-print-this');
    });

    test('explains why an MCP is disabled', () => {
        const inspection = WorkbenchInspection.describe({
            workbench: fixtureWorkbench(),
            origin: { kind: 'local', source: '/repo', selector: 'core' },
            environment: {},
        });

        expect(inspection.data.mcps[0]).toMatchObject({
            status: 'disabled',
            missing_env: ['LUX_TOKEN'],
        });
        expect(inspection.render()).toContain('disabled (missing LUX_TOKEN)');
    });

    test('renders a local image build without losing its context', () => {
        const workbench = fixtureWorkbench();
        workbench.manifest.runtime = 'docker';
        workbench.manifest.image = {
            build: './Dockerfile.workbench',
            context: '../..',
        };
        const output = WorkbenchInspection.describe({
            workbench,
            origin: { kind: 'local', source: '/repo', selector: 'core' },
        }).render();
        expect(output).toContain(
            'Image        ./Dockerfile.workbench (build context ../..)'
        );
    });

    test('makes host Docker engine risk visible', () => {
        const workbench = fixtureWorkbench();
        workbench.manifest.runtime = 'docker';
        workbench.manifest.image = 'alpine:3.22';
        workbench.manifest.docker = { engine: { mode: 'host' } };
        const inspection = WorkbenchInspection.describe({
            workbench,
            origin: { kind: 'local', source: '/repo', selector: 'core' },
        });

        expect(inspection.data.docker_engine).toEqual({
            mode: 'host',
            authorization: 'explicit',
        });
        expect(inspection.render()).toContain('host · explicit authorization required');
    });

    test('keeps the human route summary compact while JSON retains every route', () => {
        const workbench = fixtureWorkbench();
        workbench.manifest = {
            ...workbench.manifest,
            spec: 0,
            model: {
                id: 'openai/gpt-5.6-terra',
                routes: [
                    { provider: 'openai' },
                    { provider: 'openrouter' },
                    { provider: 'azure' },
                    { provider: 'github-copilot' },
                ],
            },
        };
        const inspection = WorkbenchInspection.describe({
            workbench,
            origin: { kind: 'local', source: '/repo', selector: 'core' },
            authentication: {
                model: 'openai/gpt-5.6-terra',
                ready: true,
                authenticatedProviders: ['openai'],
                connections: [
                    {
                        provider: 'openai',
                        nativeProvider: 'openai',
                        nativeModel: 'gpt-5.6-terra',
                    },
                ],
                routes: [
                    {
                        provider: 'openai',
                        model: 'gpt-5.6-terra',
                        value: 'openai/gpt-5.6-terra',
                        authenticated: true,
                    },
                    {
                        provider: 'openrouter',
                        model: 'openai/gpt-5.6-terra',
                        value: 'openrouter/openai/gpt-5.6-terra',
                        authenticated: false,
                    },
                    {
                        provider: 'azure',
                        model: 'gpt-5.6-terra',
                        value: 'azure/gpt-5.6-terra',
                        authenticated: false,
                    },
                    {
                        provider: 'github-copilot',
                        model: 'gpt-5.6-terra',
                        value: 'github-copilot/gpt-5.6-terra',
                        authenticated: false,
                    },
                ],
                connectCommand: 'wb connect core',
            },
        });

        expect(inspection.data.model_routes).toHaveLength(4);
        expect(inspection.render()).toContain(
            'Routes       openai/gpt-5.6-terra (ready), 3 more allowed'
        );
    });
});

function fixtureWorkbench(): ResolvedWorkbench {
    return {
        manifestPath: '/repo/.workbenches/core/workbench.yml',
        packageDirectory: '/repo/.workbenches/core',
        repositoryDirectory: '/repo',
        instructionsPath: '/repo/.workbenches/core/instructions.md',
        skills: [
            {
                name: 'lux-migrations',
                directory: '/repo/.workbenches/core/skills/lux-migrations',
                manifestPath: '/repo/.workbenches/core/skills/lux-migrations/SKILL.md',
            },
        ],
        manifest: {
            spec: 0,
            version: '0.1.0',
            name: 'lux-core',
            description: 'Maintain Lux.',
            runner: 'opencode',
            model: {
                id: 'openai/gpt-5.6-terra',
                routes: [{ provider: 'openrouter' }],
            },
            instructions: './instructions.md',
            skills: ['./skills/lux-migrations'],
            tools: ['cargo', 'lux'],
            mcps: [
                {
                    name: 'lux',
                    transport: 'http',
                    url: 'https://api.luxdb.dev/mcp',
                    headers: { Authorization: 'Bearer $' + '{LUX_TOKEN}' },
                },
            ],
            env: { LUX_TOKEN: { required: false } },
            workspaces: {
                api: { required: true, access: 'read-write' },
            },
            runtime: 'local',
        },
    };
}
