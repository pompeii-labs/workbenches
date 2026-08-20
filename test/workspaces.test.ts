import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ResolvedWorkbench } from '../src/types.js';
import {
    bindWorkbenchWorkspaces,
    parseWorkspaceAssignments,
    validateWorkbenchWorkspaceBindings,
    workspaceEnvironment,
} from '../src/workspaces.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('named workspace bindings', () => {
    test('parses repeatable bindings without consuming arguments after --', () => {
        expect(
            parseWorkspaceAssignments([
                '--workspace',
                'api=../api',
                '--workspace=schemas=../shared schemas',
                '--',
                '--workspace',
                'ignored=../ignored',
            ])
        ).toEqual(
            new Map([
                ['api', '../api'],
                ['schemas', '../shared schemas'],
            ])
        );
    });

    test('rejects malformed and duplicate assignments', () => {
        expect(() => parseWorkspaceAssignments(['--workspace'])).toThrow(
            '--workspace requires NAME=PATH'
        );
        expect(() => parseWorkspaceAssignments(['--workspace', 'Bad=../api'])).toThrow(
            '--workspace requires a lowercase NAME=PATH assignment'
        );
        expect(() =>
            parseWorkspaceAssignments([
                '--workspace',
                'api=../one',
                '--workspace',
                'api=../two',
            ])
        ).toThrow('Duplicate workspace binding: api');
    });

    test('resolves declared bindings and exports runtime path variables', async () => {
        const root = await temporaryDirectory();
        const api = join(root, 'api');
        const schemas = join(root, 'schemas');
        await mkdir(api);
        await mkdir(schemas);
        const bindings = await bindWorkbenchWorkspaces({
            workbench: fixture(),
            cwd: root,
            rawArgs: ['--workspace', 'api=./api', '--workspace=schemas=./schemas'],
        });

        expect(bindings).toEqual([
            { name: 'api', path: await realpath(api), access: 'read-write' },
            { name: 'schemas', path: await realpath(schemas), access: 'read-only' },
        ]);
        expect(
            workspaceEnvironment(
                bindings,
                (path) => `/mapped/${path.split('/').at(-1)}`
            )
        ).toEqual({
            WORKBENCH_WORKSPACE_API: '/mapped/api',
            WORKBENCH_WORKSPACE_SCHEMAS: '/mapped/schemas',
        });
    });

    test('rejects missing, undeclared, and unavailable bindings', async () => {
        const root = await temporaryDirectory();
        const workbench = fixture();
        await expect(bindWorkbenchWorkspaces({ workbench, cwd: root })).rejects.toThrow(
            'Missing required workspace binding: api'
        );
        await expect(
            bindWorkbenchWorkspaces({
                workbench,
                cwd: root,
                rawArgs: ['--workspace', 'other=.'],
            })
        ).rejects.toThrow('Workspace binding is not declared by fixture: other');
        await expect(
            bindWorkbenchWorkspaces({
                workbench,
                cwd: root,
                rawArgs: ['--workspace', 'api=./missing'],
            })
        ).rejects.toThrow('Workspace directory is unavailable: api');
    });

    test('rejects two names that resolve to the same directory', async () => {
        const root = await temporaryDirectory();
        const workbench = fixture();
        await expect(
            bindWorkbenchWorkspaces({
                workbench,
                cwd: root,
                rawArgs: ['--workspace', 'api=.', '--workspace', 'schemas=.'],
            })
        ).rejects.toThrow(
            'Workspace bindings must resolve to distinct directories: api, schemas'
        );
    });

    test('revalidates structured bindings at the engine boundary', async () => {
        const root = await temporaryDirectory();
        const api = join(root, 'api');
        await mkdir(api);
        const path = await realpath(api);
        const workbench = fixture();

        await expect(
            validateWorkbenchWorkspaceBindings(workbench, [
                { name: 'api', path, access: 'read-write' },
            ])
        ).resolves.toBeUndefined();
        await expect(
            validateWorkbenchWorkspaceBindings(workbench, [
                { name: 'api', path, access: 'read-only' },
            ])
        ).rejects.toThrow('Workspace binding access does not match manifest: api');
        await expect(
            validateWorkbenchWorkspaceBindings(workbench, [
                { name: 'other', path, access: 'read-write' },
            ])
        ).rejects.toThrow('Workspace binding is not declared by fixture: other');
    });
});

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-workspaces-test-'));
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
            env: {},
            workspaces: {
                api: { required: true, access: 'read-write' },
                schemas: { required: false, access: 'read-only' },
            },
            runtime: 'local',
        },
    };
}
