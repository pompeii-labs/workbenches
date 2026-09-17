import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { E2BPathPlan } from '../src/runtimes/e2b/paths.js';
import type { ResolvedWorkbench } from '../src/types.js';
import { WorkbenchEnvironment } from '../src/workbench/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('Workbench environment overrides', () => {
    const environment = new WorkbenchEnvironment();

    test('collects repeatable assignments and splits only the first equals sign', () => {
        expect(
            environment.parse([
                '--env',
                'FIRST=one',
                '--env=SECOND=two=three',
                '--env',
                'FIRST=last',
                '--',
                '--env',
                'IGNORED=value',
            ])
        ).toEqual(
            new Map([
                ['FIRST', 'last'],
                ['SECOND', 'two=three'],
            ])
        );
    });

    test('rejects missing and malformed explicit assignments without echoing values', () => {
        expect(() => environment.parse(['--env'])).toThrow('--env requires NAME=value');
        expect(() => environment.parse(['--env', 'lowercase=secret'])).toThrow(
            '--env requires an uppercase NAME=value assignment'
        );
    });

    test('loads dotenv syntax and applies explicit, file, then inherited precedence', async () => {
        const directory = await temporaryDirectory();
        await writeFile(
            join(directory, '.env.test'),
            'export FIRST="from file"\nSECOND=file value\nUNDECLARED=ignored\n'
        );
        const overrides = await environment.load({
            envFile: '.env.test',
            cwd: directory,
            rawArgs: ['--env', 'SECOND=explicit'],
        });
        const bound = environment.bind(fixture(), overrides, {
            FIRST: 'inherited',
            SECOND: 'inherited',
            PATH: '/bin',
        });

        expect(bound).toEqual({
            FIRST: 'from file',
            SECOND: 'explicit',
            PATH: '/bin',
        });
        expect(bound.UNDECLARED).toBeUndefined();
    });

    test('rejects explicit names not supported by the Workbench', () => {
        expect(() =>
            environment.bind(
                fixture(),
                {
                    file: {},
                    explicit: new Map([['TYPO_TOKEN', 'secret']]),
                },
                {}
            )
        ).toThrow('Environment override is not supported by fixture: TYPO_TOKEN');
    });

    test('binds E2B provisioning overrides on the host but never forwards them into the sandbox', () => {
        const workbench = fixture();
        workbench.manifest.runtime = 'e2b';
        for (const overrides of [
            {
                file: { E2B_API_KEY: 'fixture-host-only-key' },
                explicit: new Map<string, string>(),
            },
            { file: {}, explicit: new Map([['E2B_API_KEY', 'fixture-host-only-key']]) },
        ]) {
            const bound = environment.bind(workbench, overrides, {});
            expect(bound.E2B_API_KEY).toBe('fixture-host-only-key');
            const paths = new E2BPathPlan({
                workbench,
                workspaceDirectory: '/repo',
                environment: bound,
                assets: [],
            });
            expect(paths.environment()).not.toHaveProperty('E2B_API_KEY');
            expect(JSON.stringify(paths.environment())).not.toContain(
                'fixture-host-only-key'
            );
        }
        expect(() =>
            environment.bind(
                fixture(),
                {
                    file: {},
                    explicit: new Map([['E2B_API_KEY', 'fixture-host-only-key']]),
                },
                {}
            )
        ).toThrow('Environment override is not supported');
    });

    test('accepts provider credentials for allowed model routes', () => {
        const bound = environment.bind(
            fixture(),
            {
                file: {
                    OPENAI_API_KEY: 'from-file',
                    ANTHROPIC_API_KEY: 'not-an-allowed-route',
                },
                explicit: new Map([['OPENAI_API_KEY', 'explicit']]),
            },
            {}
        );

        expect(bound).toEqual({ OPENAI_API_KEY: 'explicit' });
        expect(bound.ANTHROPIC_API_KEY).toBeUndefined();
    });

    test('fails cleanly for missing and oversized environment files', async () => {
        const directory = await temporaryDirectory();
        await expect(
            environment.load({ envFile: '.env.missing', cwd: directory })
        ).rejects.toThrow('Environment file is unavailable');

        await writeFile(join(directory, '.env.large'), 'A'.repeat(1024 * 1024 + 1));
        await expect(
            environment.load({ envFile: '.env.large', cwd: directory })
        ).rejects.toThrow('Environment file exceeds 1 MiB');
    });
});

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-environment-test-'));
    temporaryDirectories.push(directory);
    return directory;
}

function fixture(): ResolvedWorkbench {
    return {
        manifestPath: '/repo/.workbenches/core/workbench.yml',
        packageDirectory: '/repo/.workbenches/core',
        repositoryDirectory: '/repo',
        instructionsPath: '/repo/.workbenches/core/instructions.md',
        skills: [],
        manifest: {
            spec: 0,
            version: '0.1.0',
            name: 'fixture',
            runner: 'opencode',
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {
                FIRST: { required: true },
                SECOND: { required: false },
            },
            runtime: 'local',
        },
    };
}
