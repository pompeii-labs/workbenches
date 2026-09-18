import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunDispatcher, RunStore } from '../src/runs/index.js';
import { SessionLifecycle, SessionStore } from '../src/sessions/index.js';
import { SessionSupervision } from '../src/sessions/supervision.js';
import type { ResolvedWorkbenchReference } from '../src/workbench/index.js';

const homes: string[] = [];

afterEach(async () => {
    await Promise.all(
        homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
    );
});

describe('Workbench session lifecycle', () => {
    test('gives foreground and detached executions stable session records', async () => {
        const home = await temporaryHome();
        const dispatcher = new RunDispatcher(home);
        const sessions = new SessionStore(home);

        for (const mode of ['foreground', 'detached'] as const) {
            const run = await dispatcher.prepare({
                resolved: await fixtureReference(home),
                mode,
                task: 'inspect',
            });
            expect(run.session_id).toBe(run.id);
            expect(await sessions.read(run.id)).toMatchObject({
                id: run.id,
                name: 'inspect',
                latest_run_id: run.id,
            });
        }
    });

    test('resolves a stable session and any linked run to the latest execution', async () => {
        const home = await temporaryHome();
        const dispatcher = new RunDispatcher(home);
        const sessions = new SessionStore(home);
        const lifecycle = new SessionLifecycle(home);
        const resolved = await fixtureReference(home);
        const first = await dispatcher.prepare({ resolved, mode: 'interactive' });
        const resumable = await sessions.update(first.id, {
            native_session_id: 'native-session',
        });
        const resumed = await dispatcher.prepare({
            resolved,
            mode: 'interactive',
            session: resumable,
        });

        expect(await lifecycle.resolve(first.id)).toMatchObject({
            id: first.id,
            resumable: true,
            run: { id: resumed.id },
        });
        expect(await lifecycle.resolve(resumed.id)).toMatchObject({
            id: first.id,
            resumable: true,
            run: { id: resumed.id },
        });
    });

    test('observation keeps linked runs exact without changing control aliases', async () => {
        const home = await temporaryHome();
        const dispatcher = new RunDispatcher(home);
        const sessions = new SessionStore(home);
        const supervision = new SessionSupervision(home);
        const resolved = await fixtureReference(home);
        const first = await dispatcher.prepare({ resolved, mode: 'interactive' });
        const second = await dispatcher.prepare({
            resolved,
            mode: 'interactive',
            session: await sessions.read(first.id),
        });
        const third = await dispatcher.prepare({
            resolved,
            mode: 'interactive',
            session: await sessions.read(first.id),
        });
        expect((await supervision.resolve(first.id)).id).toBe(third.id);
        expect((await supervision.resolve(second.id)).id).toBe(second.id);
        expect((await supervision.resolve(first.id, { exactRun: true })).id).toBe(
            first.id
        );
        expect((await supervision.resolve(second.id, { exactRun: true })).id).toBe(
            second.id
        );
        expect((await new SessionLifecycle(home).resolve(second.id)).run.id).toBe(
            third.id
        );
        const missing = RunStore.createId();
        await expect(supervision.resolve(missing, { exactRun: true })).rejects.toThrow(
            'run does not exist'
        );
        await sessions.update(first.id, { latest_run_id: missing });
        await expect(supervision.resolve(first.id)).rejects.toThrow(
            'run does not exist'
        );
        expect((await supervision.resolve(second.id)).id).toBe(second.id);
    });

    test('locks a resumed session to its original runtime', async () => {
        const home = await temporaryHome();
        const dispatcher = new RunDispatcher(home);
        const first = await dispatcher.prepare({
            resolved: await fixtureReference(home),
            mode: 'interactive',
        });
        const session = await new SessionStore(home).read(first.id);
        const changed = await fixtureReference(home);
        changed.workbench.manifest.runtime = 'docker';

        await expect(
            dispatcher.prepare({
                resolved: changed,
                mode: 'interactive',
                session,
            })
        ).rejects.toThrow('does not match the resolved Workbench package');
    });

    test('lists active and resumable sessions while retaining legacy history', async () => {
        const home = await temporaryHome();
        const dispatcher = new RunDispatcher(home);
        const runs = new RunStore(home);
        const sessions = new SessionStore(home);
        const lifecycle = new SessionLifecycle(home);
        const resolved = await fixtureReference(home);

        const completed = await dispatcher.prepare({
            resolved,
            mode: 'detached',
            task: 'complete',
        });
        await runs.update(completed.id, { status: 'completed' });

        const active = await dispatcher.prepare({
            resolved,
            mode: 'foreground',
            task: 'active',
        });

        const resumable = await dispatcher.prepare({
            resolved,
            mode: 'interactive',
        });
        await sessions.update(resumable.id, {
            native_session_id: 'native-session',
        });
        await runs.update(resumable.id, { status: 'completed' });

        const legacy = await runs.create({
            metadata: {
                workbench: 'legacy',
                workbench_version: '0.1.0',
                runner: 'opencode',
                model: 'openai/gpt-5.6-terra',
                workspace: '/workspace',
                mode: 'detached',
            },
            request: {
                workbench_path: '/repo/.workbenches/core',
                workspace: '/workspace',
                task: 'legacy',
            },
        });
        await runs.update(legacy.id, { status: 'completed' });

        expect((await lifecycle.list()).map((entry) => entry.id).toSorted()).toEqual(
            [active.id, resumable.id].toSorted()
        );
        expect(
            (await lifecycle.list({ all: true })).map((entry) => entry.id)
        ).toContainAllValues([completed.id, active.id, resumable.id, legacy.id]);
        expect(await lifecycle.resolve(legacy.id)).toMatchObject({
            id: legacy.id,
            resumable: false,
            run: { id: legacy.id },
        });
        expect((await new SessionSupervision(home).resolve(legacy.id)).id).toBe(
            legacy.id
        );
    });
});

async function temporaryHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'workbench-session-lifecycle-'));
    homes.push(home);
    return home;
}

async function fixtureReference(home: string): Promise<ResolvedWorkbenchReference> {
    const repository = join(home, 'repository');
    const packageDirectory = join(repository, '.workbenches', 'core');
    await mkdir(packageDirectory, { recursive: true });
    await Promise.all([
        writeFile(
            join(packageDirectory, 'workbench.yml'),
            [
                'spec: 0',
                'version: 0.1.0',
                'name: fixture-core',
                'runner: opencode',
                'model:',
                '  id: openai/gpt-5.6-terra',
                'instructions: ./instructions.md',
                'runtime: local',
                'skills: []',
                'tools: []',
                'mcps: []',
                'env: {}',
                '',
            ].join('\n')
        ),
        writeFile(join(packageDirectory, 'instructions.md'), '# Fixture\n'),
    ]);
    return {
        workspaceDirectory: '/workspace',
        cleanup: async () => {},
        workbench: {
            repositoryDirectory: repository,
            packageDirectory,
            manifestPath: join(packageDirectory, 'workbench.yml'),
            instructionsPath: join(packageDirectory, 'instructions.md'),
            manifest: {
                spec: 0,
                name: 'fixture-core',
                version: '0.1.0',
                runner: 'opencode',
                model: { id: 'openai/gpt-5.6-terra' },
                runtime: 'local',
                instructions: './instructions.md',
                skills: [],
                tools: [],
                mcps: [],
                env: {},
            },
            skills: [],
        },
    };
}
