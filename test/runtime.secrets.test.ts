import { afterEach, describe, expect, test } from 'bun:test';
import {
    chmod,
    mkdtemp,
    readFile,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { E2BManagedSandboxes } from '../src/runtimes/e2b/managed.js';
import { RuntimeSecretStore } from '../src/runtimes/secrets.js';

const homes: string[] = [];
const cli = resolve(import.meta.dir, '../src/cli.ts');

afterEach(async () => {
    await Promise.all(
        homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
    );
});

describe('E2B runtime connection', () => {
    test('saves a private host-only key through wb connect without printing it', async () => {
        const home = await temporaryHome();
        const key = 'fixture-e2b-key';
        const saved = await command(
            home,
            ['connect', '--runtime', 'e2b', '--stdin'],
            key
        );
        expect(saved.code).toBe(0);
        expect(saved.stdout).toContain('E2B runtime key saved');
        expect(`${saved.stdout}${saved.stderr}`).not.toContain(key);
        expect((await stat(join(home, 'runtime.secrets.json'))).mode & 0o777).toBe(
            0o600
        );
        expect(new RuntimeSecretStore(home).key('e2b')).toBe(key);
        expect(
            E2BManagedSandboxes.connect('a'.repeat(24), { WORKBENCH_HOME: home })
        ).toBeDefined();

        const status = await command(home, ['connect', '--runtime', 'e2b', '--status']);
        expect(status.code).toBe(0);
        expect(status.stdout).toContain('E2B runtime key is saved');
        expect(status.stdout).not.toContain(key);

        const removed = await command(home, [
            'connect',
            '--runtime',
            'e2b',
            '--remove',
        ]);
        expect(removed.code).toBe(0);
        expect(new RuntimeSecretStore(home).key('e2b')).toBeUndefined();
    });

    test('lets an environment key override the saved runtime key', async () => {
        const home = await temporaryHome();
        new RuntimeSecretStore(home).save('e2b', 'saved-key');
        expect(RuntimeSecretStore.key('e2b', { WORKBENCH_HOME: home })).toBe(
            'saved-key'
        );
        expect(
            RuntimeSecretStore.key('e2b', {
                WORKBENCH_HOME: home,
                E2B_API_KEY: 'override-key',
            })
        ).toBe('override-key');
    });

    test('rejects exposed, linked, or malformed secret stores without echoing contents', async () => {
        const home = await temporaryHome();
        const store = new RuntimeSecretStore(home);
        store.save('e2b', 'private-key');
        const file = join(home, 'runtime.secrets.json');
        await chmod(file, 0o644);
        expect(() => store.key('e2b')).toThrow('not private');
        await chmod(file, 0o600);
        await writeFile(file, '{"api_key":"private-key",', { mode: 0o600 });
        expect(() => store.key('e2b')).toThrow('secret store is invalid');
        try {
            store.key('e2b');
        } catch (error) {
            expect(String(error)).not.toContain('private-key');
        }
        const target = join(home, 'target.json');
        await writeFile(target, '{"version":1}', { mode: 0o600 });
        await rm(file);
        await symlink(target, file);
        expect(() => store.key('e2b')).toThrow('Cannot read');
        expect(await readFile(target, 'utf8')).toContain('version');
    });

    test('does not accept key material as a command-line argument', async () => {
        const home = await temporaryHome();
        const result = await command(home, ['connect', '--runtime', 'e2b']);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('or pass --stdin');
        expect(new RuntimeSecretStore(home).key('e2b')).toBeUndefined();
    });
});

describe('Daytona runtime connection', () => {
    test('saves a private host-only key through wb connect without printing it', async () => {
        const home = await temporaryHome();
        const key = 'fixture-daytona-key';
        const saved = await command(
            home,
            ['connect', '--runtime', 'daytona', '--stdin'],
            key
        );
        expect(saved.code).toBe(0);
        expect(saved.stdout).toContain('Daytona runtime key saved');
        expect(`${saved.stdout}${saved.stderr}`).not.toContain(key);
        expect((await stat(join(home, 'runtime.secrets.json'))).mode & 0o777).toBe(
            0o600
        );
        expect(new RuntimeSecretStore(home).key('daytona')).toBe(key);
        expect(new RuntimeSecretStore(home).key('e2b')).toBeUndefined();

        const status = await command(home, [
            'connect',
            '--runtime',
            'daytona',
            '--status',
        ]);
        expect(status.code).toBe(0);
        expect(status.stdout).toContain('Daytona runtime key is saved');
        expect(status.stdout).not.toContain(key);

        const removed = await command(home, [
            'connect',
            '--runtime',
            'daytona',
            '--remove',
        ]);
        expect(removed.code).toBe(0);
        expect(new RuntimeSecretStore(home).key('daytona')).toBeUndefined();
    });

    test('keeps the E2B and Daytona keys independent', async () => {
        const home = await temporaryHome();
        const store = new RuntimeSecretStore(home);
        store.save('e2b', 'e2b-key');
        store.save('daytona', 'daytona-key');
        expect(store.key('e2b')).toBe('e2b-key');
        expect(store.key('daytona')).toBe('daytona-key');
        store.remove('daytona');
        expect(store.key('e2b')).toBe('e2b-key');
        expect(store.key('daytona')).toBeUndefined();
        store.save('daytona', 'daytona-key');
        store.remove('e2b');
        expect(store.key('e2b')).toBeUndefined();
        expect(store.key('daytona')).toBe('daytona-key');
    });

    test('lets an environment key override the saved runtime key', async () => {
        const home = await temporaryHome();
        new RuntimeSecretStore(home).save('daytona', 'saved-key');
        expect(RuntimeSecretStore.key('daytona', { WORKBENCH_HOME: home })).toBe(
            'saved-key'
        );
        expect(
            RuntimeSecretStore.key('daytona', {
                WORKBENCH_HOME: home,
                DAYTONA_API_KEY: 'override-key',
            })
        ).toBe('override-key');
    });

    test('does not accept key material as a command-line argument', async () => {
        const home = await temporaryHome();
        const result = await command(home, ['connect', '--runtime', 'daytona']);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('or pass --stdin');
        expect(new RuntimeSecretStore(home).key('daytona')).toBeUndefined();
    });

    test('rejects a store whose Daytona entry holds no key', async () => {
        const home = await temporaryHome();
        await writeFile(
            join(home, 'runtime.secrets.json'),
            '{"version":1,"daytona":{"api_key":""}}',
            { mode: 0o600 }
        );
        expect(() => new RuntimeSecretStore(home).key('daytona')).toThrow(
            'secret store is invalid'
        );
    });
});

async function temporaryHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'workbench-runtime-key-'));
    homes.push(home);
    return home;
}

async function command(
    home: string,
    args: string[],
    input?: string
): Promise<{ code: number; stdout: string; stderr: string }> {
    const child = Bun.spawn([process.execPath, cli, ...args], {
        cwd: resolve(import.meta.dir, '..'),
        env: {
            ...process.env,
            WORKBENCH_HOME: home,
            E2B_API_KEY: '',
            DAYTONA_API_KEY: '',
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
    });
    child.stdin.write(input ?? '');
    child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
}
