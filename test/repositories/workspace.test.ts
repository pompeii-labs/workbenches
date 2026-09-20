import { describe, expect, test } from 'bun:test';
import {
    appendFile,
    lstat,
    mkdir,
    readdir,
    readFile,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { RepositoryWorkspace } from '../../src/repositories/workspace.js';
import { checkoutFixture, fixtureIdentity, git } from './fixture.js';

describe('engine-owned repository checkout', () => {
    test('checks out the exact selected commit without persisting authentication', async () => {
        const fixture = await checkoutFixture();
        const workspace = new RepositoryWorkspace(
            fixture.home,
            fixture.binding,
            { GH_TOKEN: 'fixture-credential' },
            fixture.git,
            fixtureIdentity
        );
        await workspace.prepare();
        expect(await readFile(join(workspace.directory, 'original.txt'), 'utf8')).toBe(
            'original\n'
        );
        expect(
            await readFile(join(workspace.directory, '.git/config'), 'utf8')
        ).not.toContain('fixture-credential');
        expect(await git(workspace.directory, ['config', 'user.name'])).toBe('example');
        expect(await git(workspace.directory, ['config', 'user.email'])).toBe(
            '123+example@users.noreply.github.com'
        );
        await git(workspace.directory, ['commit', '--allow-empty', '-m', 'Identity']);
        expect(
            await git(workspace.directory, ['log', '-1', '--format=%an <%ae>'])
        ).toBe('example <123+example@users.noreply.github.com>');
        const fetch = fixture.git.calls.find((call) => call.args[0] === 'fetch');
        expect(fetch?.args).toEqual([
            'fetch',
            '--depth=1',
            'https://github.com/example/project.git',
            fixture.binding.revision,
        ]);
        expect(fetch?.token).toBe('fixture-credential');
        expect(JSON.stringify(fetch?.args)).not.toContain('fixture-credential');
        expect(
            fixture.git.calls.some(
                (call) =>
                    call.args.join(' ') ===
                    'remote add origin https://github.com/example/project.git'
            )
        ).toBeTrue();
        expect((await lstat(workspace.directory)).mode & 0o777).toBe(0o700);
    });

    test('keeps agent Git state across remote resumptions without trusting it on the host', async () => {
        const fixture = await checkoutFixture();
        const workspace = new RepositoryWorkspace(
            fixture.home,
            fixture.binding,
            { GH_TOKEN: 'fixture-credential' },
            fixture.git,
            fixtureIdentity
        );
        await workspace.prepare('e2b');
        const runGit = (args: string[]) =>
            git(workspace.directory, [
                `--git-dir=${workspace.agentGitDirectory}`,
                `--work-tree=${workspace.directory}`,
                ...args,
            ]);
        await runGit(['checkout', '-b', 'feature']);
        await writeFile(join(workspace.directory, 'original.txt'), 'agent edit\n');
        await runGit(['add', 'original.txt']);
        const commit = await runGit([
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.com',
            'commit',
            '-m',
            'Agent edit',
        ]);
        expect(commit).toContain('Agent edit');
        await appendFile(
            join(workspace.directory, '.git/config'),
            '\n[core]\nfsmonitor = /hostile/command\n'
        );
        await workspace.prepare('e2b');
        expect(await runGit(['branch', '--show-current'])).toBe('feature');
        expect(await runGit(['status', '--short'])).toBe('');
        expect(
            await readFile(join(workspace.directory, '.git/config'), 'utf8')
        ).not.toContain('hostile');
    });

    test('preserves session edits but replaces potentially hostile Git metadata on resume', async () => {
        const fixture = await checkoutFixture();
        const workspace = new RepositoryWorkspace(
            fixture.home,
            fixture.binding,
            { GH_TOKEN: 'fixture-credential' },
            fixture.git,
            fixtureIdentity
        );
        await workspace.prepare();
        await writeFile(join(workspace.directory, 'original.txt'), 'retained edits');
        await appendFile(
            join(workspace.directory, '.git/config'),
            '\n[core]\nfsmonitor = /hostile/command\n[credential]\nhelper = /hostile/credential\n'
        );
        fixture.git.calls.length = 0;
        await workspace.prepare();
        expect(await readFile(join(workspace.directory, 'original.txt'), 'utf8')).toBe(
            'retained edits'
        );
        expect(
            await readFile(join(workspace.directory, '.git/config'), 'utf8')
        ).not.toContain('hostile');
        expect(
            fixture.git.calls.every((call) => call.directory !== workspace.directory)
        ).toBeTrue();
    });

    test('rejects mismatched provenance, missing retained checkout, and unsafe checkout links', async () => {
        const fixture = await checkoutFixture();
        const workspace = new RepositoryWorkspace(
            fixture.home,
            fixture.binding,
            { GH_TOKEN: 'fixture-credential' },
            fixture.git,
            fixtureIdentity
        );
        await workspace.prepare();
        const marker = join(
            fixture.home,
            'sessions',
            fixture.binding.session_id,
            'repository.json'
        );
        await writeFile(
            marker,
            JSON.stringify({ ...fixture.binding, revision: '0'.repeat(40) })
        );
        await expect(workspace.prepare()).rejects.toThrow('provenance');
        await writeFile(marker, JSON.stringify(fixture.binding));
        await rm(workspace.directory, { recursive: true });
        await expect(workspace.prepare()).rejects.toThrow('missing');
        await symlink(fixture.source, workspace.directory);
        await expect(workspace.prepare()).rejects.toThrow('not a directory');
        expect(await readFile(join(fixture.source, 'original.txt'), 'utf8')).toBe(
            'original\n'
        );
    });

    test('cleans incomplete staging and refuses an incorrect selected tree', async () => {
        const fixture = await checkoutFixture();
        const workspace = new RepositoryWorkspace(
            fixture.home,
            { ...fixture.binding, tree: '0'.repeat(40) },
            { GH_TOKEN: 'fixture-credential' },
            fixture.git,
            fixtureIdentity
        );
        await expect(workspace.prepare()).rejects.toThrow('selected GitHub commit');
        expect(
            await readdir(join(fixture.home, 'sessions', fixture.binding.session_id))
        ).toEqual([]);
        await mkdir(workspace.directory);
        await expect(workspace.prepare()).rejects.toThrow('provenance is missing');
    });
});
