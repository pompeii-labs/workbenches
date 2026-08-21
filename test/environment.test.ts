import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    bindWorkbenchEnvironment,
    loadEnvironmentOverrides,
    parseEnvironmentAssignments,
} from '../src/environment.js';
import type { ResolvedWorkbench } from '../src/types.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('Workbench environment overrides', () => {
    test('collects repeatable assignments and splits only the first equals sign', () => {
        expect(
            parseEnvironmentAssignments([
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
        expect(() => parseEnvironmentAssignments(['--env'])).toThrow(
            '--env requires NAME=value'
        );
        expect(() =>
            parseEnvironmentAssignments(['--env', 'lowercase=secret'])
        ).toThrow('--env requires an uppercase NAME=value assignment');
    });

    test('loads dotenv syntax and applies explicit, file, then inherited precedence', async () => {
        const directory = await temporaryDirectory();
        await writeFile(
            join(directory, '.env.test'),
            'export FIRST="from file"\nSECOND=file value\nUNDECLARED=ignored\n'
        );
        const overrides = await loadEnvironmentOverrides({
            envFile: '.env.test',
            cwd: directory,
            rawArgs: ['--env', 'SECOND=explicit'],
        });
        const environment = bindWorkbenchEnvironment(fixture(), overrides, {
            FIRST: 'inherited',
            SECOND: 'inherited',
            PATH: '/bin',
        });

        expect(environment).toEqual({
            FIRST: 'from file',
            SECOND: 'explicit',
            PATH: '/bin',
        });
        expect(environment.UNDECLARED).toBeUndefined();
    });

    test('rejects explicit names not declared by the Workbench', () => {
        expect(() =>
            bindWorkbenchEnvironment(
                fixture(),
                {
                    file: {},
                    explicit: new Map([['TYPO_TOKEN', 'secret']]),
                },
                {}
            )
        ).toThrow('Environment override is not declared by fixture: TYPO_TOKEN');
    });

    test('fails cleanly for missing and oversized environment files', async () => {
        const directory = await temporaryDirectory();
        await expect(
            loadEnvironmentOverrides({ envFile: '.env.missing', cwd: directory })
        ).rejects.toThrow('Environment file is unavailable');

        await writeFile(join(directory, '.env.large'), 'A'.repeat(1024 * 1024 + 1));
        await expect(
            loadEnvironmentOverrides({ envFile: '.env.large', cwd: directory })
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
            model: 'openrouter/openai/gpt-5.6-terra',
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
