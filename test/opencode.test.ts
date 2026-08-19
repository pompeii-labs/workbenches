import { describe, expect, test } from 'bun:test';

import { buildOpenCodeInvocation, publicInvocation } from '../src/opencode.js';
import type { ResolvedWorkbench, WorkbenchManifest } from '../src/types.js';

describe('OpenCode adapter translation', () => {
    test('rejects unsupported runners, runtimes, and local images', () => {
        expect(() =>
            buildOpenCodeInvocation(workbench({ runner: 'codex' }), 'task')
        ).toThrow('Unsupported runner: codex');
        expect(() =>
            buildOpenCodeInvocation(workbench({ runtime: 'docker' }), 'task')
        ).toThrow('Unsupported runtime: docker');
        expect(() =>
            buildOpenCodeInvocation(workbench({ image: 'example/image' }), 'task')
        ).toThrow('image is not supported with the local runtime');
    });

    test('rejects empty tasks before launch', () => {
        expect(() => buildOpenCodeInvocation(workbench(), '   ')).toThrow(
            'task must not be empty'
        );
    });

    test('requires staged native skill discovery', () => {
        expect(() => buildOpenCodeInvocation(workbench({}, true), 'task', {})).toThrow(
            'OpenCode skills require a staged config directory'
        );
        expect(
            buildOpenCodeInvocation(
                workbench({}, true),
                'task',
                {},
                '/tmp/opencode-config'
            ).env.OPENCODE_CONFIG_DIR
        ).toBe('/tmp/opencode-config');
    });

    test('checks required environment before constructing a request', () => {
        const fixture = workbench({ env: { REQUIRED_TOKEN: { required: true } } });
        expect(() => buildOpenCodeInvocation(fixture, 'task', {})).toThrow(
            'Missing required environment variable: REQUIRED_TOKEN'
        );
    });

    test('omits an MCP whose optional environment is absent', () => {
        const invocation = buildOpenCodeInvocation(mcpWorkbench(), 'task', {});
        expect(publicInvocation(invocation).opencode_config).not.toHaveProperty('mcp');
    });

    test('translates MCP environment references without serializing secrets', () => {
        const invocation = buildOpenCodeInvocation(mcpWorkbench(), 'task', {
            LUX_TOKEN: 'do-not-serialize-me',
        });
        const visible = publicInvocation(invocation);

        expect(visible.opencode_config).toMatchObject({
            mcp: {
                lux: {
                    type: 'remote',
                    enabled: true,
                    url: 'https://api.luxdb.dev/mcp',
                    headers: { Authorization: 'Bearer {env:LUX_TOKEN}' },
                },
            },
        });
        expect(JSON.stringify(visible)).not.toContain('do-not-serialize-me');
    });

    test('rejects MCP references not declared at root', () => {
        const fixture = mcpWorkbench();
        fixture.manifest.env = {};
        expect(() =>
            buildOpenCodeInvocation(fixture, 'task', { LUX_TOKEN: 'token' })
        ).toThrow('MCP lux references undeclared environment variable: LUX_TOKEN');
    });

    test('keeps instructions, model, cwd, and user task in separate channels', () => {
        const invocation = buildOpenCodeInvocation(workbench(), '  do work  ', {
            PATH: '/bin',
        });
        const visible = publicInvocation(invocation);

        expect(visible.cwd).toBe('/repo');
        expect(visible.opencode_config).toMatchObject({
            model: 'openrouter/openai/gpt-5.6-luna',
            instructions: ['.workbenches/core/instructions.md'],
        });
        expect(visible.command.at(-1)).toBe('do work');
        expect(JSON.stringify(visible.opencode_config)).not.toContain('do work');
        expect(visible.command).not.toContain('/repo/.workbenches/core/workbench.yml');
    });

    test('isolates project config and disables OpenCode sharing and updates', () => {
        const invocation = buildOpenCodeInvocation(workbench(), 'task', {});
        const visible = publicInvocation(invocation);

        expect(invocation.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('true');
        expect(visible.opencode_config).toMatchObject({
            autoupdate: false,
            share: 'disabled',
        });
        expect(visible.command).toContain('--pure');
        expect(visible.command).toContain('--format');
        expect(visible.command).toContain('json');
    });
});

function workbench(
    overrides: Partial<WorkbenchManifest> = {},
    withSkill = false
): ResolvedWorkbench {
    const manifest: WorkbenchManifest = {
        spec: 0,
        version: '0.1.0',
        name: 'fixture-core',
        runner: 'opencode',
        model: 'openrouter/openai/gpt-5.6-luna',
        instructions: './instructions.md',
        skills: withSkill ? ['./skills/migrations'] : [],
        tools: [],
        mcps: [],
        env: {},
        runtime: 'local',
        ...overrides,
    };
    return {
        manifestPath: '/repo/.workbenches/core/workbench.yml',
        packageDirectory: '/repo/.workbenches/core',
        repositoryDirectory: '/repo',
        instructionsPath: '/repo/.workbenches/core/instructions.md',
        skills: withSkill
            ? [
                  {
                      name: 'migrations',
                      directory: '/repo/.workbenches/core/skills/migrations',
                      manifestPath:
                          '/repo/.workbenches/core/skills/migrations/SKILL.md',
                  },
              ]
            : [],
        manifest,
    };
}

function mcpWorkbench() {
    return workbench({
        env: { LUX_TOKEN: { required: false } },
        mcps: [
            {
                name: 'lux',
                transport: 'http',
                url: 'https://api.luxdb.dev/mcp',
                headers: { Authorization: 'Bearer $' + '{LUX_TOKEN}' },
            },
        ],
    });
}
