import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ModelCatalog, type ModelCatalogSnapshot } from '../src/models/catalog.js';

export const modelCatalogFixture: ModelCatalogSnapshot = {
    version: 'test-fixture',
    models: {
        'anthropic/claude-sonnet-4-5': {
            routes: {
                anthropic: 'claude-sonnet-4-5',
                openrouter: 'anthropic/claude-sonnet-4-5',
            },
        },
        'openai/gpt-5.4-mini': {
            routes: {
                openai: 'gpt-5.4-mini',
                openrouter: 'openai/gpt-5.4-mini',
            },
        },
        'openai/gpt-5.6-terra': {
            routes: {
                openai: 'gpt-5.6-terra',
                'github-copilot': 'gpt-5.6-terra',
                opencode: 'gpt-5.6-terra',
                openrouter: 'openai/gpt-5.6-terra',
            },
        },
    },
    providers: {
        anthropic: { env: ['ANTHROPIC_API_KEY'] },
        'github-copilot': { env: [] },
        opencode: { env: [] },
        openai: { env: ['OPENAI_API_KEY'] },
        openrouter: { env: ['OPENROUTER_API_KEY'] },
    },
};

export function activateModelCatalogFixture(): void {
    ModelCatalog.activate(modelCatalogFixture);
}

export async function seedModelCatalogFixture(
    home: string,
    checkedAt = Date.now()
): Promise<void> {
    const source = new TextEncoder().encode(
        `${JSON.stringify(modelCatalogFixture, null, 4)}\n`
    );
    const sha256 = createHash('sha256').update(source).digest('hex');
    const artifact = `models/v1/${sha256}.json`;
    const manifest = {
        schema: 1,
        catalog: 'models',
        version: modelCatalogFixture.version,
        artifact,
        sha256,
        size: source.byteLength,
    };
    const root = join(home, 'metadata');
    await mkdir(join(root, 'models', 'v1'), { recursive: true });
    await Promise.all([
        writeFile(join(root, artifact), source),
        writeFile(
            join(root, 'models', 'v1', 'latest.json'),
            `${JSON.stringify(manifest)}\n`
        ),
        writeFile(
            join(root, 'models', 'state.json'),
            `${JSON.stringify({ checkedAt, sha256 })}\n`
        ),
    ]);
}
