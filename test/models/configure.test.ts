import { expect, test } from 'bun:test';
import { ModelRouter } from '../../src/models/index.js';
import { claudeCodeConnection } from '../../src/runners/claude-code/connection.js';
import { openCodeConnection } from '../../src/runners/opencode/connection.js';
import { piConnection } from '../../src/runners/pi/connection.js';
import { modelCatalogFixture } from '../model-catalog-fixture.js';

for (const [name, connection] of [
    ['claude-code', claudeCodeConnection],
    ['pi', piConnection],
] as const) {
    test(`${name} configures OpenRouter through the same native route as local preparation`, () => {
        const router = new ModelRouter(modelCatalogFixture);
        const model = {
            id: 'anthropic/claude-sonnet-4-5',
            routes: [{ provider: 'openrouter' }],
        };
        const workbench = { manifest: { name: 'core', runner: name, model, env: {} } };
        const route = router.routes(workbench)[0];
        if (!route) throw new Error('Expected route');
        const candidates = connection.candidates(route, modelCatalogFixture);
        const expected = router.resolve({
            workbench,
            authenticatedRoutes: candidates,
            requireAuthentication: true,
        });
        expect(
            router.configure({
                runner: { name, connection },
                model,
                name: 'core',
                provider: 'openrouter',
                environmentNames: ['OPENROUTER_API_KEY'],
            })
        ).toEqual(expected);
    });
}

test('OpenCode reaches a provider under its own name, and Pi through its native alias', () => {
    const router = new ModelRouter(modelCatalogFixture);
    expect(
        router.configure({
            runner: { name: 'opencode', connection: openCodeConnection },
            model: {
                id: 'anthropic/claude-sonnet-4-5',
                routes: [{ provider: 'openrouter' }],
            },
            environmentNames: ['OPENROUTER_API_KEY'],
        })
    ).toMatchObject({
        runner: 'opencode',
        nativeProvider: 'openrouter',
        nativeModel: 'anthropic/claude-sonnet-4.5',
    });
    const fallback = new ModelRouter({ ...modelCatalogFixture, harnesses: {} });
    expect(
        fallback.configure({
            runner: { name: 'pi', connection: piConnection },
            model: {
                id: 'custom/model',
                routes: [{ provider: 'vercel', model: 'model' }],
            },
            runnerConfigPath: '/config',
            environmentNames: modelCatalogFixture.providers.vercel?.env ?? [],
        }).nativeProvider
    ).toBe('vercel-ai-gateway');
});
