import { afterEach, describe, expect, test } from 'bun:test';

import { ActiveModelCatalog, ModelRouter } from '../../src/models/index.js';
import type { ModelCatalogSnapshot } from '../../src/models/snapshot.js';

const snapshot: ModelCatalogSnapshot = {
    version: 'embedding-fixture',
    models: {
        'openai/gpt-fixture': {
            routes: {
                openai: 'gpt-fixture',
                openrouter: 'openai/gpt-fixture',
            },
        },
    },
    providers: {
        openai: { env: ['OPENAI_API_KEY'] },
        openrouter: { env: ['OPENROUTER_API_KEY'] },
    },
};

const model = { id: 'openai/gpt-fixture' };

describe('routing without process-global state', () => {
    // The active snapshot is process-wide, and other tests read the fixture the
    // preload activated. Put it back.
    const previous = ActiveModelCatalog.active();
    afterEach(() => {
        if (previous) ActiveModelCatalog.activate(previous);
    });

    test('routes against an explicit snapshot', () => {
        const router = new ModelRouter(snapshot);
        expect(router.catalog.version).toBe('embedding-fixture');
    });

    test('activating a snapshot makes it the one the CLI reads', () => {
        ActiveModelCatalog.activate(snapshot);
        expect(new ModelRouter(ActiveModelCatalog.current()).catalog.version).toBe(
            'embedding-fixture'
        );
        expect(ActiveModelCatalog.current().providers.openrouter?.env).toEqual([
            'OPENROUTER_API_KEY',
        ]);
    });

    test('builds the configuration for a chosen route from names alone', () => {
        const configuration = new ModelRouter(snapshot).configureOpenCode({
            model,
            provider: 'openrouter',
            environmentNames: ['OPENROUTER_API_KEY'],
        });
        expect(configuration).toMatchObject({
            runner: 'opencode',
            canonicalModel: 'openai/gpt-fixture',
            model: 'openrouter/openai/gpt-fixture',
            provider: 'openrouter',
            nativeProvider: 'openrouter',
            nativeModel: 'openai/gpt-fixture',
            catalogVersion: 'embedding-fixture',
        });
    });

    test('picks the first route whose credentials are named', () => {
        const router = new ModelRouter(snapshot);
        expect(
            router.configureOpenCode({
                model,
                environmentNames: ['OPENROUTER_API_KEY'],
            }).provider
        ).toBe('openrouter');
        expect(
            router.configureOpenCode({
                model,
                environmentNames: ['OPENAI_API_KEY', 'OPENROUTER_API_KEY'],
            }).provider
        ).toBe('openai');
    });

    test('refuses a route whose credentials are not named', () => {
        const router = new ModelRouter(snapshot);
        expect(() =>
            router.configureOpenCode({
                model,
                provider: 'openrouter',
                environmentNames: ['OPENAI_API_KEY'],
            })
        ).toThrow('needs one of these environment variables: OPENROUTER_API_KEY');
        expect(() => router.configureOpenCode({ model, environmentNames: [] })).toThrow(
            'has credentials'
        );
        expect(() =>
            router.configureOpenCode({
                model,
                provider: 'anthropic',
                environmentNames: ['OPENAI_API_KEY'],
            })
        ).toThrow('has no route through anthropic');
    });
});
