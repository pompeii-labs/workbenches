import { afterEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import { prepareConnectionSetupWorkbench } from '../src/connections/setup-workbench.js';
import {
    connectionAuthenticationMethods,
    connectionHarnesses,
    connectionProviders,
    connectionRuntimes,
} from '../src/connections/targets.js';
import { modelCatalogFixture } from './model-catalog-fixture.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('runner connection targets', () => {
    test('enumerates engine runtimes and harnesses independently of saved Workbenches', () => {
        expect(connectionRuntimes).toEqual(['local', 'docker', 'e2b']);
        expect(connectionHarnesses).toEqual(['opencode', 'pi']);
        expect(connectionProviders(modelCatalogFixture).map(({ id }) => id)).toEqual([
            'openai',
            'anthropic',
            'openrouter',
            'github-copilot',
            'opencode',
        ]);
    });

    test('makes OpenAI authentication explicit for each runtime and harness', () => {
        expect(
            connectionAuthenticationMethods('local', 'opencode', 'openai')
        ).toMatchObject([
            {
                id: 'chatgpt',
                nativeProvider: 'openai',
                nativeMethod: 'ChatGPT Pro/Plus (browser)',
                authenticationMethod: 'oauth',
            },
            {
                id: 'api-key',
                nativeProvider: 'openai',
                nativeMethod: 'Manually enter API Key',
                authenticationMethod: 'api',
            },
        ]);
        expect(
            connectionAuthenticationMethods('e2b', 'opencode', 'openai')[0]
        ).toMatchObject({
            id: 'chatgpt',
            nativeMethod: 'ChatGPT Pro/Plus (headless)',
        });
        expect(connectionAuthenticationMethods('docker', 'pi', 'openai')).toMatchObject(
            [
                {
                    id: 'chatgpt',
                    nativeProvider: 'openai-codex',
                    authenticationMethod: 'oauth',
                },
                {
                    id: 'api-key',
                    nativeProvider: 'openai',
                    authenticationMethod: 'api',
                },
            ]
        );
    });

    test('builds an isolated engine-owned setup package and empty workspace', async () => {
        const [method] = connectionAuthenticationMethods('local', 'opencode', 'openai');
        if (!method) throw new Error('missing OpenCode authentication method');
        const prepared = await prepareConnectionSetupWorkbench({
            runtime: 'local',
            harness: 'opencode',
            provider: 'openai',
            method,
        });
        cleanups.push(prepared.cleanup);

        expect(prepared.workbench.manifest).toMatchObject({
            name: 'workbench-connection-setup',
            runner: 'opencode',
            runtime: 'local',
            model: {
                routes: [{ provider: 'openai', model: 'gpt-5.4-mini' }],
            },
        });
        expect(await readFile(prepared.workbench.instructionsPath, 'utf8')).toContain(
            'internal package'
        );
        expect(prepared.workspaceDirectory).not.toBe(process.cwd());
    });
});
