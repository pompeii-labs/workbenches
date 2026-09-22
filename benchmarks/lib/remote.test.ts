import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    rememberRemote,
    remoteArguments,
    savedRemote,
    sshCommand,
    validateRemote,
} from './remote.ts';

const roots: string[] = [];
afterEach(() => {
    for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
const target = { ssh: 'build-host', directory: '/tmp/a space' };
test('campaign target persists locally without secrets and cannot silently change', () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-remote-'));
    roots.push(root);
    rememberRemote(root, 'pair', target);
    expect(savedRemote(root, 'pair')).toEqual(target);
    rememberRemote(root, 'pair', target);
    expect(() => rememberRemote(root, 'pair', { ...target, ssh: 'other' })).toThrow();
    expect(readFileSync(join(root, 'pair/remote.json'), 'utf8')).not.toContain(
        'OPENROUTER'
    );
    expect(() => savedRemote(root, '../outside')).toThrow();
});
test('local routing arguments are stripped without changing run selection', () => {
    expect(
        remoteArguments([
            'run',
            '--ssh',
            'build-host',
            '--remote-dir=/tmp/b',
            '--results-dir',
            '/local',
            '--campaign',
            'pair',
            '--tasks',
            'usage',
            '--reps',
            '1',
        ])
    ).toEqual(['run', '--campaign', 'pair', '--tasks', 'usage', '--reps', '1']);
});
test('SSH validates aliases, quotes host paths and arguments, and never embeds credentials', () => {
    expect(() => validateRemote({ ...target, ssh: '-oProxyCommand=bad' })).toThrow();
    expect(() => validateRemote({ ...target, directory: 'relative' })).toThrow();
    const args = sshCommand(target, ['monitor', '--campaign', 'pair'], false);
    expect(args.at(-1)).toContain("cd '/tmp/a space' || exit 1;");
    expect(args.at(-1)).not.toContain('OPENROUTER');
    expect(args.at(-1)).toContain('command -v bun');
    expect(args.at(-1)).toContain('$HOME/.bun/bin/bun');
    expect(args.at(-1)).toContain('Bun is not installed');
    expect(sshCommand(target, ['run'], true).at(-1)).toContain(
        'read -r OPENROUTER_API_KEY'
    );
    expect(
        sshCommand({ ...target, directory: "/tmp/x';echo bad" }, ['monitor'], false).at(
            -1
        )
    ).toContain("'/tmp/x'\\'';echo bad'");
});
test('saved campaigns ignore obsolete Bun overrides without breaking target matching', () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-remote-'));
    roots.push(root);
    rememberRemote(root, 'pair', target);
    writeFileSync(
        join(root, 'pair/remote.json'),
        JSON.stringify({ ...target, bun: '/obsolete/bun' })
    );
    expect(savedRemote(root, 'pair')).toEqual(target);
    expect(() => rememberRemote(root, 'pair', target)).not.toThrow();
    expect(
        sshCommand(savedRemote(root, 'pair')!, ['monitor'], false).join(' ')
    ).not.toContain('/obsolete/bun');
});
