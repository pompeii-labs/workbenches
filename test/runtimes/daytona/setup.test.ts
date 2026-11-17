import { afterEach, describe, expect, test } from 'bun:test';

import { SandboxTools } from '../../../src/runtimes/sandboxtools.js';
import {
    cleanTemporaryDirectories,
    daytonaProvider,
    FakeClient,
    fixture,
    request,
    result,
} from './fixture.js';

afterEach(cleanTemporaryDirectories);

const repository = {
    name: 'example/project',
    revision: 'main',
    delivery: 'pr' as const,
};

describe('SandboxSetup', () => {
    test('skips the install when git and gh are already present', async () => {
        const client = new FakeClient();
        const runtime = await daytonaProvider({ client }).prepare({
            ...request(await fixture()),
            repository,
        });
        try {
            await runtime.preflight();
            const probe = client.sandbox.runs.find(
                (call) => call.command === new SandboxTools(true).probeCommand()
            );
            expect(probe?.options.user).toBeUndefined();
            expect(
                client.sandbox.runs.some(
                    (call) => call.command === new SandboxTools(true).installCommand()
                )
            ).toBeFalse();
        } finally {
            await runtime.cleanup();
        }
    });

    test("looks for the runner contract's executable, not the runner name", async () => {
        const client = new FakeClient();
        const runner = { executable: 'fixture-cli', standardInput: false };
        const runtime = await daytonaProvider({ client }).prepare({
            ...request(await fixture()),
            runner,
        });
        try {
            expect((await runtime.preflight()).runner).toEqual({
                name: 'opencode',
                path: '/usr/bin/fixture-cli',
            });
        } finally {
            await runtime.cleanup();
        }
        const absent = new FakeClient();
        absent.sandbox.missingCommands.add('fixture-cli');
        const missing = await daytonaProvider({ client: absent }).prepare({
            ...request(await fixture()),
            runner,
        });
        try {
            await expect(missing.preflight()).rejects.toThrow(
                /Runner CLI is unavailable in Daytona image .*: fixture-cli/
            );
        } finally {
            await missing.cleanup();
        }
    });

    test('names the missing tool when root access is unavailable', async () => {
        const client = new FakeClient();
        client.sandbox.missingCommands.add('gh');
        client.sandbox.installResult = result(1, 'root access is required\n');
        const runtime = await daytonaProvider({ client }).prepare({
            ...request(await fixture()),
            repository,
        });
        try {
            const error = await runtime.preflight().catch((value) => value);
            expect(error.name).toBe('RuntimeError');
            expect(error.message).toMatch(
                /missing gh.*must ship git and gh or allow root/
            );
        } finally {
            await runtime.cleanup();
        }
    });

    test('installs engine-managed Git tools as root for repository runs', async () => {
        const client = new FakeClient();
        client.sandbox.missingCommands.add('git');
        const runtime = await daytonaProvider({ client }).prepare({
            ...request(await fixture()),
            repository,
        });
        try {
            await runtime.preflight();
            const install = client.sandbox.runs.find(
                (call) => call.command === new SandboxTools(true).installCommand()
            );
            expect(install?.options.user).toBe('root');
        } finally {
            await runtime.cleanup();
        }
    });

    test('installs only git as root when an ordinary run uses an image without it', async () => {
        const client = new FakeClient();
        client.sandbox.missingCommands.add('git');
        client.sandbox.missingCommands.add('gh');
        const runtime = await daytonaProvider({ client }).prepare(
            request(await fixture())
        );
        try {
            await runtime.preflight();
            const install = client.sandbox.runs.find(
                (call) => call.command === new SandboxTools(false).installCommand()
            );
            expect(install?.options.user).toBe('root');
            expect(new SandboxTools(false).installCommand()).not.toContain('gh');
            expect(
                client.sandbox.runs.some(
                    (call) => call.command === new SandboxTools(true).installCommand()
                )
            ).toBeFalse();
        } finally {
            await runtime.cleanup();
        }
    });

    test('an ordinary run on an image with git installs nothing', async () => {
        const client = new FakeClient();
        client.sandbox.missingCommands.add('gh');
        const runtime = await daytonaProvider({ client }).prepare(
            request(await fixture())
        );
        try {
            await runtime.preflight();
            expect(
                client.sandbox.runs.some(
                    (call) =>
                        call.command === new SandboxTools(false).installCommand() ||
                        call.command === new SandboxTools(true).installCommand()
                )
            ).toBeFalse();
        } finally {
            await runtime.cleanup();
        }
    });

    test('names git when an ordinary run cannot install it without root', async () => {
        const client = new FakeClient();
        client.sandbox.missingCommands.add('git');
        client.sandbox.installResult = result(1, 'root access is required\n');
        const runtime = await daytonaProvider({ client }).prepare(
            request(await fixture())
        );
        try {
            const error = await runtime.preflight().catch((value) => value);
            expect(error.message).toMatch(/missing git.*must ship git or allow root/);
        } finally {
            await runtime.cleanup();
        }
    });
});
