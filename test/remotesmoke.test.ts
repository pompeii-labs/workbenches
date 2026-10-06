import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand } from 'citty';

import { smokeCommand } from '../src/commands/smoke.js';
import { activateModelCatalogFixture } from './model-catalog-fixture.js';

const temporaryDirectories: string[] = [];
const originalFetch = globalThis.fetch;
const originalWhich = Bun.which;
const originalWrite = process.stdout.write;
const originalEnvironment = {
    PATH: process.env.PATH,
    WORKBENCH_HOME: process.env.WORKBENCH_HOME,
};
let written = '';

beforeEach(() => {
    written = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
        written += String(chunk);
        return true;
    }) as typeof process.stdout.write;
});

afterEach(async () => {
    globalThis.fetch = originalFetch;
    Bun.which = originalWhich;
    process.stdout.write = originalWrite;
    process.exitCode = 0;
    for (const [name, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('remote smoke', () => {
    test('smokes a remote package with skills without treating it as a local path', async () => {
        const home = await temporaryDirectory('workbench-remote-smoke-home-');
        const bin = await temporaryDirectory('workbench-remote-smoke-bin-');
        await writeFile(join(bin, 'opencode'), '#!/bin/sh\necho 1.0.0\n');
        await chmod(join(bin, 'opencode'), 0o755);
        process.env.PATH = `${bin}:${process.env.PATH}`;
        process.env.WORKBENCH_HOME = home;
        // Bun.which reads the PATH captured at process start, so an in-process
        // change to process.env.PATH is invisible to it unless passed explicitly.
        Bun.which = ((name: string) =>
            originalWhich(name, { PATH: process.env.PATH ?? '' })) as typeof Bun.which;
        activateModelCatalogFixture();
        globalThis.fetch = fakeGitHub() as typeof fetch;

        await runCommand(smokeCommand, {
            rawArgs: ['lux-db/lux#migrations', '--json'],
        });

        const report = JSON.parse(written.trim());
        expect(report.error).toBeUndefined();
        expect(report.workbench).toBe('lux-migrations');
        expect(['ready', 'needs-auth']).toContain(report.status);
        if (report.authentication.connect_command) {
            expect(report.authentication.connect_command).toBe(
                'wb connect lux-db/lux#migrations --runtime local'
            );
        }
        expect(
            (await readdir(tmpdir())).filter((name) => name.startsWith('wb-smoke-'))
        ).toEqual([]);
    });
});

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

function fakeGitHub() {
    const manifest = [
        'spec: 0',
        'version: 0.1.0',
        'name: lux-migrations',
        'description: Safely manage Lux migrations.',
        'runner: opencode',
        'model:',
        '  id: openai/gpt-5.6-terra',
        'instructions: ./instructions.md',
        'skills:',
        '  - ./skills/lux-migrations',
        'runtime: local',
        '',
    ].join('\n');
    const skill = [
        '---',
        'name: lux-migrations',
        'description: Operate Lux migrations safely.',
        '---',
        '',
        '# Lux migrations',
        '',
    ].join('\n');
    const blobs: Record<string, string> = {
        'manifest-sha': manifest,
        'instructions-sha': '# Migrations\n',
        'skill-sha': skill,
    };
    const entry = (path: string, sha: string) => ({
        path,
        mode: '100644',
        type: 'blob',
        sha,
        size: Buffer.byteLength(blobs[sha] ?? ''),
    });
    const tree = [
        entry('.workbenches/migrations/workbench.yml', 'manifest-sha'),
        entry('.workbenches/migrations/instructions.md', 'instructions-sha'),
        entry('.workbenches/migrations/skills/lux-migrations/SKILL.md', 'skill-sha'),
    ];
    return async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/repos/lux-db/lux')) {
            return Response.json({ default_branch: 'main' });
        }
        if (url.endsWith('/commits/main')) return Response.json({ sha: 'commit-sha' });
        if (url.includes('/git/trees/commit-sha')) {
            return Response.json({ tree, truncated: false });
        }
        const content = blobs[url.split('/').at(-1) ?? ''];
        if (content === undefined) return Response.json({}, { status: 404 });
        return Response.json({
            encoding: 'base64',
            content: Buffer.from(content).toString('base64'),
            size: Buffer.byteLength(content),
        });
    };
}
