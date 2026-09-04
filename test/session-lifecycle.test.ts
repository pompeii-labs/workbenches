import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunDispatcher, RunStore } from '../src/runs/index.js';
import { SessionLifecycle, SessionStore } from '../src/sessions/index.js';
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
                resolved: fixtureReference(),
                mode,
                task: 'inspect',
            });
            expect(run.session_id).toBe(run.id);
            expect(await sessions.read(run.id)).toMatchObject({
                id: run.id,
                latest_run_id: run.id,
            });
        }
    });

    test('resolves a stable session and any linked run to the latest execution', async () => {
        const home = await temporaryHome();
        const dispatcher = new RunDispatcher(home);
        const sessions = new SessionStore(home);
        const lifecycle = new SessionLifecycle(home);
        const resolved = fixtureReference();
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

    test('lists active and resumable sessions while retaining legacy history', async () => {
        const home = await temporaryHome();
        const dispatcher = new RunDispatcher(home);
        const runs = new RunStore(home);
        const sessions = new SessionStore(home);
        const lifecycle = new SessionLifecycle(home);
        const resolved = fixtureReference();

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
    });
});

async function temporaryHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'workbench-session-lifecycle-'));
    homes.push(home);
    return home;
}

function fixtureReference(): ResolvedWorkbenchReference {
    return {
        workspaceDirectory: '/workspace',
        cleanup: async () => {},
        workbench: {
            repositoryDirectory: '/repo',
            packageDirectory: '/repo/.workbenches/core',
            manifestPath: '/repo/.workbenches/core/workbench.yml',
            instructionsPath: '/repo/.workbenches/core/instructions.md',
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
