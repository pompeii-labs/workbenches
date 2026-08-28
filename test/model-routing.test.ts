import { describe, expect, test } from 'bun:test';

import { type ModelCatalogData, ModelRouter } from '../src/models/index.js';
import type {
    ResolvedWorkbench,
    WorkbenchManifest,
    WorkbenchModelPolicy,
} from '../src/types.js';

const catalog: ModelCatalogData = {
    version: 'fixture',
    models: {
        'openai/gpt-fixture': {
            routes: {
                openai: 'gpt-fixture',
                'github-copilot': 'gpt-fixture',
                openrouter: 'openai/gpt-fixture',
            },
        },
    },
    providers: {
        openai: { env: ['OPENAI_API_KEY'] },
        'github-copilot': { env: [] },
        openrouter: {
            env: ['OPENROUTER_API_KEY'],
        },
    },
};

describe('locked model routing', () => {
    const router = new ModelRouter(catalog);

    test('infers first-party first and preserves provider-native model IDs', () => {
        expect(router.routes(workbench({ id: 'openai/gpt-fixture' }))).toEqual([
            {
                provider: 'openai',
                model: 'gpt-fixture',
                value: 'openai/gpt-fixture',
            },
            {
                provider: 'github-copilot',
                model: 'gpt-fixture',
                value: 'github-copilot/gpt-fixture',
            },
            {
                provider: 'openrouter',
                model: 'openai/gpt-fixture',
                value: 'openrouter/openai/gpt-fixture',
            },
        ]);
    });

    test('selects the first authenticated route while retaining its native identity', () => {
        const fixture = workbench({ id: 'openai/gpt-fixture' });
        const configuration = router.resolve({
            workbench: fixture,
            authenticatedRoutes: [
                {
                    provider: 'openrouter',
                    nativeProvider: 'openrouter',
                    nativeModel: 'openai/gpt-fixture',
                },
                {
                    provider: 'openai',
                    nativeProvider: 'openai-codex',
                    nativeModel: 'gpt-fixture',
                },
            ],
            requireAuthentication: true,
        });

        expect(configuration).toMatchObject({
            canonicalModel: 'openai/gpt-fixture',
            provider: 'openai',
            nativeProvider: 'openai-codex',
            nativeModel: 'gpt-fixture',
            model: 'openai-codex/gpt-fixture',
        });
    });

    test('honors an exact native connection preference without changing the model', () => {
        const fixture = workbench({ id: 'openai/gpt-fixture' });
        const configuration = router.resolve({
            workbench: fixture,
            authenticatedRoutes: [
                {
                    provider: 'openai',
                    nativeProvider: 'openai',
                    nativeModel: 'gpt-fixture',
                },
                {
                    provider: 'openai',
                    nativeProvider: 'openai-codex',
                    nativeModel: 'gpt-fixture',
                },
            ],
            preferredConnection: {
                provider: 'openai',
                nativeProvider: 'openai-codex',
            },
            requireAuthentication: true,
        });

        expect(configuration).toMatchObject({
            canonicalModel: 'openai/gpt-fixture',
            provider: 'openai',
            nativeProvider: 'openai-codex',
            nativeModel: 'gpt-fixture',
        });
    });

    test('requires packaged configuration and native IDs for unknown models', () => {
        const fixture = workbench({
            id: 'private/model',
            routes: [{ provider: 'private', model: 'deployment-42' }],
        });
        expect(() => router.routes(fixture)).toThrow('packaged runner_config');
        fixture.runnerConfigPath = '/package/runner';
        expect(router.routes(fixture)).toEqual([
            {
                provider: 'private',
                model: 'deployment-42',
                value: 'private/deployment-42',
            },
        ]);
    });

    test('passes only the selected provider credentials plus declared environment', () => {
        const fixture = workbench({ id: 'openai/gpt-fixture' });
        fixture.manifest.env = { SHARED_TOKEN: { required: false } };
        const configuration = router.resolve({
            workbench: fixture,
            authenticatedProviders: ['openrouter'],
            requireAuthentication: true,
        });
        expect(
            router.environmentForRoute(fixture, configuration, {
                OPENAI_API_KEY: 'not-selected',
                OPENROUTER_API_KEY: 'selected',
                SHARED_TOKEN: 'declared',
                PATH: '/bin',
            })
        ).toEqual({
            OPENROUTER_API_KEY: 'selected',
            SHARED_TOKEN: 'declared',
            PATH: '/bin',
        });
    });
});

function workbench(model: WorkbenchModelPolicy): ResolvedWorkbench {
    const common = {
        version: '0.1.0',
        name: 'fixture',
        runner: 'opencode',
        instructions: './instructions.md',
        skills: [],
        tools: [],
        mcps: [],
        env: {},
        runtime: 'local',
    };
    const manifest: WorkbenchManifest = { ...common, spec: 0, model };
    return {
        manifestPath: '/repo/.workbenches/core/workbench.yml',
        packageDirectory: '/repo/.workbenches/core',
        repositoryDirectory: '/repo',
        instructionsPath: '/repo/.workbenches/core/instructions.md',
        skills: [],
        manifest,
    };
}
