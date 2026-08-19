import { describe, expect, test } from 'bun:test';

import type { ResolvedWorkbench } from '../src/types.js';
import { describeWorkbench, renderWorkbenchView } from '../src/view.js';

describe('Workbench view', () => {
    test('reports configuration and authorization state without exposing values', () => {
        const view = describeWorkbench({
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

        expect(view).toMatchObject({
            spec: 0,
            name: 'lux-core',
            version: '0.1.0',
            skills: ['lux-migrations'],
            tools: ['cargo', 'lux'],
            environment: [{ name: 'LUX_TOKEN', required: false, bound: true }],
            mcps: [{ name: 'lux', status: 'enabled', missing_env: [] }],
        });
        const output = renderWorkbenchView(view);
        expect(output).toContain('LUX_TOKEN · optional · bound');
        expect(output).toContain('lux · http · https://api.luxdb.dev/mcp · enabled');
        expect(output).not.toContain('do-not-print-this');
        expect(JSON.stringify(view)).not.toContain('do-not-print-this');
    });

    test('explains why an MCP is disabled', () => {
        const view = describeWorkbench({
            workbench: fixtureWorkbench(),
            origin: { kind: 'local', source: '/repo', selector: 'core' },
            environment: {},
        });

        expect(view.mcps[0]).toMatchObject({
            status: 'disabled',
            missing_env: ['LUX_TOKEN'],
        });
        expect(renderWorkbenchView(view)).toContain('disabled (missing LUX_TOKEN)');
    });

    test('renders a local image build without losing its context', () => {
        const workbench = fixtureWorkbench();
        workbench.manifest.runtime = 'docker';
        workbench.manifest.image = {
            build: './Dockerfile.workbench',
            context: '../..',
        };
        const output = renderWorkbenchView(
            describeWorkbench({
                workbench,
                origin: { kind: 'local', source: '/repo', selector: 'core' },
            })
        );
        expect(output).toContain(
            'Image        ./Dockerfile.workbench (build context ../..)'
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
            model: 'openrouter/openai/gpt-5.6-terra',
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
            runtime: 'local',
        },
    };
}
