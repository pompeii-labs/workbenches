import { describe, expect, test } from 'bun:test';
import {
    connectionAuthenticationMethods,
    connectionHarnesses,
    connectionProviderCapabilities,
    connectionProviders,
    connectionRuntimes,
} from '../src/connections/targets.js';
import { piRouteCandidates } from '../src/runners/pi/providers.js';
import { modelCatalogFixture } from './model-catalog-fixture.js';

describe('runner connection targets', () => {
    test('enumerates engine runtimes and harnesses independently of saved Workbenches', () => {
        expect(connectionRuntimes).toEqual(['local', 'docker', 'e2b']);
        expect(connectionHarnesses).toEqual(['opencode', 'pi']);
        expect(
            connectionProviders('pi', modelCatalogFixture).map(({ id }) => id)
        ).toEqual(['openai', 'anthropic', 'openrouter', 'github-copilot', 'opencode']);
    });

    test('intersects model providers with the selected harness capability map', () => {
        const catalog = structuredClone(modelCatalogFixture);
        catalog.providers['wafer.ai'] = { env: ['WAFER_API_KEY'] };
        const model = catalog.models['openai/gpt-5.6-terra'];
        if (!model) throw new Error('missing model fixture');
        model.routes['wafer.ai'] = 'gpt-5.6-terra';

        expect(
            connectionProviders('opencode', catalog).some(
                (provider) => provider.id === 'wafer.ai'
            )
        ).toBeTrue();
        expect(
            connectionProviders('pi', catalog).some(
                (provider) => provider.id === 'wafer.ai'
            )
        ).toBeFalse();
    });

    test('uses versioned metadata for Pi native provider aliases', () => {
        const catalog = structuredClone(modelCatalogFixture);
        const capabilities = catalog.harnesses?.pi?.versions['0.84.3'];
        if (!capabilities) throw new Error('missing Pi capability fixture');
        capabilities.providers['fireworks-ai'] = [
            { native_provider: 'fireworks', auth: ['api'] },
        ];

        expect(connectionProviderCapabilities('pi', catalog)['fireworks-ai']).toEqual([
            { native_provider: 'fireworks', auth: ['api'] },
        ]);
        expect(
            piRouteCandidates(
                {
                    provider: 'fireworks-ai',
                    model: 'accounts/fireworks/model-1',
                    value: 'fireworks-ai/accounts/fireworks/model-1',
                },
                connectionProviderCapabilities('pi', catalog)
            )
        ).toEqual([
            {
                provider: 'fireworks-ai',
                nativeProvider: 'fireworks',
                nativeModel: 'accounts/fireworks/model-1',
                authenticationMethod: 'api',
            },
        ]);
        expect(
            connectionAuthenticationMethods('docker', 'pi', 'fireworks-ai', catalog)
        ).toEqual([
            {
                id: 'api-key',
                label: 'Fireworks Ai credentials',
                nativeProvider: 'fireworks',
                authenticationMethod: 'api',
            },
        ]);
    });

    test('makes OpenAI authentication explicit for each runtime and harness', () => {
        expect(
            connectionAuthenticationMethods(
                'local',
                'opencode',
                'openai',
                modelCatalogFixture
            )
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
            connectionAuthenticationMethods(
                'e2b',
                'opencode',
                'openai',
                modelCatalogFixture
            )[0]
        ).toMatchObject({
            id: 'chatgpt',
            nativeMethod: 'ChatGPT Pro/Plus (headless)',
        });
        expect(
            connectionAuthenticationMethods(
                'docker',
                'pi',
                'openai',
                modelCatalogFixture
            )
        ).toMatchObject([
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
        ]);
    });
});
