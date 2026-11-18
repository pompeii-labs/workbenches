import { afterEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    HostCredentialFiles,
    RunnerCredentialStore,
} from '../../../src/connections/credentials.js';
import { NativeCredentialFile } from '../../../src/connections/nativecredentials.js';
import { readArchive } from '../staging/archive.js';
import {
    cleanTemporaryDirectories,
    daytonaProvider,
    FakeClient,
    fixture,
    request,
    track,
} from './fixture.js';

afterEach(cleanTemporaryDirectories);

for (const saved of [true, false]) {
    test(`Daytona uses shared remote credential staging ${saved ? 'with a saved key' : 'without stored credentials'}`, async () => {
        const home = track(
            await mkdtemp(join(tmpdir(), 'workbench-daytona-credentials-'))
        );
        const binding = await new RunnerCredentialStore(home).prepare(
            'daytona',
            'opencode'
        );
        const file = NativeCredentialFile.for('opencode');
        if (saved)
            await file.save(
                new HostCredentialFiles(binding.directory),
                'openrouter',
                file.apiKey('fixture-openrouter-key')
            );
        const client = new FakeClient();
        const base = request(await fixture());
        const runtime = await daytonaProvider({ client }).prepare({
            ...base,
            environment: {
                ...base.environment,
                OPENROUTER_API_KEY: 'fixture-inherited-key',
            },
            ...(saved ? { credentials: binding } : {}),
        });
        try {
            await runtime.preflight();
            if (saved)
                client.sandbox.nativeStateDownload = client.sandbox.uploads.get(
                    '/tmp/workbench-input-2.tar.gz'
                );
            expect(runtime.nativeAuthentication).toBe(
                saved ? 'persistent' : 'unavailable'
            );
            expect(runtime.environment.OPENROUTER_API_KEY).toBe(
                'fixture-inherited-key'
            );
            const archives = await Promise.all(
                [...client.sandbox.uploads.values()].map(readArchive)
            );
            const credentials = archives.find((archive) =>
                Object.keys(archive).some((path) => path.endsWith('opencode/auth.json'))
            );
            expect(Boolean(credentials)).toBe(saved);
            if (saved) {
                expect(JSON.stringify(credentials)).toContain('fixture-openrouter-key');
                expect(runtime.environment.XDG_DATA_HOME).toBe(
                    '/workbench-credentials'
                );
                expect(
                    client.sandbox.runs.some(
                        ({ command }) =>
                            command.includes("'/workbench-credentials'") &&
                            command.includes('tar')
                    )
                ).toBeTrue();
            } else {
                expect(runtime.environment.XDG_DATA_HOME).toBeUndefined();
                expect(runtime.credentials).toBeUndefined();
                expect(archives).toHaveLength(2);
            }
        } finally {
            await runtime.cleanup();
        }
        expect(client.deleted).toEqual(['sandbox-fixture']);
        expect(
            Boolean(
                await file.find(
                    new HostCredentialFiles(binding.directory),
                    'openrouter'
                )
            )
        ).toBe(saved);
    });
}
