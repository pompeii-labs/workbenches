import { describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OutcomeStore } from '../../src/outcomes/store.js';
import { RepositoryRetention } from '../../src/repositories/retention.js';
import { RepositoryWorkspace } from '../../src/repositories/workspace.js';
import { capture, checkoutFixture, fixtureIdentity, saveRun } from './fixture.js';

describe('repository continuation retention', () => {
    test('restores saved remote edits before the continuation baseline, exactly once', async () => {
        const fixture = await checkoutFixture();
        const selected = fixture.binding;
        const workspace = new RepositoryWorkspace(
            fixture.home,
            selected,
            { GH_TOKEN: 'fixture' },
            fixture.git,
            fixtureIdentity
        );
        await workspace.prepare();
        const outcome = await capture(
            fixture.home,
            workspace.directory,
            selected.session_id,
            () => writeFile(join(workspace.directory, 'original.txt'), 'remote edit')
        );
        await saveRun(fixture.home, selected, selected.session_id, outcome);
        await writeFile(join(workspace.directory, 'original.txt'), 'original\n');
        const runId = 'wb_2234567890abcdefghij';
        await saveRun(fixture.home, selected, runId, undefined, selected.session_id);
        await new RepositoryRetention(fixture.home, selected).restore(
            runId,
            workspace.directory
        );
        expect(await readFile(join(workspace.directory, 'original.txt'), 'utf8')).toBe(
            'remote edit'
        );
        const store = new OutcomeStore(fixture.home);
        expect((await store.receipt(outcome.id)).state).toBe('applied');
        await store.close();
        await new RepositoryRetention(fixture.home, selected).restore(
            runId,
            workspace.directory
        );
        expect(await readFile(join(workspace.directory, 'original.txt'), 'utf8')).toBe(
            'remote edit'
        );
    });

    test('refuses a conflicting recovery instead of replacing unsaved session edits', async () => {
        const fixture = await checkoutFixture();
        const selected = fixture.binding;
        const workspace = new RepositoryWorkspace(
            fixture.home,
            selected,
            { GH_TOKEN: 'fixture' },
            fixture.git,
            fixtureIdentity
        );
        await workspace.prepare();
        const outcome = await capture(
            fixture.home,
            workspace.directory,
            selected.session_id,
            () => writeFile(join(workspace.directory, 'original.txt'), 'remote edit')
        );
        await saveRun(fixture.home, selected, selected.session_id, outcome);
        await writeFile(join(workspace.directory, 'original.txt'), 'unsaved edit');
        const runId = 'wb_2234567890abcdefghij';
        await saveRun(fixture.home, selected, runId, undefined, selected.session_id);
        await expect(
            new RepositoryRetention(fixture.home, selected).restore(
                runId,
                workspace.directory
            )
        ).rejects.toThrow('conflict');
        expect(await readFile(join(workspace.directory, 'original.txt'), 'utf8')).toBe(
            'unsaved edit'
        );
    });
});
