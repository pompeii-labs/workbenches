import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type KeychainCommand, MemberKeychain } from '../../src/workers/keychain.js';

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true }))
    );
});

async function member(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'wb-keychain-'));
    directories.push(directory);
    return directory;
}

/** Records each `security -i` call, and makes the keychain file `create-keychain` names. */
function recorder(result = { code: 0, stderr: '' }) {
    const calls: Array<{ home: string; input: string }> = [];
    const command: KeychainCommand = async (home, input) => {
        calls.push({ home, input });
        const created = input.match(/^create-keychain -p \S+ "(.+)"$/m)?.[1];
        if (created && result.code === 0) await writeFile(created, '');
        return result;
    };
    return { calls, command };
}

describe('a member keychain', () => {
    test('is created once with a password kept owner-only beside it, then unlocked', async () => {
        const directory = await member();
        const { calls, command } = recorder();
        const keychain = new MemberKeychain(command, 'darwin');

        await keychain.unlock(directory);
        await keychain.unlock(directory);

        const keychains = join(directory, 'Library', 'Keychains');
        const password = await readFile(join(keychains, 'workbench-password'), 'utf8');
        expect(password).toMatch(/^[0-9a-f]{48}$/);
        expect((await stat(join(keychains, 'workbench-password'))).mode & 0o777).toBe(
            0o600
        );
        expect((await stat(join(keychains, 'login.keychain-db'))).mode & 0o777).toBe(
            0o600
        );
        const path = join(keychains, 'login.keychain-db');
        const unlock = `unlock-keychain -p ${password} "${path}"\n`;
        expect(calls).toEqual([
            {
                home: directory,
                input: `create-keychain -p ${password} "${path}"\nset-keychain-settings "${path}"\n`,
            },
            { home: directory, input: unlock },
            { home: directory, input: unlock },
        ]);
    });

    test('does nothing outside macOS', async () => {
        const directory = await member();
        const { calls, command } = recorder();

        await new MemberKeychain(command, 'linux').unlock(directory);

        expect(calls).toEqual([]);
        expect(await readdir(directory)).toEqual([]);
    });

    test('fails with what security reported', async () => {
        const directory = await member();
        const { command } = recorder({
            code: 50,
            stderr: 'security: SecKeychainCreate: A keychain with the same name already exists.\n',
        });

        await expect(
            new MemberKeychain(command, 'darwin').unlock(directory)
        ).rejects.toThrow(
            'The member keychain could not be created: security: SecKeychainCreate: A keychain with the same name already exists.'
        );
    });

    test('says how to recover a keychain whose password is gone', async () => {
        const directory = await member();
        const { command } = recorder();
        const keychain = new MemberKeychain(command, 'darwin');
        await keychain.unlock(directory);
        const keychains = join(directory, 'Library', 'Keychains');
        await rm(join(keychains, 'workbench-password'));

        await expect(keychain.unlock(directory)).rejects.toThrow(
            `The keychain of member directory ${directory} has no password file. Remove ${keychains} and connect again.`
        );
    });
});
